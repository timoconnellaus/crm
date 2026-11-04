// The approval screen for an extension proposal (stage 3b, AC7): the AI-written summary (clearly
// labelled), the host-computed impact (schema changes, permissions requested or widened, host
// modules, tools, triggers), the check result, and the git diff per file, syntax-highlighted.
// Everything but the AI summary is computed by the host from the manifests and the reconcile plan.
import type { ExtensionImpact, FileDiff } from "@crm/core";
import { Badge } from "@crm/ui/components/badge";
import { Skeleton } from "@crm/ui/components/skeleton";
import { cn } from "@crm/ui/lib/utils";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  SparklesIcon,
  XCircleIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { errorMessage, useOp } from "#/lib/query";
import { highlightLine, type TokenKind } from "./highlight.ts";

const TOKEN_CLASS: Record<TokenKind, string> = {
  keyword: "text-purple-700 dark:text-purple-300",
  string: "text-green-800 dark:text-green-300",
  comment: "text-muted-foreground italic",
  number: "text-amber-700 dark:text-amber-300",
  type: "text-sky-700 dark:text-sky-300",
  plain: "",
};

interface CheckView {
  ok: boolean;
  issues: { stage: string; code: string; path: string; message: string; suggestion?: string }[];
}

export function ExtensionProposal({ actionId }: { actionId: string }) {
  const proposal = useOp("extension.proposal", { actionId }, { staleTime: 60_000 });
  if (proposal.isPending) return <Skeleton className="h-40" />;
  if (proposal.isError) {
    return (
      <p className="text-sm text-destructive" role="alert">
        Could not load the proposal: {errorMessage(proposal.error)}
      </p>
    );
  }
  const p = proposal.data;
  const impact = p.impact as unknown as ExtensionImpact;
  const diff = p.diff as FileDiff[];
  const check = p.check as unknown as CheckView;
  return (
    <div className="grid min-w-0 gap-3" data-testid="extension-proposal">
      <AiSummary summary={p.aiSummary} />
      <Impact impact={impact} />
      <CheckResult check={check} />
      <Diff diff={diff} />
    </div>
  );
}

function Section({
  title,
  children,
  testId,
}: {
  title: string;
  children: ReactNode;
  testId: string;
}) {
  return (
    <section className="grid min-w-0 gap-1.5" aria-label={title} data-testid={testId}>
      <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h4>
      {children}
    </section>
  );
}

function AiSummary({ summary }: { summary: { text: string; model: string | null } | null }) {
  return (
    <section
      className="grid gap-1.5 rounded-md border border-dashed bg-muted/30 p-2.5"
      aria-label="AI-written summary"
      data-testid="ai-summary"
    >
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="gap-1 rounded-sm px-1.5 font-normal">
          <SparklesIcon className="size-3" aria-hidden />
          AI-written
        </Badge>
        <span className="text-xs text-muted-foreground">
          {summary
            ? "Summary by the build model; check it against the impact and diff below."
            : "Summary"}
        </span>
      </div>
      <p className="text-sm whitespace-pre-wrap">
        {summary ? summary.text : "No AI summary available."}
      </p>
    </section>
  );
}

function List({ items, empty = "None" }: { items: string[]; empty?: string }) {
  if (!items.length) return <span className="text-muted-foreground">{empty}</span>;
  return (
    <ul className="flex flex-wrap gap-1">
      {items.map((item) => (
        <li key={item}>
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs break-all">{item}</code>
        </li>
      ))}
    </ul>
  );
}

const KIND_LABEL: Record<ExtensionImpact["kind"], string> = {
  install: "New extension",
  upgrade: "Upgrade",
  eject: "Eject (shipped → runtime)",
};

function Impact({ impact }: { impact: ExtensionImpact }) {
  const s = impact.schema;
  const perms = impact.permissions;
  const requested = [
    ...perms.requested.read.map((o) => `read ${o}`),
    ...perms.requested.write.map((o) => `write ${o}`),
    ...perms.requested.operations.map((o) => `call ${o}`),
  ];
  const widened = [
    ...perms.widened.read.map((o) => `read ${o}`),
    ...perms.widened.write.map((o) => `write ${o}`),
    ...perms.widened.operations.map((o) => `call ${o}`),
    ...perms.widened.modules.map((m) => `module ${m}`),
  ];
  const rows: [string, ReactNode][] = [
    [
      "Change",
      <span key="k">
        {KIND_LABEL[impact.kind]} · {impact.extension}{" "}
        {impact.previousVersion ? `${impact.previousVersion} → ` : ""}
        {impact.version}
      </span>,
    ],
    ["Risk", <List key="risk" items={impact.risks} />],
    ["New objects", <List key="o" items={s.newObjects} />],
    ["New fields", <List key="f" items={s.newFields} />],
  ];
  if (s.renames.length) rows.push(["Renamed", <List key="r" items={s.renames} />]);
  if (s.hidden.length) rows.push(["Hidden (data kept)", <List key="h" items={s.hidden} />]);
  if (s.restored.length) rows.push(["Restored", <List key="re" items={s.restored} />]);
  if (s.typeChanges.length) rows.push(["Type changes", <List key="t" items={s.typeChanges} />]);
  rows.push(["Permissions", <List key="p" items={requested} empty="Only its own objects" />]);
  if (perms.widens) {
    rows.push([
      "Widened",
      <div key="w" className="grid gap-1" data-testid="permissions-widened">
        <span className="text-amber-800 dark:text-amber-300">
          Asks for more than the installed version:
        </span>
        <List items={widened} />
      </div>,
    ]);
  }
  rows.push(["Host modules", <List key="m" items={impact.modules.map((m) => `codemode:${m}`)} />]);
  rows.push([
    "Tools",
    <List
      key="tl"
      items={impact.tools
        .filter((t) => t.change !== "unchanged")
        .map((t) => `${t.name} (${t.change}, ${t.risk})`)}
      empty={impact.tools.length ? "Unchanged" : "None"}
    />,
  ]);
  // Each automation's plain-English summary is generated by the host from its declarations
  // (ADR 0131), never by AI. Proposals stored before stage 5 have only the trigger.
  rows.push([
    "Automations",
    <div key="tr" className="grid gap-2" data-testid="extension-automations">
      {impact.triggers.length ? (
        impact.triggers.map((t) => (
          <div key={t.name} className="text-sm">
            <div className="font-medium">{t.label ?? t.name}</div>
            <div className="text-muted-foreground">{t.summary || t.trigger}</div>
          </div>
        ))
      ) : (
        <span className="text-muted-foreground text-sm">None</span>
      )}
      {impact.triggers.some((t) => t.summary) && (
        <span className="text-muted-foreground text-xs">
          Summaries are generated by the CRM from the declared trigger, conditions and steps.
        </span>
      )}
    </div>,
  ]);
  return (
    <Section title="Impact (computed by the CRM)" testId="extension-impact">
      {impact.warnings.length > 0 && (
        <ul className="grid gap-1">
          {impact.warnings.map((w) => (
            <li
              key={w}
              className="flex items-start gap-1.5 text-sm text-amber-800 dark:text-amber-300"
            >
              <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
              {w}
            </li>
          ))}
        </ul>
      )}
      <dl className="grid gap-x-3 gap-y-1.5 rounded-md border p-2.5 text-sm sm:grid-cols-[9rem_1fr]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-xs text-muted-foreground sm:text-sm">{label}</dt>
            <dd className="min-w-0">{value}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function CheckResult({ check }: { check: CheckView }) {
  return (
    <Section title="Check" testId="extension-check">
      {check.ok ? (
        <p className="flex items-center gap-1.5 text-sm text-green-800 dark:text-green-300">
          <CheckCircle2Icon className="size-4" aria-hidden />
          Check passed: types, contract, formulas and a dry-run of the schema changes.
        </p>
      ) : (
        <div className="grid gap-1">
          <p className="flex items-center gap-1.5 text-sm text-destructive">
            <XCircleIcon className="size-4" aria-hidden />
            Check failed
          </p>
          <ul className="grid gap-0.5 text-xs">
            {check.issues.map((i) => (
              <li key={`${i.stage}:${i.path}:${i.message}`}>
                <span className="font-mono">{i.path}</span>: {i.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

function Diff({ diff }: { diff: FileDiff[] }) {
  const additions = diff.reduce((n, f) => n + f.additions, 0);
  const deletions = diff.reduce((n, f) => n + f.deletions, 0);
  return (
    <Section
      title={`Code changes · ${diff.length} file${diff.length === 1 ? "" : "s"} · +${additions} −${deletions}`}
      testId="extension-diff"
    >
      {diff.length === 0 && <p className="text-sm text-muted-foreground">No file changes.</p>}
      <div className="grid gap-2">
        {diff.map((file) => (
          <FileView key={file.path} file={file} />
        ))}
      </div>
    </Section>
  );
}

const STATUS_LABEL: Record<FileDiff["status"], string> = {
  added: "new",
  modified: "modified",
  deleted: "deleted",
};

function FileView({ file }: { file: FileDiff }) {
  const [open, setOpen] = useState(true);
  return (
    <div
      className="min-w-0 overflow-hidden rounded-md border"
      data-testid="diff-file"
      data-path={file.path}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 bg-muted/40 px-2.5 py-1.5 text-left text-xs"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRightIcon
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
        <span className="text-muted-foreground">{STATUS_LABEL[file.status]}</span>
        <span className="text-green-700 dark:text-green-400">+{file.additions}</span>
        <span className="text-red-700 dark:text-red-400">−{file.deletions}</span>
      </button>
      {open && (
        <div className="max-h-[32rem] overflow-auto">
          <table className="w-full border-collapse font-mono text-xs leading-5">
            <tbody>
              {file.hunks.map((hunk) => (
                <HunkRows key={`${hunk.oldStart}:${hunk.newStart}`} hunk={hunk} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function HunkRows({ hunk }: { hunk: FileDiff["hunks"][number] }) {
  return (
    <>
      <tr className="bg-sky-50 text-muted-foreground dark:bg-sky-500/10">
        <td colSpan={3} className="px-2 select-none">
          @@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
        </td>
      </tr>
      {hunk.lines.map((line, i) => (
        <tr
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no other identity.
          key={i}
          className={cn(
            line.op === "+" && "bg-green-50 dark:bg-green-500/10",
            line.op === "-" && "bg-red-50 dark:bg-red-500/10",
          )}
          data-op={line.op}
        >
          <td className="w-8 px-1.5 text-right text-muted-foreground select-none">
            {line.old ?? ""}
          </td>
          <td className="w-8 px-1.5 text-right text-muted-foreground select-none">
            {line.new ?? ""}
          </td>
          <td className="px-2 whitespace-pre">
            <span className="select-none text-muted-foreground">
              {line.op === " " ? " " : line.op}
            </span>
            {highlightLine(line.text).map((t, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: tokens of one line in order.
              <span key={j} className={TOKEN_CLASS[t.kind]}>
                {t.text}
              </span>
            ))}
          </td>
        </tr>
      ))}
    </>
  );
}
