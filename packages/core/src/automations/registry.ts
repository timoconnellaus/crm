// The automation registry (ADR 0130): core_automations mirrors the `automations` of every
// installed extension. extension.install syncs it in the install's own batch; the queue consumer,
// the cron and the automation.* operations read it.
import type { CoreDatabase } from "@relationship-os/db";
import { type AutomationManifest, automationManifestSchema } from "@relationship-os/sdk";
import { type Compilable, type Kysely, sql } from "kysely";
import { jsonList } from "../records/common.ts";
import { WAITING_FOR_CONNECTIONS } from "./bindings.ts";
import { AUTOMATION_SETTINGS, type AutomationDefinition, DEFAULT_RAILS } from "./types.ts";

/** The trigger's object, when it has one (the matching index keys on it). */
export function triggerObject(spec: AutomationManifest): string | null {
  const t = spec.trigger;
  return "object" in t && typeof t.object === "string" ? t.object : null;
}

/**
 * Statements that make core_automations match `manifest.automations` for extension `id`:
 * inserts new ones, updates changed ones (keeping `enabled` and any pause), marks dropped ones
 * removed (kept for run history) and revives re-declared ones.
 */
export function automationSyncStatements(
  db: Kysely<CoreDatabase>,
  input: {
    extensionId: string;
    commit: string | null;
    automations: Record<string, AutomationManifest>;
    now: string;
  },
): Compilable[] {
  const statements: Compilable[] = [];
  const ids: string[] = [];
  for (const [key, spec] of Object.entries(input.automations)) {
    const id = `${input.extensionId}.${key}`;
    ids.push(id);
    const values = {
      label: spec.label,
      trigger_type: spec.trigger.type,
      trigger_object: triggerObject(spec),
      spec: JSON.stringify(spec),
      commit_oid: input.commit,
      removed_at: null,
      updated_at: input.now,
    };
    statements.push(
      db
        .insertInto("core_automations")
        .values({
          id,
          extension_id: input.extensionId,
          key,
          ...values,
          enabled: 1,
          // An automation that needs connections waits until a person binds them (ADR 0170).
          paused_reason: spec.connections?.length ? WAITING_FOR_CONNECTIONS : null,
          paused_at: spec.connections?.length ? input.now : null,
          created_at: input.now,
        })
        .onConflict((oc) => oc.column("id").doUpdateSet(values)),
    );
  }
  let removed = db
    .updateTable("core_automations")
    .set({ removed_at: input.now, updated_at: input.now })
    .where("extension_id", "=", input.extensionId)
    .where("removed_at", "is", null);
  if (ids.length) removed = removed.where("id", "not in", jsonList(ids));
  statements.push(removed);
  return statements;
}

export interface AutomationRow {
  id: string;
  extension_id: string;
  key: string;
  label: string;
  trigger_type: string;
  trigger_object: string | null;
  spec: string;
  commit_oid: string | null;
  enabled: number;
  paused_reason: string | null;
  paused_at: string | null;
  removed_at: string | null;
}

export function parseSpec(json: string): AutomationManifest | null {
  try {
    const parsed = automationManifestSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function toDefinition(row: AutomationRow): AutomationDefinition | null {
  const spec = parseSpec(row.spec);
  if (!spec) return null;
  return {
    id: row.id,
    extensionId: row.extension_id,
    key: row.key,
    commit: row.commit_oid,
    spec,
  };
}

/**
 * Enabled, live automations of the given trigger types (optionally on the given objects) whose
 * extension is active. Uses core_automations_trigger_idx: the partial index's predicate is
 * repeated literally so the planner matches it.
 */
export async function loadEnabledAutomations(
  db: Kysely<CoreDatabase>,
  triggerTypes: readonly string[],
  objects?: readonly string[],
): Promise<AutomationDefinition[]> {
  if (!triggerTypes.length) return [];
  let q = db
    .selectFrom("core_automations as a")
    .innerJoin("core_extensions as e", "e.id", "a.extension_id")
    .select([
      "a.id",
      "a.extension_id",
      "a.key",
      "a.label",
      "a.trigger_type",
      "a.trigger_object",
      "a.spec",
      "a.commit_oid",
      "a.enabled",
      "a.paused_reason",
      "a.paused_at",
      "a.removed_at",
    ])
    .where(sql<boolean>`a.enabled = 1 AND a.paused_reason IS NULL AND a.removed_at IS NULL`)
    .where("a.trigger_type", "in", jsonList([...triggerTypes]))
    .where("e.status", "=", "active");
  if (objects) {
    if (!objects.length) return [];
    q = q.where("a.trigger_object", "in", jsonList([...new Set(objects)]));
  }
  const rows = await q.execute();
  return rows.map(toDefinition).filter((d): d is AutomationDefinition => d !== null);
}

export interface AutomationSettings {
  killSwitch: boolean;
  timezone: string;
  debounceSeconds: number;
}

/** The kill switch, the automation timezone and the debounce window (one indexed read). */
export async function loadAutomationSettings(
  db: Kysely<CoreDatabase>,
): Promise<AutomationSettings> {
  const rows = await db
    .selectFrom("core_settings")
    .select(["key", "value"])
    .where("key", "in", [
      AUTOMATION_SETTINGS.killSwitch,
      AUTOMATION_SETTINGS.timezone,
      AUTOMATION_SETTINGS.debounceSeconds,
    ])
    .execute();
  const value = (key: string): unknown => {
    const row = rows.find((r) => r.key === key);
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as unknown;
    } catch {
      return undefined;
    }
  };
  const tz = value(AUTOMATION_SETTINGS.timezone);
  const debounce = value(AUTOMATION_SETTINGS.debounceSeconds);
  return {
    // Engaged only when the stored value is exactly true.
    killSwitch: value(AUTOMATION_SETTINGS.killSwitch) === true,
    timezone: typeof tz === "string" && isTimeZone(tz) ? tz : "UTC",
    debounceSeconds:
      typeof debounce === "number" && debounce >= 0 ? debounce : DEFAULT_RAILS.debounceSeconds,
  };
}

/** True for an IANA time zone this runtime knows. */
export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The rails an automation runs under: its own, within the host maxima. */
export function effectiveRails(spec: AutomationManifest, settings: { debounceSeconds: number }) {
  return {
    maxRunsPerMinute: Math.min(
      spec.rails?.maxRunsPerMinute ?? DEFAULT_RAILS.maxRunsPerMinute,
      DEFAULT_RAILS.maxRunsPerMinute,
    ),
    maxWritesPerHour: Math.min(
      spec.rails?.maxWritesPerHour ?? DEFAULT_RAILS.maxWritesPerHour,
      DEFAULT_RAILS.maxWritesPerHour,
    ),
    debounceSeconds: spec.rails?.debounceSeconds ?? settings.debounceSeconds,
  };
}
