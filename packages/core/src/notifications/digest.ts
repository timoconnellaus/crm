// The daily digest's content (stage 6b, ADR 0172): a person's unread notifications from the last
// day and how many approvals are waiting. Composing is a seam: `plainDigest` is a fixed template;
// stage 7a can pass a composer that summarises with a model role instead. Nothing here calls a
// model.
import { NOTIFICATION_TYPES, type NotificationType } from "./types.ts";

export interface DigestItem {
  type: NotificationType;
  title: string;
  body: string | null;
  /** Absolute URL in the app, when the notice links somewhere and the app origin is known. */
  url: string | null;
  createdAt: string;
}

export interface DigestInput {
  recipient: { userId: string; name: string | null; email: string };
  /** The local date (automation timezone) the digest is for. */
  date: string;
  /** Unread notices from the last 24 hours, newest first (at most DIGEST_ITEMS). */
  items: DigestItem[];
  /** Every unread notice from the last 24 hours (items may be fewer). */
  unreadTotal: number;
  /** Pending actions in the approvals inbox (0 for someone who cannot approve). */
  pendingApprovals: number;
  /** The approvals inbox, absolute, when the app origin is known. */
  approvalsUrl: string | null;
}

export interface DigestMessage {
  subject: string;
  text: string;
}

/** Turns a digest's facts into an email. Stage 7a may plug in a summarising composer. */
export type DigestComposer = (input: DigestInput) => DigestMessage | Promise<DigestMessage>;

export const DIGEST_ITEMS = 20;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The fixed-template digest: counts, then one line per notice grouped by category. */
export const plainDigest: DigestComposer = (input) => {
  const counts: string[] = [];
  if (input.unreadTotal)
    counts.push(plural(input.unreadTotal, "unread notification", "unread notifications"));
  if (input.pendingApprovals) {
    counts.push(
      `${plural(input.pendingApprovals, "change waiting", "changes waiting")} for approval`,
    );
  }
  const lines = [
    `Your Relationship OS digest for ${input.date}`,
    "",
    `${counts.join(", ") || "Nothing new"}.`,
  ];
  if (input.pendingApprovals && input.approvalsUrl) {
    lines.push(`Review approvals: ${input.approvalsUrl}`);
  }
  const groups = new Map<string, DigestItem[]>();
  for (const item of input.items) {
    const label = NOTIFICATION_TYPES[item.type]?.label ?? "Messages";
    groups.set(label, [...(groups.get(label) ?? []), item]);
  }
  for (const [label, items] of groups) {
    lines.push("", `${label}:`);
    for (const item of items) {
      const title = item.title.replace(/[\r\n]+/g, " ").slice(0, 200);
      lines.push(`- ${title}${item.url ? ` (${item.url})` : ""}`);
    }
  }
  const more = input.unreadTotal - input.items.length;
  if (more > 0) lines.push("", `…and ${plural(more, "more", "more")} in the CRM.`);
  return {
    subject: `[Relationship OS] Daily digest: ${counts.join(", ") || "nothing new"}`,
    text: lines.join("\n"),
  };
};
