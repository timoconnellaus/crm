// AI summaries in the UI (ADR 0153): the "AI-generated" badge every AI output carries, a hook over
// summary.get / summary.generate for one subject (a record, a meeting's prep brief, a change set),
// and the cards and panels that show them. summary.get never calls a model; generating is always
// a click.
import type { CoreInput, CoreOutput } from "@crm/core";
import { Badge } from "@crm/ui/components/badge";
import { Button } from "@crm/ui/components/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@crm/ui/components/card";
import { Skeleton } from "@crm/ui/components/skeleton";
import { cn } from "@crm/ui/lib/utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCwIcon, SparklesIcon } from "lucide-react";
import { useEffect } from "react";
import { formatDateTime } from "#/lib/format";
import { callOp } from "#/lib/operations";
import { errorMessage, opKey, useOp } from "#/lib/query";

export type SummarySubject = CoreInput<"summary.get">["subject"];
type Summary = CoreOutput<"summary.get">;

/** The label on every piece of AI output. */
export function AiGeneratedBadge({ className }: { className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn("gap-1 font-normal text-muted-foreground", className)}
      data-testid="ai-generated"
    >
      <SparklesIcon aria-hidden />
      AI-generated
    </Badge>
  );
}

/**
 * The cached summary of `subject` (summary.get, no model call) and `generate` (summary.generate),
 * which writes its result straight into the cached query rather than refetching everything a
 * write would.
 */
export function useSummary(subject: SummarySubject, { enabled = true } = {}) {
  const client = useQueryClient();
  const input = { subject };
  const query = useOp("summary.get", input, { enabled, staleTime: 30_000 });
  const generate = useMutation<Summary, Error, void>({
    mutationFn: () => callOp("summary.generate", input),
    onSuccess: (summary) => client.setQueryData(opKey("summary.get", input), summary),
  });
  return { query, generate, summary: query.data };
}

/**
 * A summary's text with its badge, stale hint and generate button: shared by the record card,
 * meeting prep and change-set explanations.
 */
export function SummaryBody({
  subject,
  generateLabel,
  enabled = true,
  autoGenerate = false,
  testId,
}: {
  subject: SummarySubject;
  /** Button text when there is no summary yet. */
  generateLabel: string;
  enabled?: boolean;
  /** Generate on open when nothing is cached (meeting prep: the dialog was asked for). */
  autoGenerate?: boolean;
  testId?: string;
}) {
  const { query, generate, summary } = useSummary(subject, { enabled });
  const text = summary?.text ?? null;
  const unavailable = summary?.status === "unavailable";
  const shouldAuto = Boolean(autoGenerate && summary?.status === "missing" && generate.isIdle);
  const { mutate } = generate;
  useEffect(() => {
    if (shouldAuto) mutate();
  }, [shouldAuto, mutate]);

  if (query.isPending) return <Skeleton className="h-16 w-full" />;
  if (query.isError) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {errorMessage(query.error)}
      </p>
    );
  }
  return (
    <div className="grid gap-2" data-testid={testId} data-status={summary?.status}>
      {text ? (
        <div className="grid gap-1.5">
          <AiGeneratedBadge />
          <p className="text-sm whitespace-pre-line" data-testid="summary-text">
            {text}
          </p>
          {summary?.generatedAt && (
            <p className="text-xs text-muted-foreground">
              {formatDateTime(summary.generatedAt)}
              {summary.model ? ` · ${summary.model}` : ""}
            </p>
          )}
        </div>
      ) : generate.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : unavailable ? null : (
        <p className="text-sm text-muted-foreground">No summary yet.</p>
      )}
      {summary?.status === "stale" && (
        <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="summary-stale">
          Stale — things changed since this was written. Refresh to update it.
        </p>
      )}
      {unavailable ? (
        <p className="text-sm text-muted-foreground" data-testid="summary-unavailable">
          AI is not configured for this workspace.
        </p>
      ) : (
        <div>
          <Button
            variant="outline"
            size="sm"
            disabled={generate.isPending}
            onClick={() => generate.mutate()}
          >
            {text ? <RefreshCwIcon /> : <SparklesIcon />}
            {generate.isPending ? "Writing…" : text ? "Refresh" : generateLabel}
          </Button>
        </div>
      )}
      {generate.isError && (
        <p className="text-sm text-destructive" role="alert">
          {errorMessage(generate.error)}
        </p>
      )}
    </div>
  );
}

/** "Explain these changes" on a change set in the Approvals inbox: a plain-English description. */
export function ChangeSetExplanation({ changeSetId }: { changeSetId: string }) {
  const { generate, summary } = useSummary({ kind: "changeset", id: changeSetId });
  if (summary?.status === "unavailable" && !summary.text) return null;
  const text = summary?.text ?? null;
  return (
    <div className="grid gap-2 border-b px-3.5 py-2.5" data-testid="change-set-explanation">
      {text && (
        <div className="grid gap-1.5">
          <AiGeneratedBadge />
          <p className="text-sm whitespace-pre-line" data-testid="summary-text">
            {text}
          </p>
          {summary?.status === "stale" && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Stale — the changes moved on since this was written.
            </p>
          )}
        </div>
      )}
      {(!text || summary?.status === "stale") && summary?.status !== "unavailable" && (
        <div>
          <Button
            variant="ghost"
            size="sm"
            disabled={generate.isPending || !summary}
            onClick={() => generate.mutate()}
          >
            <SparklesIcon />
            {generate.isPending ? "Explaining…" : text ? "Explain again" : "Explain these changes"}
          </Button>
        </div>
      )}
      {generate.isError && (
        <p className="text-sm text-destructive" role="alert">
          {errorMessage(generate.error)}
        </p>
      )}
    </div>
  );
}

/** The Summary card on person, organisation and deal pages. */
export function RecordSummaryCard({
  object,
  id,
}: {
  object: "person" | "organisation" | "deals.deal";
  id: string;
}) {
  return (
    <Card className="gap-3 py-4" data-testid="record-summary">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Summary</CardTitle>
        <CardAction>
          <SparklesIcon className="size-4 text-muted-foreground" aria-hidden />
        </CardAction>
      </CardHeader>
      <CardContent className="px-4">
        <SummaryBody subject={{ kind: "record", object, id }} generateLabel="Summarise" />
      </CardContent>
    </Card>
  );
}
