// The assistant side of an erase (ADR 0019 and ADR 0200 amendments, 2026-11-05): conversations
// that referenced the erased records are found through `core_assistant_conversation_refs` and each
// conversation object redacts its stored history (scrub.ts) before the erase commits. Their list
// rows in D1 (title, preview, context) are redacted in the erase's own batch, and the subject's
// refs are deleted with it.
import { ConfigError } from "../errors.ts";
import type { HandlerContext } from "../operation.ts";
import { chunk, jsonList } from "../records/common.ts";
import { type ConversationScrub, emailRef, mentions, scrubPattern, scrubText } from "./scrub.ts";

/** How many conversation objects are asked at once. */
const PARALLEL = 8;

export interface ConversationSubject {
  recordIds: readonly string[];
  /** Emails and phone numbers. */
  terms: readonly string[];
  names: readonly string[];
}

/**
 * Scrubs the subject from every assistant conversation that referenced it, and queues the D1
 * side. The objects are scrubbed now, before the commit: if one cannot be reached the erase fails
 * and nothing is erased, so it can be retried (scrubbing is idempotent). While the erase is only
 * being simulated (an approval preview, test mode) nothing is scrubbed. Returns how many
 * conversations were scrubbed.
 */
export async function queueScrubConversations(
  ctx: HandlerContext,
  subject: ConversationSubject,
): Promise<number> {
  const emails = subject.terms.filter((t) => t.includes("@"));
  const refs = [...subject.recordIds, ...(await Promise.all(emails.map(emailRef)))];
  if (!refs.length) return 0;
  const rows = await ctx.db
    .selectFrom("core_assistant_conversation as c")
    .select(["c.id", "c.title", "c.preview", "c.context"])
    .where("c.deleted_at", "is", null)
    // Driven by the ref index, not by scanning conversations.
    .where("c.id", "in", (eb) =>
      eb
        .selectFrom("core_assistant_conversation_refs as r")
        .select("r.conversation_id")
        .where("r.ref", "in", jsonList(refs)),
    )
    .execute();

  const scrub: ConversationScrub = {
    terms: [...subject.recordIds, ...subject.terms],
    names: [...subject.names],
  };
  if (rows.length && !ctx.simulation) {
    const store = ctx.assistantConversations;
    if (!store) {
      throw new ConfigError(
        `${rows.length} assistant conversation(s) mention this record, and they cannot be ` +
          "reached from here. Erase it from the app, which can redact them.",
      );
    }
    for (const batch of chunk(rows, PARALLEL)) {
      await Promise.all(batch.map((row) => store.scrub(row.id, scrub)));
    }
  }

  const pattern = scrubPattern(scrub);
  for (const row of rows) {
    const title = scrubText(row.title, pattern);
    const preview = row.preview === null ? null : scrubText(row.preview, pattern);
    // The context names the page's record and selection, with labels: dropped when it mentions them.
    const context = row.context !== null && mentions(row.context, pattern) ? null : row.context;
    if (title === row.title && preview === row.preview && context === row.context) continue;
    ctx.write(
      ctx.db
        .updateTable("core_assistant_conversation")
        .set({ title, preview, context })
        .where("id", "=", row.id),
    );
  }
  ctx.write(
    ctx.db.deleteFrom("core_assistant_conversation_refs").where("ref", "in", jsonList(refs)),
  );
  return rows.length;
}
