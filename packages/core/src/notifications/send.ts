// Writing notifications (ADR 0029, ADR 0132). `notifyStatements` resolves recipients and returns
// the core_notifications inserts, for the caller to commit in its own batch (notification.send,
// pending-approval notices, rail auto-pause notices).
//
// STUB (interfaces commit): the notifications workstream replaces the body.
import type { CoreDatabase } from "@crm/db";
import type { Compilable, Kysely } from "kysely";
import type { z } from "zod";
import type { recipientInputSchema } from "../automations/schemas.ts";
import type { NotificationLink, NotificationType } from "./types.ts";

export type RecipientInput = z.infer<typeof recipientInputSchema>;

export interface NotifyInput {
  to: RecipientInput[];
  type: NotificationType;
  title: string;
  body?: string | null;
  link?: NotificationLink | null;
  /** One notification per (user, key): repeats are ignored (INSERT OR IGNORE). */
  dedupeKey?: string;
  source: { actor: string; automationId?: string; runId?: string; userId?: string };
}

export interface NotifyPlan {
  statements: Compilable[];
  /** Resolved recipients (deduplicated). */
  userIds: string[];
  /** How recipients resolved, e.g. "no manager field: sent to admins". */
  notes: string[];
}

export async function notifyStatements(
  _db: Kysely<CoreDatabase>,
  _input: NotifyInput,
  _now: string,
): Promise<NotifyPlan> {
  return { statements: [], userIds: [], notes: [] };
}
