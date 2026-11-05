// Automation run-as (ADR 0051, ADR 0170). An automation declares the connections it needs
// (`connections: [{ id, gatekeeper, purpose }]`); a person binds each declared slot to a connection
// they own, or (an admin) to an org connection. The core_automation_binding row is that consent:
// who allowed it and when, kept after it is revoked. Steps reach a bound connection as its owner.
//
// Until every declared slot has a live binding the automation does not run: a new automation with
// connections is installed paused ("Waiting for connections"), dispatch drops candidates with an
// unbound slot, and binding the last slot lifts that pause. When a bound connection is
// disconnected or expires, or its owner is deactivated, the bindings on it are revoked, the
// automations using it pause and the admins get one `automation.paused` notice each.
import type { CoreDatabase, CrmDb } from "@relationship-os/db";
import type { AutomationConnection, AutomationManifest } from "@relationship-os/sdk";
import { type Compilable, type Kysely, sql } from "kysely";
import { catalogueEntry } from "../integrations/catalogue.ts";
import { notifyStatements } from "../notifications/send.ts";
import { jsonList } from "../records/common.ts";

/** The pause reason of an automation whose declared connections are not all bound. */
export const WAITING_FOR_CONNECTIONS = "Waiting for connections";

/** Pause reasons set by revocation start with this, so the UI can say what to do. */
export const CONNECTION_REVOKED_PREFIX = "Connection revoked";

export interface AutomationBinding {
  automationId: string;
  slot: string;
  gatekeeper: string;
  purpose: string;
  connectionId: string;
  boundBy: string;
  boundAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
}

type BindingRow = CoreDatabase["core_automation_binding"];

function toBinding(row: BindingRow): AutomationBinding {
  return {
    automationId: row.automation_id,
    slot: row.slot,
    gatekeeper: row.gatekeeper,
    purpose: row.purpose,
    connectionId: row.connection_id,
    boundBy: row.bound_by,
    boundAt: row.bound_at,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
    revokeReason: row.revoke_reason,
  };
}

/** The connections an automation declares (none for most). */
export function declaredConnections(spec: AutomationManifest): readonly AutomationConnection[] {
  return spec.connections ?? [];
}

/**
 * Can a connection of `vendor` serve the gatekeeper module `gatekeeper`? The same vendor, or a
 * catalogue entry whose companion it is (Slack posting rides on the Slack connection, ADR 0114).
 */
export function connectionServes(vendor: string, gatekeeper: string): boolean {
  return vendor === gatekeeper || catalogueEntry(vendor)?.companion === gatekeeper;
}

/** Bindings (live and revoked) of the given automations: one range read per id on the PK. */
export async function loadBindings(
  db: Kysely<CoreDatabase>,
  automationIds: readonly string[],
): Promise<AutomationBinding[]> {
  if (!automationIds.length) return [];
  const rows = await db
    .selectFrom("core_automation_binding")
    .selectAll()
    .where("automation_id", "in", jsonList([...new Set(automationIds)]))
    .execute();
  return rows.map(toBinding);
}

/** The live binding of one slot (a PK lookup), or null. Used by every gatekeeper call of a run. */
export async function liveBinding(
  db: Kysely<CoreDatabase>,
  automationId: string,
  slot: string,
): Promise<AutomationBinding | null> {
  const row = await db
    .selectFrom("core_automation_binding")
    .selectAll()
    .where("automation_id", "=", automationId)
    .where("slot", "=", slot)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  return row ? toBinding(row) : null;
}

/** Declared slots that have no live binding. */
export function unboundSlots(
  spec: AutomationManifest,
  bindings: readonly AutomationBinding[],
): AutomationConnection[] {
  return declaredConnections(spec).filter(
    (c) => !bindings.some((b) => b.slot === c.id && b.revokedAt === null),
  );
}

/**
 * Of `automationIds` (all declaring connections), those with every declared slot bound. One read.
 */
export async function automationsFullyBound(
  db: Kysely<CoreDatabase>,
  specs: ReadonlyMap<string, AutomationManifest>,
): Promise<Set<string>> {
  const out = new Set<string>();
  const needing: [string, AutomationManifest][] = [];
  for (const [id, spec] of specs) {
    if (declaredConnections(spec).length) needing.push([id, spec]);
    else out.add(id);
  }
  if (!needing.length) return out;
  const bindings = await loadBindings(
    db,
    needing.map(([id]) => id),
  );
  for (const [id, spec] of needing) {
    if (
      !unboundSlots(
        spec,
        bindings.filter((b) => b.automationId === id),
      ).length
    )
      out.add(id);
  }
  return out;
}

export type RevokeTarget =
  | { connectionId: string }
  /** Every connection this person owns (they were deactivated). */
  | { ownerUserId: string };

export interface RevokePlan {
  statements: Compilable[];
  /** Automations paused by this revocation. */
  automationIds: string[];
  /** Bindings revoked. */
  revoked: number;
}

/**
 * Statements that revoke the live bindings on a connection (or on every connection a person
 * owns), pause the automations using them and notify the admins, for the caller's batch. Reads
 * through core_automation_binding_connection_idx.
 */
export async function revokeBindingsPlan(
  db: Kysely<CoreDatabase>,
  target: RevokeTarget,
  input: { reason: string; by: string | null; now: string },
): Promise<RevokePlan> {
  let connectionIds: string[];
  if ("connectionId" in target) {
    connectionIds = [target.connectionId];
  } else {
    const owned = await db
      .selectFrom("core_integration_connection")
      .select("id")
      .where("owner_user_id", "=", target.ownerUserId)
      .execute();
    connectionIds = owned.map((r) => r.id);
  }
  if (!connectionIds.length) return { statements: [], automationIds: [], revoked: 0 };
  const live = await db
    .selectFrom("core_automation_binding as b")
    .innerJoin("core_automations as a", "a.id", "b.automation_id")
    .select(["b.automation_id", "b.slot", "a.label", "a.paused_reason"])
    .where("b.connection_id", "in", jsonList(connectionIds))
    .where("b.revoked_at", "is", null)
    .execute();
  if (!live.length) return { statements: [], automationIds: [], revoked: 0 };
  const statements: Compilable[] = [
    db
      .updateTable("core_automation_binding")
      .set({ revoked_at: input.now, revoked_by: input.by, revoke_reason: input.reason })
      .where("connection_id", "in", jsonList(connectionIds))
      .where("revoked_at", "is", null),
  ];
  const automations = new Map<string, { label: string; paused: boolean }>();
  for (const row of live) {
    automations.set(row.automation_id, { label: row.label, paused: row.paused_reason !== null });
  }
  const pauseReason = `${CONNECTION_REVOKED_PREFIX}: ${input.reason}`;
  statements.push(
    db
      .updateTable("core_automations")
      .set({ paused_reason: pauseReason, paused_at: input.now, updated_at: input.now })
      .where("id", "in", jsonList([...automations.keys()]))
      .where(sql<boolean>`(paused_reason IS NULL OR paused_reason = ${WAITING_FOR_CONNECTIONS})`),
  );
  for (const [id, a] of automations) {
    const plan = await notifyStatements(
      db,
      {
        to: [{ role: "admin" }],
        type: "automation.paused",
        title: `“${a.label}” was paused`,
        body: `${input.reason}. Bind another connection on the automation page, then enable it again.`,
        link: { kind: "automation", automationId: id },
        dedupeKey: `revoked:${id}:${input.now}`,
        source: { actor: "automation", automationId: id },
      },
      input.now,
    );
    statements.push(...plan.statements);
  }
  return { statements, automationIds: [...automations.keys()], revoked: live.length };
}

/** Revokes and pauses outside an operation (the integration host, on expired credentials). */
export async function revokeBindings(
  crm: CrmDb,
  target: RevokeTarget,
  input: { reason: string; by: string | null; now?: string },
): Promise<RevokePlan> {
  const now = input.now ?? new Date().toISOString();
  const plan = await revokeBindingsPlan(crm.query, target, { ...input, now });
  if (plan.statements.length) await crm.batch(plan.statements);
  return plan;
}
