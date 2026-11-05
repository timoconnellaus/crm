// Small pieces the automation pages share: the status pill, a run's coloured outcome, the
// reference design's titled cards, and the test-mode result.
import type { AutomationTestReport } from "@relationship-os/core";
import { cn } from "@relationship-os/ui/lib/utils";
import type { ReactNode } from "react";
import {
  type AutomationStatus,
  type RunOutcomeInput,
  runOutcome,
  STATUS_LABELS,
  statusTone,
  TONE_PILL,
  TONE_TEXT,
  testReportLines,
} from "./model.ts";

export function StatusPill({
  status,
  className,
}: {
  status: AutomationStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        TONE_PILL[statusTone(status)],
        className,
      )}
      data-name="status"
      data-testid="automation-status"
      data-status={status}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

export function RunOutcome({ run, className }: { run: RunOutcomeInput; className?: string }) {
  const { text, tone } = runOutcome(run);
  return (
    <span className={cn(TONE_TEXT[tone], className)} data-tone={tone} data-testid="run-outcome">
      {text}
    </span>
  );
}

/** A card with the reference's small uppercase heading. */
export function InfoCard({
  title,
  name,
  children,
  className,
  action,
}: {
  title: ReactNode;
  /** The reference design's data-name. */
  name: string;
  children: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  const id = `card-${name.replace(/\s+/g, "-")}`;
  return (
    <section
      className={cn("min-w-0 rounded-xl border bg-card p-4 text-card-foreground", className)}
      data-name={name}
      data-testid={id}
      aria-labelledby={`${id}-title`}
    >
      <div className="mb-2.5 flex items-center gap-2">
        <h2
          id={`${id}-title`}
          className="min-w-0 flex-1 truncate text-xs font-medium tracking-wide text-muted-foreground uppercase"
        >
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** The test-mode result block: one line per would-be effect. */
export function TestReportView({ report }: { report: AutomationTestReport }) {
  const lines = testReportLines(report);
  return (
    <div className="grid gap-0.5 rounded-lg bg-muted/60 p-3 text-sm" data-testid="test-report">
      {lines.map((line, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: lines are a fixed rendering of one report
          key={i}
          className={cn(
            line.muted && "text-muted-foreground",
            line.kind === "nomatch" || line.kind === "error" ? TONE_TEXT.fail : undefined,
          )}
          data-kind={line.kind}
        >
          {line.parts.map((part, j) =>
            part.strong ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: parts of a fixed line
              <b key={j} className="font-semibold">
                {part.text}
              </b>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: parts of a fixed line
              <span key={j}>{part.text}</span>
            ),
          )}
        </div>
      ))}
    </div>
  );
}
