// Helpers shared by the record operations (person, organisation, affiliation, trash).
import type { CoreDatabase } from "@crm/db";
import type { Kysely } from "kysely";
import { ValidationError } from "../errors.ts";

/** How long a soft-deleted record stays restorable before the scheduled purge. */
export const TRASH_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;

/** The date a record deleted at `deletedAt` stops being restorable. */
export function restorableUntil(deletedAt: string): string {
  return new Date(Date.parse(deletedAt) + TRASH_RETENTION_DAYS * DAY_MS).toISOString();
}

/** Records deleted before this instant are past retention at `now`. */
export function purgeCutoff(now: string): string {
  return new Date(Date.parse(now) - TRASH_RETENTION_DAYS * DAY_MS).toISOString();
}

/**
 * Most records one batch operation (`*.updateMany`, `*.deleteMany`) touches. Every touched record
 * adds statements (its audit diff, maybe a timeline post) to the operation's single D1 batch, and
 * D1 limits queries per invocation, so larger selections are split by the caller into several
 * calls (ADR 0018 amendment).
 */
export const BATCH_MAX = 100;

/**
 * D1 allows at most 100 bound parameters per statement, so `IN (...)` lists are chunked. 50 ids
 * leave room for the statement's other parameters.
 */
export const IN_LIST_CHUNK = 50;

export function chunk<T>(items: readonly T[], size: number = IN_LIST_CHUNK): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** undefined stays undefined (field not given); "" and null become null (clear the field). */
export const blankToNull = (value: string | null | undefined) =>
  value === undefined ? undefined : value === null || value === "" ? null : value;

export async function assertUserExists(
  db: Kysely<CoreDatabase>,
  id: string | null | undefined,
  field = "ownerId",
): Promise<void> {
  if (!id) return;
  const user = await db
    .selectFrom("core_user")
    .select("id")
    .where("id", "=", id)
    .executeTakeFirst();
  if (!user) throw new ValidationError(`No user with id ${id}`, { field });
}

/** Gives exactly one item `primary: true`: the flagged one, else the first. */
export function withPrimary<T extends { primary?: boolean | undefined }>(
  items: readonly T[],
  what: string,
): (Omit<T, "primary"> & { primary: boolean })[] {
  const flagged = items.filter((item) => item.primary).length;
  if (flagged > 1) throw new ValidationError(`Only one ${what} can be primary`);
  return items.map((item, i) => ({ ...item, primary: flagged ? Boolean(item.primary) : i === 0 }));
}

/** Rejects duplicate ids in a batch input. */
export function uniqueIds(ids: readonly string[]): string[] {
  const unique = [...new Set(ids)];
  if (unique.length !== ids.length) throw new ValidationError("An id is listed twice");
  return unique;
}
