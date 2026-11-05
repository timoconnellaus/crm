// Org Slack channel routes (stage 6b, ADR 0172): an admin sends record events of an object to a
// Slack channel, e.g. a deal moving to a won stage → #sales. Matching is pure over a committed
// record event message (the automation consumer's input) and the routes, with the same field and
// stage-type matching as the `fieldChanged` trigger. Each match posts once
// (`route:<eventId>:<routeId>:<recordId>` in core_notification_delivery).
//
// Disclosure (ADR 0052): activities (synced email and meetings) are never routed, bulk events
// (imports) are not either, and the message carries only the route's label, the object's label,
// the record's title and a link.
import type { CoreDatabase } from "@crm/db";
import { type Kysely, sql } from "kysely";
import { valueMatches } from "../automations/sources.ts";
import type { RecordEventMessage } from "../automations/types.ts";
import { getField, getObject } from "../fields/index.ts";
import { notificationHref } from "../operations/notification.ts";
import { viewColumnOf } from "../records/columns.ts";
import { type CallIntegration, type ChannelTarget, postToSlack, slackEscape } from "./channels.ts";
import { claimDelivery, type DeliveryResult, settleDelivery } from "./ledger.ts";
import type { NotificationRoute, RouteValueMatch } from "./preferences.ts";

/** Objects no route may watch: synced email and meeting content stays out of Slack. */
export const UNROUTABLE_OBJECTS: readonly string[] = ["activity"];

export interface RouteMatch {
  route: NotificationRoute;
  eventId: string;
  record: { object: string; id: string };
  action: "created" | "updated" | "deleted";
}

type ValueMatchArg = Parameters<typeof valueMatches>[0];

function usesStageType(match: RouteValueMatch | undefined): boolean {
  return match !== null && typeof match === "object" && "stageType" in match;
}

/** The routes a record event fires (pure; the field registry must be current for stages). */
export function matchNotificationRoutes(
  message: RecordEventMessage,
  routes: readonly NotificationRoute[],
): RouteMatch[] {
  if (message.origin.bulk) return [];
  const out: RouteMatch[] = [];
  for (const change of message.changes) {
    if (UNROUTABLE_OBJECTS.includes(change.object)) continue;
    if (change.action !== "created" && change.action !== "updated" && change.action !== "deleted")
      continue;
    for (const route of routes) {
      if (!route.enabled || route.object !== change.object || route.event !== change.action) {
        continue;
      }
      if (route.event === "updated" && route.field) {
        const diff = change.diff;
        if (!diff) continue;
        const stageTyped = usesStageType(route.from) || usesStageType(route.to);
        const statusField = stageTyped ? getObject(change.object)?.stages?.status : undefined;
        const status = statusField ? diff[statusField] : undefined;
        if (!(route.field in diff) && !status) continue;
        if (stageTyped && !status) continue;
        const fieldDiff = diff[route.field] ?? { before: undefined, after: undefined };
        if (!valueMatches(route.from as ValueMatchArg, fieldDiff.before, status?.before)) continue;
        if (!valueMatches(route.to as ValueMatchArg, fieldDiff.after, status?.after)) continue;
      }
      out.push({
        route,
        eventId: message.id,
        record: { object: change.object, id: change.id },
        action: change.action,
      });
    }
  }
  return out;
}

/** The record's title through its object's read view, or null. */
export async function recordTitle(
  db: Kysely<CoreDatabase>,
  record: { object: string; id: string },
): Promise<string | null> {
  const object = getObject(record.object);
  if (!object) return null;
  const field = [object.titleField, "displayName", "name", "title", "subject"]
    .map((name) => (name ? getField(object, name) : undefined))
    .find((f) => f && viewColumnOf(f));
  const column = field ? viewColumnOf(field) : null;
  if (!column) return null;
  const result = await sql<{ v: unknown }>`SELECT ${sql.ref(column)} AS v FROM ${sql.table(
    object.source,
  )} WHERE id = ${record.id}`.execute(db);
  const value = result.rows[0]?.v;
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : null;
}

/** The fixed route message: `*Deal won*: Deal "Acme renewal"` and a link. */
export function routeText(match: RouteMatch, title: string | null, url: string | null): string {
  const object = getObject(match.record.object);
  const what = `${object?.label ?? match.record.object}${title ? ` "${title}"` : ""}`;
  const verb = match.action === "deleted" ? " (deleted)" : "";
  const link = url && match.action !== "deleted" ? `\n<${url}|Open in the CRM>` : "";
  return `*${slackEscape(match.route.label)}*: ${slackEscape(what)}${verb}${link}`;
}

/** Posts each match once to its channel through the Slack target. */
export async function deliverRouteMatches(input: {
  db: Kysely<CoreDatabase>;
  matches: readonly RouteMatch[];
  target: ChannelTarget;
  callIntegration: CallIntegration;
  appOrigin: string | null;
  now: string;
}): Promise<DeliveryResult[]> {
  const results: DeliveryResult[] = [];
  for (const match of input.matches) {
    const key = `route:${match.eventId}:${match.route.id}:${match.record.id}`;
    if (!(await claimDelivery(input.db, { key, kind: "route", channel: "slack" }, input.now))) {
      results.push({ key, status: "duplicate" });
      continue;
    }
    try {
      const title = match.action === "deleted" ? null : await recordTitle(input.db, match.record);
      const href = notificationHref({ kind: "record", ...match.record });
      const url = href && input.appOrigin ? `${input.appOrigin}${href}` : null;
      const outcome = await postToSlack(input.callIntegration, input.target, {
        channel: match.route.channel,
        text: routeText(match, title, url),
      });
      await settleDelivery(input.db, key, outcome);
      results.push({ key, ...outcome });
    } catch (error) {
      results.push(await settleDelivery(input.db, key, error));
    }
  }
  return results;
}
