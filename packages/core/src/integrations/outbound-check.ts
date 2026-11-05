// The outbound.message placement in the outbound approval flow (ADR 0238, docs/jev.md placement
// 4): what `submitOutbound` asks the judge about a gatekeeper action, and where the evidence comes
// from. Code decides everything exact here: whether the text came from an AI actor, which fields
// of the gatekeeper's description are the message (recipients, subject, body), which CRM people
// the addresses belong to, and which records' facts go with it. Jev only judges meaning.
import type { CoreDatabase } from "@relationship-os/db";
import type { Kysely } from "kysely";
import { recordSummaryInput } from "../ai/summaries.ts";
import { findIds } from "../ids.ts";
import {
  checkOutboundMessage,
  type OutboundChecked,
  type OutboundMessage,
} from "../judge/questions/outbound-message.ts";
import { splitSentences } from "../judge/sentences.ts";
import type { Judge } from "../judge/types.ts";
import type { Actor, Origin } from "../principals.ts";
import { jsonList } from "../records/common.ts";
import type { OutboundInput } from "./outbound.ts";

/** Actors whose words are a model's. A person's own outbound action is never checked. */
const AI_ACTORS: readonly Actor[] = ["assistant", "mcp", "automation", "extension"];

/**
 * Whether an outbound action's text came from an AI actor. Notification delivery (ADR 0172) and
 * the system's own sends (sync, webhooks) are the platform's templates: never checked.
 */
export function textFromAi(actor: Actor, origin: Origin): boolean {
  return AI_ACTORS.includes(actor) && origin.surface !== "system";
}

const RECIPIENT_LABELS = /^(to|cc|bcc|recipients?|channel|attendees?|guests?)$/i;
const SUBJECT_LABELS = /^(subject|title)$/i;
const BODY_LABELS = /^(body|text|message|content|description)$/i;
const HTML_LABELS = /^html( body)?$/i;

/** HTML as plain text, for reading only (never shown). */
function htmlText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * The message in a gatekeeper's description, from its literal fields: recipients, subject and
 * body. Null when the action carries no message text (a calendar change, a document edit): there
 * is nothing for this placement to read.
 */
export function messageOf(input: Pick<OutboundInput, "fields">):
  | (Omit<OutboundMessage, "to"> & {
      addresses: string[];
    })
  | null {
  const fields = input.fields ?? [];
  const body =
    fields.find((f) => BODY_LABELS.test(f.label.trim()))?.value ??
    (() => {
      const html = fields.find((f) => HTML_LABELS.test(f.label.trim()))?.value;
      return html ? htmlText(html) : undefined;
    })();
  if (!body?.trim()) return null;
  const subject = fields.find((f) => SUBJECT_LABELS.test(f.label.trim()))?.value?.trim();
  const addresses = fields
    .filter((f) => RECIPIENT_LABELS.test(f.label.trim()))
    .flatMap((f) => f.value.split(/[\n,;]+/))
    .map((a) => a.trim())
    .filter(Boolean)
    .slice(0, 50);
  return {
    addresses,
    ...(subject ? { subject: subject.slice(0, 500) } : {}),
    sentences: splitSentences(body.slice(0, 20_000)),
  };
}

const EMAIL = /[^\s<>"',;]+@[^\s<>"',;]+\.[^\s<>"',;]+/;

/** The CRM people the addresses belong to, matched exactly by email (code, never Jev). */
async function peopleByAddress(
  db: Kysely<CoreDatabase>,
  addresses: readonly string[],
): Promise<Map<string, { id: string; name: string }>> {
  const emails = [
    ...new Set(
      addresses.flatMap((a) => {
        const m = EMAIL.exec(a);
        return m ? [m[0].toLowerCase()] : [];
      }),
    ),
  ].slice(0, 20);
  const out = new Map<string, { id: string; name: string }>();
  if (!emails.length) return out;
  const rows = await db
    .selectFrom("core_person_emails as e")
    .innerJoin("crm_people as p", "p.id", "e.person_id")
    .select(["e.email", "p.id", "p.display_name"])
    .where("e.live", "=", 1)
    .where((eb) => eb(eb.fn("lower", ["e.email"]), "in", jsonList(emails)))
    .execute();
  for (const r of rows) out.set(r.email.toLowerCase(), { id: r.id, name: r.display_name });
  return out;
}

/** Records whose facts go with a message: the people it goes to, then the records it names. */
const MAX_FACT_RECORDS = 3;

/**
 * Asks `outbound.message` about one gatekeeper action. `off` when the judge is off, the action
 * carries no message, or nothing about it is for the judge.
 */
export async function checkOutbound(input: {
  judge: Judge | undefined;
  db: Kysely<CoreDatabase>;
  outbound: OutboundInput;
  /** The person's own words, passed by code (the assistant's Durable Object), or null. */
  asked: string | null | undefined;
  now: string;
}): Promise<OutboundChecked> {
  if (!input.judge) return { status: "off" };
  const message = messageOf(input.outbound);
  if (!message) return { status: "off" };
  const people = await peopleByAddress(input.db, message.addresses).catch(
    () => new Map<string, { id: string; name: string }>(),
  );
  const to = message.addresses.map((a) => {
    const m = EMAIL.exec(a);
    const person = m ? people.get(m[0].toLowerCase()) : undefined;
    return person && !a.includes(person.name) ? `${person.name} <${m?.[0]}>` : a;
  });
  const named = findIds([input.outbound.title, input.outbound.description, input.outbound.fields]);
  const records = [
    ...[...people.values()].map((p) => ({ object: "person", id: p.id })),
    ...named.flatMap((id) =>
      id.startsWith("per_")
        ? [{ object: "person", id }]
        : id.startsWith("org_")
          ? [{ object: "organisation", id }]
          : [],
    ),
  ]
    .filter((r, i, all) => all.findIndex((o) => o.id === r.id) === i)
    .slice(0, MAX_FACT_RECORDS);
  const facts: string[] = [];
  for (const r of records) {
    try {
      const summary = await recordSummaryInput(input.db, r.object, r.id);
      facts.push(`About ${r.object} ${r.id}:`, ...summary.facts);
    } catch {
      // A record that is gone or unreadable adds no facts.
    }
  }
  return checkOutboundMessage({
    judge: input.judge,
    message: {
      to,
      ...(message.subject ? { subject: message.subject } : {}),
      sentences: message.sentences,
    },
    asked: input.asked,
    facts,
    now: input.now,
  });
}
