// The policy adjudicator's verdict beside a pending action in the Approvals inbox (ADR 0204):
// approve / deny / escalate, its confidence and reason, whether it was a shadow verdict, and what
// it did in active mode. Only human approvers ever receive verdicts from the server.
import type { CoreOutput } from "@relationship-os/core";
import { Badge } from "@relationship-os/ui/components/badge";
import { cn } from "@relationship-os/ui/lib/utils";
import { GavelIcon } from "lucide-react";

type Verdict = NonNullable<CoreOutput<"approval.get">["actions"][number]["adjudication"]>;

const VERDICT_LABEL: Record<Verdict["verdict"], string> = {
  approve: "Recommends approve",
  deny: "Recommends reject",
  escalate: "Leaves it to you",
};

/** Why an active-mode verdict did not apply the change. */
const NOTE_LABEL: Record<string, string> = {
  deny: "it recommends rejecting, which only a person can do",
  escalate: "it was unsure",
  low_confidence: "its confidence is below the threshold",
  floor: "the deployment floor requires a person",
  always: "this kind of change always needs a person",
  risk: "it never applies outbound, schema or extension changes",
  dependency: "a change it depends on was not applied yet",
  unknown_source: "it could not tell why this needed review",
  invalid: "its reply was not a valid verdict",
  error: "the reviewer model failed",
};

export function VerdictNote({ verdict }: { verdict: Verdict }) {
  const confidence = `${Math.round(verdict.confidence * 100)}%`;
  const outcome =
    verdict.outcome === "approved"
      ? "Applied by the policy adjudicator."
      : verdict.outcome === "apply_failed"
        ? "The policy adjudicator approved it, but applying it failed."
        : verdict.outcome === "escalated" && verdict.note
          ? `Not applied automatically: ${NOTE_LABEL[verdict.note] ?? verdict.note}.`
          : null;
  return (
    <div
      className={cn(
        "grid gap-1 rounded-md border px-2.5 py-2 text-xs",
        verdict.verdict === "deny"
          ? "border-destructive/30 bg-destructive/5"
          : verdict.verdict === "approve"
            ? "border-emerald-500/30 bg-emerald-500/5"
            : "bg-muted/40",
      )}
      data-testid="adjudicator-verdict"
      data-verdict={verdict.verdict}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <GavelIcon className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="font-medium">Policy adjudicator: {VERDICT_LABEL[verdict.verdict]}</span>
        <span className="text-muted-foreground">({confidence} confident)</span>
        {verdict.mode === "shadow" && (
          <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
            shadow
          </Badge>
        )}
      </div>
      <p className="text-muted-foreground">{verdict.reason}</p>
      {outcome && <p className="text-muted-foreground">{outcome}</p>}
    </div>
  );
}
