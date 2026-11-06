// The assistant side of an erase (ADR 0019 and ADR 0200 amendments, 2026-11-05; ADR 0340): threads
// that referenced the erased records are found through `core_assistant_thread_refs`, and each
// thread object redacts its stored messages (scrub.ts) before the erase commits. Their bookkeeping
// rows in D1 (the preview) are redacted in the erase's own batch, and the subject's refs are
// deleted with it.
import { ConfigError } from "../errors.ts";
import type { HandlerContext } from "../operation.ts";
import { chunk, jsonList } from "../records/common.ts";
import { type ConversationScrub, emailRef, scrubPattern, scrubText } from "./scrub.ts";

/** How many thread objects are asked at once. */
const PARALLEL = 8;

export interface ConversationSubject {
  recordIds: readonly string[];
  /** Emails and phone numbers. */
  terms: readonly string[];
  names: readonly string[];
}

/**
 * Scrubs the subject from every assistant thread that referenced it, and queues the D1 side. The
 * objects are scrubbed now, before the commit: if one cannot be reached the erase fails and
 * nothing is erased, so it can be retried (scrubbing is idempotent). While the erase is only
 * being simulated (an approval preview, test mode) nothing is scrubbed. Returns how many threads
 * were scrubbed.
 */
export async function queueScrubConversations(
  ctx: HandlerContext,
  subject: ConversationSubject,
): Promise<number> {
  const emails = subject.terms.filter((t) => t.includes("@"));
  const refs = [...subject.recordIds, ...(await Promise.all(emails.map(emailRef)))];
  if (!refs.length) return 0;
  const rows = await ctx.db
    .selectFrom("core_assistant_thread as t")
    .select(["t.id", "t.user_id", "t.preview"])
    // Driven by the ref indexes, not by scanning threads. A memory line that names the subject
    // leads to the thread it was said in, though the turn looked no record up (ADR 0342).
    .where((eb) =>
      eb.or([
        eb(
          "t.id",
          "in",
          eb
            .selectFrom("core_assistant_thread_refs as r")
            .select("r.thread_id")
            .where("r.ref", "in", jsonList(refs)),
        ),
        eb(
          "t.id",
          "in",
          eb
            .selectFrom("core_memory_refs as r")
            .innerJoin("core_memory as m", "m.id", "r.memory_id")
            .select("m.source_thread_id")
            .where("r.ref", "in", jsonList(refs))
            .where("m.source_thread_id", "is not", null)
            .$narrowType<{ source_thread_id: string }>(),
        ),
      ]),
    )
    .execute();

  const scrub: ConversationScrub = {
    terms: [...subject.recordIds, ...subject.terms],
    names: [...subject.names],
  };
  if (rows.length && !ctx.simulation) {
    const store = ctx.assistantThreads;
    if (!store) {
      throw new ConfigError(
        `${rows.length} assistant chat(s) mention this record, and they cannot be ` +
          "reached from here. Erase it from the app, which can redact them.",
      );
    }
    for (const batch of chunk(rows, PARALLEL)) {
      await Promise.all(batch.map((row) => store.scrub(row.user_id, scrub)));
    }
  }

  const pattern = scrubPattern(scrub);
  for (const row of rows) {
    const preview = row.preview === null ? null : scrubText(row.preview, pattern);
    if (preview === row.preview) continue;
    ctx.write(
      ctx.db.updateTable("core_assistant_thread").set({ preview }).where("id", "=", row.id),
    );
  }
  ctx.write(ctx.db.deleteFrom("core_assistant_thread_refs").where("ref", "in", jsonList(refs)));
  return rows.length;
}
