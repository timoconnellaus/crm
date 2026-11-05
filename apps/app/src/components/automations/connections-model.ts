// Run-as wording and choices for an automation's declared connections (ADR 0170), as pure
// functions (unit-tested in test/automation-connections-model.test.ts): which connections a person
// may bind to a slot, the consent sentence, who a binding runs as, and the pause explanations.
import { catalogueEntry } from "@relationship-os/core/client";

/** The pause reason of an automation whose declared connections are not all bound (core). */
export const WAITING_FOR_CONNECTIONS = "Waiting for connections";
/** Revocation pause reasons start with this (core). */
export const CONNECTION_REVOKED_PREFIX = "Connection revoked";

/** One declared connection as automation.get returns it (AutomationConnectionView). */
export interface ConnectionSlot {
  slot: string;
  gatekeeper: string;
  purpose: string;
  binding: {
    connectionId: string;
    connectionTitle: string;
    scope: "personal" | "org";
    status: string;
    ownerUserId: string;
    ownerName: string | null;
    boundBy: string;
    boundByName: string | null;
    boundAt: string;
  } | null;
  revoked: {
    connectionTitle: string | null;
    revokedAt: string;
    revokedByName: string | null;
    reason: string | null;
  } | null;
}

/** The connection fields the picker needs (a connection.list item). */
export interface PickableConnection {
  id: string;
  vendor: string;
  vendorTitle: string;
  scope: "personal" | "org";
  ownerUserId: string;
  ownerName: string | null;
  title: string;
  accountLabel: string | null;
  status: string;
}

/** automation.get's `connections` (typed `unknown[]` in the stage-5 schema). */
export function connectionSlots(value: readonly unknown[] | undefined): ConnectionSlot[] {
  return (value ?? []).filter(
    (v): v is ConnectionSlot =>
      Boolean(v) && typeof v === "object" && typeof (v as ConnectionSlot).slot === "string",
  );
}

/**
 * Can a connection of `vendor` serve the gatekeeper module `gatekeeper`? The same vendor, or the
 * vendor whose catalogue companion it is (Slack posting rides on the Slack connection). Mirrors
 * core's `connectionServes`, which the bind operation enforces.
 */
export function connectionServes(vendor: string, gatekeeper: string): boolean {
  return vendor === gatekeeper || catalogueEntry(vendor)?.companion === gatekeeper;
}

/**
 * Connections the caller may bind to a slot of `gatekeeper`: active, serving it, and either their
 * own personal connection or (admins) an org connection. The bind operation checks the same.
 */
export function bindableConnections<C extends PickableConnection>(
  connections: readonly C[],
  gatekeeper: string,
  me: { userId: string; isAdmin: boolean },
): C[] {
  return connections.filter(
    (c) =>
      c.status === "active" &&
      connectionServes(c.vendor, gatekeeper) &&
      (c.scope === "personal" ? c.ownerUserId === me.userId : me.isAdmin),
  );
}

/** "Fake provider (development) · ada@example.com" */
export function connectionLabel(c: Pick<PickableConnection, "title" | "accountLabel">): string {
  return c.accountLabel && c.accountLabel !== c.title ? `${c.title} · ${c.accountLabel}` : c.title;
}

/** Who the automation's steps act as through the connection: "you", "Ada", "Ada (org)". */
export function runsAs(
  c: { scope: "personal" | "org"; ownerUserId: string; ownerName: string | null },
  userId: string,
): string {
  const owner = c.ownerUserId === userId ? "you" : (c.ownerName ?? "its owner");
  return c.scope === "org" ? `${owner} (org connection)` : owner;
}

/** The consent sentence: "Allow “Welcome email” to use Gmail · ada@x.com as you". */
export function consentText(
  automationLabel: string,
  c: PickableConnection,
  userId: string,
): string {
  return `Allow “${automationLabel}” to use ${connectionLabel(c)} as ${runsAs(c, userId)}`;
}

/** The gatekeeper's catalogue title ("Fake provider (development)"), else its module name. */
export function gatekeeperTitle(gatekeeper: string): string {
  return catalogueEntry(gatekeeper)?.title ?? gatekeeper;
}

/** True when the pause is about connections (the page offers to bind them). */
export function waitsForConnections(pausedReason: string | null | undefined): boolean {
  return (
    pausedReason === WAITING_FOR_CONNECTIONS ||
    (pausedReason?.startsWith(CONNECTION_REVOKED_PREFIX) ?? false)
  );
}

/**
 * What the connections banner says. Binding the last slot lifts "Waiting for connections" by
 * itself; after a revocation pause a person resumes it once everything is bound again.
 */
export function connectionsBanner(
  pausedReason: string | null | undefined,
  slots: readonly ConnectionSlot[],
): { title: string; body: string; canResume: boolean } | null {
  if (!waitsForConnections(pausedReason)) return null;
  const unbound = slots.filter((s) => !s.binding);
  const revoked = pausedReason?.startsWith(CONNECTION_REVOKED_PREFIX) ?? false;
  if (!unbound.length) {
    return {
      title: revoked ? "Connection revoked" : WAITING_FOR_CONNECTIONS,
      body: "Every connection is bound again. Resume it to let it run.",
      canResume: true,
    };
  }
  const names = unbound.map((s) => `“${s.slot}”`).join(", ");
  return {
    title: revoked ? "Connection revoked" : WAITING_FOR_CONNECTIONS,
    body: `${revoked ? `${pausedReason}. ` : ""}It does not run until someone allows it to use a connection for ${names}: choose one under Permissions.`,
    canResume: false,
  };
}
