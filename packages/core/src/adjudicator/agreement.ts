// The adjudicator's agreement rate (ADR 0031, ADR 0204): how its verdicts compare with what people
// decided on the same pending actions. Pure, so the shadow-mode dashboard and the eval share it.
//
// Definitions:
// - A verdict is *decided* when a person approved or rejected the action afterwards (approved
//   covers applied and failed-on-apply). Actions the adjudicator applied itself, expired ones and
//   ones still pending have no human decision.
// - *Agreement* is the share of decided verdicts that took a side (approve or deny) and matched the
//   person: approve ↔ approved, deny ↔ rejected. An escalation is neither agreement nor
//   disagreement: it hands the item to a person, which is always allowed. It shows in the
//   confusion matrix and the escalation rate.
// - *Approve precision* is the share of decided `approve` verdicts the person also approved: the
//   number auto-approval stakes its safety on (the eval's bar is 0.95).
import type { Verdict } from "./judge.ts";

export type HumanDecision = "approved" | "rejected";

export interface AgreementRow {
  /** When the verdict was given (ISO). */
  judgedAt: string;
  verdict: Verdict;
  /** What a person decided afterwards, or null (undecided, expired, or the adjudicator acted). */
  human: HumanDecision | null;
  /** The adjudicator applied the action itself (active mode). */
  acted: boolean;
}

export interface ConfusionCell {
  approved: number;
  rejected: number;
  /** No human decision (yet). */
  undecided: number;
}

export interface AgreementPeriod {
  /** The period's first day, YYYY-MM-DD (UTC). Weeks start on Monday. */
  period: string;
  count: number;
  decided: number;
  agreed: number;
  /** agreed / decided verdicts that took a side; null when there were none. */
  agreement: number | null;
}

export interface AgreementReport {
  count: number;
  /** Verdicts with a human decision. */
  decided: number;
  agreement: number | null;
  approvePrecision: number | null;
  /** Escalations / count. */
  escalationRate: number | null;
  /** Actions the adjudicator applied itself. */
  autoApproved: number;
  confusion: Record<Verdict, ConfusionCell>;
  periods: AgreementPeriod[];
}

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

/** The UTC day, or the Monday of its week, of an ISO timestamp. */
export function periodOf(at: string, bucket: "day" | "week"): string {
  const day = at.slice(0, 10);
  if (bucket === "day") return day;
  const date = new Date(`${day}T00:00:00.000Z`);
  const back = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - back);
  return date.toISOString().slice(0, 10);
}

const agrees = (verdict: Verdict, human: HumanDecision) =>
  (verdict === "approve" && human === "approved") || (verdict === "deny" && human === "rejected");

export function computeAgreement(
  rows: readonly AgreementRow[],
  options: { bucket?: "day" | "week" } = {},
): AgreementReport {
  const bucket = options.bucket ?? "day";
  const confusion: Record<Verdict, ConfusionCell> = {
    approve: { approved: 0, rejected: 0, undecided: 0 },
    deny: { approved: 0, rejected: 0, undecided: 0 },
    escalate: { approved: 0, rejected: 0, undecided: 0 },
  };
  const periods = new Map<
    string,
    { count: number; decided: number; sided: number; agreed: number }
  >();
  let decided = 0;
  let sided = 0;
  let agreed = 0;
  let escalations = 0;
  let autoApproved = 0;
  for (const row of rows) {
    const key = periodOf(row.judgedAt, bucket);
    const p = periods.get(key) ?? { count: 0, decided: 0, sided: 0, agreed: 0 };
    p.count += 1;
    if (row.verdict === "escalate") escalations += 1;
    if (row.acted) autoApproved += 1;
    const human = row.acted ? null : row.human;
    if (human) {
      confusion[row.verdict][human] += 1;
      decided += 1;
      p.decided += 1;
      if (row.verdict !== "escalate") {
        sided += 1;
        p.sided += 1;
        if (agrees(row.verdict, human)) {
          agreed += 1;
          p.agreed += 1;
        }
      }
    } else {
      confusion[row.verdict].undecided += 1;
    }
    periods.set(key, p);
  }
  const approveDecided = confusion.approve.approved + confusion.approve.rejected;
  return {
    count: rows.length,
    decided,
    agreement: ratio(agreed, sided),
    approvePrecision: ratio(confusion.approve.approved, approveDecided),
    escalationRate: ratio(escalations, rows.length),
    autoApproved,
    confusion,
    periods: [...periods.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, p]) => ({
        period,
        count: p.count,
        decided: p.decided,
        agreed: p.agreed,
        agreement: ratio(p.agreed, p.sided),
      })),
  };
}
