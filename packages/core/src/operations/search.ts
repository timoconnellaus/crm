// search.global: Cmd-K search over people, organisations, activities and tasks, using the FTS5
// index core_search (migration 0006). Every query word is a prefix match, so it works as you type.
import type { CoreDatabase } from "@crm/db";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import { getObject, isCoreObject, listObjects } from "../fields/index.ts";
import { defineOperation } from "../operation.ts";
import { jsonList } from "../records/common.ts";

export const SEARCH_OBJECTS = ["person", "organisation", "activity", "task"] as const;
export type SearchObject = (typeof SEARCH_OBJECTS)[number];

const segmentSchema = z.object({ text: z.string(), match: z.boolean() });
export type HighlightSegment = z.infer<typeof segmentSchema>;

export const searchHitSchema = z.object({
  object: z.string().describe("person, organisation, activity, task or <extension>.<object>"),
  id: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  /** The title split into plain and matching parts, for safe highlighting (no HTML). */
  titleHighlight: z.array(segmentSchema),
  /** A short excerpt of the matching body text (emails, domains, notes), or null. */
  snippet: z.array(segmentSchema).nullable(),
});
export type SearchHit = z.infer<typeof searchHitSchema>;

const MAX_TERMS = 8;
const WORD_RE = /[\p{L}\p{N}]+/gu;
// Snippet markers: control characters that never occur in indexed text.
export const SNIPPET_OPEN = "\u0001";
export const SNIPPET_CLOSE = "\u0002";

/** Lower-cased, accent-free form, matching the index's unicode61 remove_diacritics tokenizer. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** The query's words, folded, at most MAX_TERMS. */
export function searchTerms(query: string): string[] {
  return [...new Set(fold(query).match(WORD_RE) ?? [])].slice(0, MAX_TERMS);
}

/**
 * The FTS5 MATCH expression: every word as a quoted prefix term, all required. Words contain only
 * letters and digits, so no FTS syntax (quotes, operators, column filters) can get through.
 */
export function ftsQuery(terms: readonly string[]): string {
  return terms.map((term) => `"${term}"*`).join(" ");
}

/** Splits `text` into segments, marking words that start with one of the terms. */
export function highlight(text: string, terms: readonly string[]): HighlightSegment[] {
  const segments: HighlightSegment[] = [];
  const push = (part: string, match: boolean) => {
    if (!part) return;
    const last = segments.at(-1);
    if (last && last.match === match) last.text += part;
    else segments.push({ text: part, match });
  };
  let index = 0;
  for (const word of text.matchAll(WORD_RE)) {
    push(text.slice(index, word.index), false);
    const folded = fold(word[0]);
    push(
      word[0],
      terms.some((term) => folded.startsWith(term)),
    );
    index = word.index + word[0].length;
  }
  push(text.slice(index), false);
  return segments;
}

export function snippetSegments(snippet: string | null): HighlightSegment[] | null {
  if (!snippet?.includes(SNIPPET_OPEN)) return null;
  const segments: HighlightSegment[] = [];
  for (const [i, part] of snippet.split(SNIPPET_OPEN).entries()) {
    if (i === 0) {
      if (part) segments.push({ text: part, match: false });
      continue;
    }
    const [matched = "", rest = ""] = part.split(SNIPPET_CLOSE);
    if (matched) segments.push({ text: matched, match: true });
    if (rest) segments.push({ text: rest, match: false });
  }
  return segments;
}

interface Display {
  title: string;
  subtitle: string | null;
}

/** Titles and subtitles from the crm_* views (live records only), keyed `object:id`. */
export async function loadDisplays(
  db: Kysely<CoreDatabase>,
  ids: Map<string, string[]>,
): Promise<Map<string, Display>> {
  const out = new Map<string, Display>();
  const tasks: Promise<void>[] = [];
  for (const [type, list] of ids) {
    const object = getObject(type);
    if (!object?.extension || !object.titleField || isCoreObject(type)) continue;
    const title = object.fields.find((f) => f.name === object.titleField)?.column;
    if (!title) continue;
    tasks.push(
      sql<{ id: string; title: string | null }>`
        SELECT id, ${sql.ref(title)} AS title FROM ${sql.table(object.source)}
        WHERE id IN ${jsonList(list)}
      `
        .execute(db)
        .then((result) => {
          for (const r of result.rows) {
            out.set(`${type}:${r.id}`, { title: r.title ?? "(untitled)", subtitle: object.label });
          }
        }),
    );
  }
  const people = ids.get("person");
  if (people?.length) {
    tasks.push(
      db
        .selectFrom("crm_people")
        .select(["id", "display_name", "primary_email", "job_title", "organisation_name"])
        .where("id", "in", jsonList(people))
        .execute()
        .then((rows) => {
          for (const r of rows) {
            const work = [r.job_title, r.organisation_name].filter(Boolean).join(" · ");
            out.set(`person:${r.id}`, {
              title: r.display_name,
              subtitle: work || r.primary_email,
            });
          }
        }),
    );
  }
  const orgs = ids.get("organisation");
  if (orgs?.length) {
    tasks.push(
      db
        .selectFrom("crm_organisations")
        .select(["id", "name", "primary_domain", "industry"])
        .where("id", "in", jsonList(orgs))
        .execute()
        .then((rows) => {
          for (const r of rows) {
            const subtitle = [r.primary_domain, r.industry].filter(Boolean).join(" · ");
            out.set(`organisation:${r.id}`, { title: r.name, subtitle: subtitle || null });
          }
        }),
    );
  }
  const activities = ids.get("activity");
  if (activities?.length) {
    tasks.push(
      db
        .selectFrom("crm_activities")
        .select(["id", "type", "subject", "body", "occurred_at"])
        .where("id", "in", jsonList(activities))
        .execute()
        .then((rows) => {
          for (const r of rows) {
            const type = r.type[0]?.toUpperCase() + r.type.slice(1);
            const title = r.subject || (r.body ?? "").slice(0, 80) || type;
            out.set(`activity:${r.id}`, {
              title,
              subtitle: `${type} · ${r.occurred_at.slice(0, 10)}`,
            });
          }
        }),
    );
  }
  const taskIds = ids.get("task");
  if (taskIds?.length) {
    tasks.push(
      db
        .selectFrom("crm_tasks")
        .select(["id", "title", "status", "due_at"])
        .where("id", "in", jsonList(taskIds))
        .execute()
        .then((rows) => {
          for (const r of rows) {
            const subtitle =
              r.status === "done"
                ? "Task · done"
                : r.due_at
                  ? `Task · due ${r.due_at.slice(0, 10)}`
                  : "Task";
            out.set(`task:${r.id}`, { title: r.title, subtitle });
          }
        }),
    );
  }
  await Promise.all(tasks);
  return out;
}

export const searchGlobal = defineOperation({
  name: "search.global",
  description:
    "Search everything by name, email, domain or text: people (names, emails), organisations " +
    "(name, domains), activities (subject, body) and tasks (title, notes). Every word must " +
    "match the start of a word in the record, so partial input works ('ada lov', 'acme.co'). " +
    "Best matches first, titles weighted over body text. Restrict with objects. Returns typed " +
    "hits with title, subtitle and highlighted parts. Read-only.",
  input: z.object({
    query: z.string().max(200).describe("What the user typed"),
    objects: z
      .array(z.string().min(1).max(80))
      .min(1)
      .max(50)
      .optional()
      .describe("Object types to search (default all, including extension objects)"),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  output: z.object({ hits: z.array(searchHitSchema) }),
  permission: "records:read",
  risk: "read",
  mcp: { curated: true, idempotent: true },
  async handler(input, ctx) {
    const terms = searchTerms(input.query);
    if (!terms.length) return { hits: [] };
    const objects = input.objects ?? listObjects().map((o) => o.name);
    const matches = await sql<{
      object_type: string;
      record_id: string;
      snip: string | null;
    }>`
      SELECT d.object_type, d.record_id,
        snippet(core_search, 1, ${SNIPPET_OPEN}, ${SNIPPET_CLOSE}, '…', 10) AS snip
      FROM core_search
      JOIN core_search_docs d ON d.id = core_search.rowid
      WHERE core_search MATCH ${ftsQuery(terms)}
        AND d.object_type IN ${jsonList([...objects])}
      ORDER BY bm25(core_search, 10.0, 1.0), d.id
      LIMIT ${input.limit}
    `.execute(ctx.db);

    const ids = new Map<string, string[]>();
    for (const m of matches.rows)
      ids.set(m.object_type, [...(ids.get(m.object_type) ?? []), m.record_id]);
    const displays = await loadDisplays(ctx.db, ids);

    const hits: SearchHit[] = [];
    for (const m of matches.rows) {
      const display = displays.get(`${m.object_type}:${m.record_id}`);
      if (!display) continue; // deleted between the index read and the view read
      hits.push({
        object: m.object_type,
        id: m.record_id,
        title: display.title,
        subtitle: display.subtitle,
        titleHighlight: highlight(display.title, terms),
        snippet: snippetSegments(m.snip),
      });
    }
    return { hits };
  },
});

export const searchOperations = [searchGlobal] as const;
