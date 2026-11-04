// Job-change suggestions (stage 6a, ADR 0052) in words: what the email showed, per signal. Pure,
// so it is unit tested.
import { formatDate } from "#/lib/format";

export interface JobChangeLike {
  signal: "bounce" | "signature" | "domain";
  evidence: Record<string, unknown>;
  proposal: Record<string, unknown>;
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/** What the email showed, per signal, in words. */
export function jobChangeEvidence(item: JobChangeLike): {
  headline: string;
  detail: string | null;
} {
  const e = item.evidence;
  const p = item.proposal;
  const when = str(e.at) ? ` on ${formatDate(str(e.at) ?? "")}` : "";
  switch (item.signal) {
    case "bounce":
      return {
        headline: `Mail to ${str(e.email) ?? "their address"} bounced${when}`,
        detail: str(e.subject) ? `“${str(e.subject)}”` : null,
      };
    case "signature": {
      const role = [str(p.title), str(p.organisationName)].filter(Boolean).join(" at ");
      return {
        headline: `Their email signature changed${role ? `: ${role}` : ""}${when}`,
        detail: str(e.signature),
      };
    }
    case "domain":
      return {
        headline: `Wrote from ${str(e.email) ?? "a new address"}${str(p.domain) ? `, a new domain (${str(p.domain)})` : ""}${when}`,
        detail: Array.isArray(e.previousEmails)
          ? `Known addresses: ${(e.previousEmails as unknown[]).filter((x) => typeof x === "string").join(", ")}`
          : null,
      };
  }
}
