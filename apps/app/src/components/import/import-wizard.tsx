// CSV import wizard over import.csv.preview / import.csv.commit (ADR 0020: the CSV travels inline,
// up to 10 MB / 20,000 rows, and both steps are stateless):
//   1. Source: people or organisations, then upload a file or paste CSV text
//   2. Columns: map each column to a field (suggested from the headers) or ignore it
//   3. Review: per-row create / update / skip with overrides, and how duplicates were found
//   4. Import: one commit (all rows in one transaction), then a summary
import type { CoreOutput } from "@crm/core";
import { Badge } from "@crm/ui/components/badge";
import { Button } from "@crm/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@crm/ui/components/card";
import { Label } from "@crm/ui/components/label";
import { Textarea } from "@crm/ui/components/textarea";
import { cn } from "@crm/ui/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  FileUpIcon,
  InfoIcon,
  Loader2Icon,
  ShieldAlertIcon,
} from "lucide-react";
import { type ChangeEvent, type ReactNode, useMemo, useState } from "react";
import { callOp, OperationCallError } from "#/lib/operations";
import { errorMessage, invalidateOps } from "#/lib/query";
import { byteSize, formatBytes, IMPORT_LIMITS, readCsvRows } from "./csv.ts";

export type ImportObject = "person" | "organisation";
type Preview = CoreOutput<"import.csv.preview">;
type PreviewRow = Preview["rows"][number];
type Commit = CoreOutput<"import.csv.commit">;
type Action = PreviewRow["action"];
type Mapping = Record<string, string | null>;

const STEPS = ["Source", "Columns", "Review", "Import"] as const;
const PAGE_SIZE = 50;

const OBJECTS: Record<
  ImportObject,
  { label: string; many: string; list: "/people" | "/organisations" }
> = {
  person: { label: "People", many: "people", list: "/people" },
  organisation: { label: "Organisations", many: "organisations", list: "/organisations" },
};

const DEDUPE_HELP: Record<ImportObject, string> = {
  person:
    "Rows are matched to existing people by email address. A matched row updates that person: it fills in the fields you mapped and adds new emails, phones and tags. Rows without a match create a person. A row repeating an email from an earlier row is skipped. The organisation column is matched by domain, then by name, or creates the organisation, and the person gets a current affiliation with the job title.",
  organisation:
    "Rows are matched to existing organisations by domain (by name when a row has no domain). A matched row updates that organisation; others create one. A row repeating a domain from an earlier row is skipped.",
};

/** A user-facing message for an import failure, explaining approval-policy outcomes. */
function importError(error: unknown): { message: string; gate: boolean } {
  if (error instanceof OperationCallError) {
    if (error.code === "denied") {
      return {
        message:
          "The approval policy does not allow this import. Ask an admin to review the approval policy, or import fewer rows at a time.",
        gate: true,
      };
    }
    if (error.code === "review_not_supported") {
      return {
        message:
          "This import is above the policy's bulk threshold and needs approval, and approvals are not available yet. Import fewer rows at a time, or ask an admin to change the approval policy.",
        gate: true,
      };
    }
    if (error.code === "forbidden") {
      return { message: "Your role cannot import records.", gate: true };
    }
  }
  return { message: errorMessage(error), gate: false };
}

export function ImportWizard({ initialObject = "person" }: { initialObject?: ImportObject }) {
  const client = useQueryClient();
  const [step, setStep] = useState(0);
  const [object, setObject] = useState<ImportObject>(initialObject);
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Mapping>({});
  const [plan, setPlan] = useState<Preview | null>(null);
  const [overrides, setOverrides] = useState<Record<number, Action>>({});
  const [result, setResult] = useState<Commit | null>(null);
  const [pending, setPending] = useState<null | "preview" | "commit">(null);
  const [error, setError] = useState<{ message: string; gate: boolean } | null>(null);

  const sample = useMemo(() => (csv ? readCsvRows(csv, 6) : []), [csv]);

  async function runPreview(next: Mapping | undefined, then: number) {
    setPending("preview");
    setError(null);
    try {
      const preview = await callOp("import.csv.preview", {
        object,
        csv,
        ...(next ? { mapping: next } : {}),
      });
      setPlan(preview);
      setMapping(preview.mapping);
      setOverrides({});
      setStep(then);
    } catch (caught) {
      setError(importError(caught));
    } finally {
      setPending(null);
    }
  }

  async function runCommit() {
    if (!plan) return;
    setPending("commit");
    setError(null);
    const changed = Object.fromEntries(
      plan.rows
        .filter((r) => overrides[r.row] && overrides[r.row] !== r.action)
        .map((r) => [String(r.row), overrides[r.row] as Action]),
    );
    try {
      const committed = await callOp("import.csv.commit", {
        object,
        csv,
        mapping,
        ...(Object.keys(changed).length ? { overrides: changed } : {}),
      });
      setResult(committed);
      setStep(3);
      await Promise.all(
        ["person.", "organisation.", "affiliation.", "search."].map((p) =>
          invalidateOps(client, p),
        ),
      );
    } catch (caught) {
      setError(importError(caught));
    } finally {
      setPending(null);
    }
  }

  function restart() {
    setStep(0);
    setCsv("");
    setFileName(null);
    setPlan(null);
    setMapping({});
    setOverrides({});
    setResult(null);
    setError(null);
  }

  return (
    <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-4">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Import CSV</h1>
        <p className="text-sm text-muted-foreground">
          Bring people or organisations in from a spreadsheet. Nothing changes until the last step.
        </p>
      </div>
      <ol className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="Import steps">
        {STEPS.map((label, i) => (
          <li
            key={label}
            aria-current={i === step ? "step" : undefined}
            className={cn(
              "flex items-center gap-1.5",
              i === step ? "font-medium" : "text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "flex size-5 items-center justify-center rounded-full border text-xs",
                i < step && "border-primary bg-primary text-primary-foreground",
                i === step && "border-primary",
              )}
            >
              {i + 1}
            </span>
            {label}
          </li>
        ))}
      </ol>

      {error && (
        <div
          role="alert"
          data-testid="import-error"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm"
        >
          {error.gate ? (
            <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          ) : (
            <InfoIcon className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          )}
          <span>{error.message}</span>
        </div>
      )}

      {step === 0 && (
        <SourceStep
          object={object}
          onObjectChange={setObject}
          csv={csv}
          fileName={fileName}
          onCsv={(text, name) => {
            setCsv(text);
            setFileName(name);
            setError(null);
          }}
          rows={sample.length}
          pending={pending === "preview"}
          onNext={() => void runPreview(undefined, 1)}
        />
      )}
      {step === 1 && plan && (
        <MappingStep
          plan={plan}
          sample={sample}
          mapping={mapping}
          onChange={setMapping}
          pending={pending === "preview"}
          onBack={() => setStep(0)}
          onNext={() => void runPreview(mapping, 2)}
        />
      )}
      {step === 2 && plan && (
        <ReviewStep
          object={object}
          plan={plan}
          overrides={overrides}
          onOverride={(row, action) => setOverrides((o) => ({ ...o, [row]: action }))}
          pending={pending === "commit"}
          onBack={() => setStep(1)}
          onCommit={() => void runCommit()}
        />
      )}
      {step === 3 && result && <ResultStep object={object} result={result} onRestart={restart} />}
    </div>
  );
}

// --- 1. Source ---------------------------------------------------------------------------------

function SourceStep({
  object,
  onObjectChange,
  csv,
  fileName,
  onCsv,
  rows,
  pending,
  onNext,
}: {
  object: ImportObject;
  onObjectChange: (object: ImportObject) => void;
  csv: string;
  fileName: string | null;
  onCsv: (text: string, name: string | null) => void;
  rows: number;
  pending: boolean;
  onNext: () => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const tooBig = csv.length > IMPORT_LIMITS.maxBytes;

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setProblem(null);
    if (file.size > IMPORT_LIMITS.maxBytes) {
      setProblem(`${file.name} is ${formatBytes(file.size)}; the limit is 10 MB.`);
      return;
    }
    onCsv(await file.text(), file.name);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">What are you importing?</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-5">
        <div
          className="grid grid-cols-1 gap-2 sm:grid-cols-2"
          role="radiogroup"
          aria-label="Import type"
        >
          {(Object.keys(OBJECTS) as ImportObject[]).map((key) => (
            // biome-ignore lint/a11y/useSemanticElements: a card-style radio.
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={object === key}
              onClick={() => onObjectChange(key)}
              className={cn(
                "grid gap-0.5 rounded-md border p-3 text-left hover:bg-accent",
                object === key && "border-primary ring-2 ring-primary/30",
              )}
            >
              <span className="font-medium">{OBJECTS[key].label}</span>
              <span className="text-xs text-muted-foreground">
                {key === "person"
                  ? "Deduped by email. An organisation column links them to organisations."
                  : "Deduped by domain, or by name without one."}
              </span>
            </button>
          ))}
        </div>

        <div className="grid min-w-0 grid-cols-1 gap-2">
          <Label htmlFor="import-file">Upload a CSV file</Label>
          <label
            htmlFor="import-file"
            className="flex cursor-pointer items-center gap-3 rounded-md border border-dashed px-4 py-5 text-sm hover:bg-accent"
          >
            <FileUpIcon className="size-5 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate">
              {fileName ?? "Choose a .csv file (comma, semicolon or tab separated, up to 10 MB)"}
            </span>
          </label>
          <input
            id="import-file"
            type="file"
            accept=".csv,.tsv,.txt,text/csv,text/plain"
            className="sr-only"
            onChange={(event) => void onFile(event)}
          />
        </div>

        <div className="grid min-w-0 grid-cols-1 gap-2">
          <Label htmlFor="import-paste">Or paste CSV text</Label>
          <Textarea
            id="import-paste"
            value={fileName ? "" : csv}
            placeholder={"name,email,company\nAda Lovelace,ada@example.com,Analytical Engines"}
            onChange={(event) => onCsv(event.target.value, null)}
            className="max-h-64 min-h-28 font-mono text-xs"
            spellCheck={false}
          />
        </div>

        {(problem || tooBig) && (
          <p role="alert" className="text-sm text-destructive">
            {problem ?? `This CSV is ${formatBytes(byteSize(csv))}; the limit is 10 MB.`}
          </p>
        )}
        {csv && !tooBig && (
          <p className="text-sm text-muted-foreground" data-testid="import-source-summary">
            {formatBytes(byteSize(csv))}
            {rows > 0 &&
              `, ${rows >= 6 ? "header and more than 5 rows" : `${Math.max(rows - 1, 0)} data rows`}`}
          </p>
        )}
        <div className="flex justify-end">
          <Button onClick={onNext} disabled={!csv.trim() || tooBig || pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            {pending ? "Reading…" : "Continue"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// --- 2. Mapping --------------------------------------------------------------------------------

const IGNORE = "";

function MappingStep({
  plan,
  sample,
  mapping,
  onChange,
  pending,
  onBack,
  onNext,
}: {
  plan: Preview;
  sample: string[][];
  mapping: Mapping;
  onChange: (mapping: Mapping) => void;
  pending: boolean;
  onBack: () => void;
  onNext: () => void;
}) {
  const fields = plan.fields;
  const header = sample[0] ?? plan.headers;
  const counts = new Map<string, number>();
  for (const field of Object.values(mapping))
    if (field) counts.set(field, (counts.get(field) ?? 0) + 1);
  const clash = fields.filter((f) => !f.multi && (counts.get(f.name) ?? 0) > 1);
  const mapped = Object.values(mapping).filter(Boolean).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Match columns to fields</CardTitle>
        <p className="text-sm text-muted-foreground">
          Suggestions come from the column headers. Ignored columns are not imported.
        </p>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4">
        <ul className="grid grid-cols-1 gap-2" aria-label="Column mapping">
          {plan.headers.map((column) => {
            const index = header.indexOf(column);
            const examples = sample
              .slice(1)
              .map((row) => row[index] ?? "")
              .filter(Boolean)
              .slice(0, 3);
            const value = mapping[column] ?? IGNORE;
            const suggested = plan.suggestions[column] ?? null;
            const id = `map-${column.replace(/[^a-zA-Z0-9]/g, "-")}`;
            return (
              <li
                key={column}
                className="grid gap-2 rounded-md border p-3 sm:grid-cols-[minmax(0,1fr)_14rem] sm:items-center"
              >
                <div className="grid min-w-0 gap-0.5">
                  <Label htmlFor={id} className="truncate font-medium">
                    {column}
                  </Label>
                  <span className="truncate text-xs text-muted-foreground">
                    {examples.length ? examples.join(" · ") : "No values in the first rows"}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    id={id}
                    aria-label={`Field for column ${column}`}
                    value={value}
                    onChange={(event) =>
                      onChange({ ...mapping, [column]: event.target.value || null })
                    }
                    className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                  >
                    <option value={IGNORE}>Ignore</option>
                    {fields.map((field) => (
                      <option key={field.name} value={field.name}>
                        {field.label}
                      </option>
                    ))}
                  </select>
                  {suggested && suggested === value && (
                    <Badge variant="secondary" title="Suggested from the header">
                      Suggested
                    </Badge>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {clash.length > 0 && (
          <p role="alert" className="text-sm text-destructive">
            {clash.map((f) => f.label).join(", ")} can come from one column only.
          </p>
        )}
        <div className="flex flex-wrap justify-between gap-2">
          <Button variant="outline" onClick={onBack}>
            <ArrowLeftIcon />
            Back
          </Button>
          <Button onClick={onNext} disabled={pending || clash.length > 0 || mapped === 0}>
            {pending && <Loader2Icon className="animate-spin" />}
            {pending ? "Checking rows…" : "Review rows"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// --- 3. Review ---------------------------------------------------------------------------------

const ACTION_LABEL: Record<Action, string> = { create: "Create", update: "Update", skip: "Skip" };
const ACTION_BADGE: Record<Action, "default" | "secondary" | "outline"> = {
  create: "default",
  update: "secondary",
  skip: "outline",
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function rowTitle(object: ImportObject, row: PreviewRow): { title: string; detail: string } {
  const v = row.values;
  if (object === "person") {
    const name =
      first(v.displayName) ??
      ([first(v.givenName), first(v.familyName)].filter(Boolean).join(" ") || undefined);
    const emails = Array.isArray(v.emails) ? v.emails : [];
    return { title: name ?? emails[0] ?? "—", detail: emails.join(", ") };
  }
  const domains = Array.isArray(v.domains) ? v.domains : [];
  return { title: first(v.name) ?? domains[0] ?? "—", detail: domains.join(", ") };
}

function ReviewStep({
  object,
  plan,
  overrides,
  onOverride,
  pending,
  onBack,
  onCommit,
}: {
  object: ImportObject;
  plan: Preview;
  overrides: Record<number, Action>;
  onOverride: (row: number, action: Action) => void;
  pending: boolean;
  onBack: () => void;
  onCommit: () => void;
}) {
  const [filter, setFilter] = useState<Action | "all">("all");
  const [page, setPage] = useState(0);
  const actionOf = (r: PreviewRow) => overrides[r.row] ?? r.action;
  const counts = { create: 0, update: 0, skip: 0 };
  for (const r of plan.rows) counts[actionOf(r)]++;
  const shown = plan.rows.filter((r) => filter === "all" || actionOf(r) === filter);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const current = shown.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const writes = counts.create + counts.update;
  const noun = OBJECTS[object].many;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Review {plan.counts.total} rows</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4">
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="import-counts">
          <Stat label="Create" value={counts.create} />
          <Stat label="Update" value={counts.update} />
          <Stat label="Skip" value={counts.skip} />
          {object === "person" && (
            <Stat
              label="Organisations"
              value={plan.counts.organisationsCreated + plan.counts.organisationsMatched}
              detail={`${plan.counts.organisationsCreated} new, ${plan.counts.organisationsMatched} matched`}
            />
          )}
        </dl>
        <div className="flex items-start gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          <InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p data-testid="dedupe-help">{DEDUPE_HELP[object]}</p>
        </div>

        <fieldset className="flex flex-wrap items-center gap-1" aria-label="Show rows">
          {(["all", "create", "update", "skip"] as const).map((key) => (
            <Button
              key={key}
              size="sm"
              variant={filter === key ? "secondary" : "ghost"}
              aria-pressed={filter === key}
              onClick={() => {
                setFilter(key);
                setPage(0);
              }}
            >
              {key === "all" ? "All" : ACTION_LABEL[key]}{" "}
              <span className="text-muted-foreground">
                {key === "all" ? plan.rows.length : counts[key]}
              </span>
            </Button>
          ))}
        </fieldset>

        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[40rem] text-sm" aria-label="Import rows">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="w-12 px-3 py-2 font-medium">Row</th>
                <th className="px-3 py-2 font-medium">
                  {object === "person" ? "Person" : "Organisation"}
                </th>
                {object === "person" && <th className="px-3 py-2 font-medium">Organisation</th>}
                <th className="w-32 px-3 py-2 font-medium">Decision</th>
                <th className="px-3 py-2 font-medium">Why</th>
              </tr>
            </thead>
            <tbody>
              {current.map((r) => {
                const { title, detail } = rowTitle(object, r);
                const action = actionOf(r);
                return (
                  <tr key={r.row} className="border-t align-top" data-testid="import-row">
                    <td className="px-3 py-2 text-muted-foreground">{r.row}</td>
                    <td className="max-w-64 px-3 py-2">
                      <div className="truncate font-medium">{title}</div>
                      {detail && (
                        <div className="truncate text-xs text-muted-foreground">{detail}</div>
                      )}
                    </td>
                    {object === "person" && (
                      <td className="max-w-48 px-3 py-2">
                        {r.organisation ? (
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate">{r.organisation.name}</span>
                            <Badge variant="outline">
                              {r.organisation.action === "match" ? "existing" : "new"}
                            </Badge>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    )}
                    <td className="px-3 py-2">
                      {r.options.length > 1 ? (
                        <select
                          aria-label={`Row ${r.row} decision`}
                          value={action}
                          onChange={(event) => onOverride(r.row, event.target.value as Action)}
                          className="h-8 w-full rounded-md border border-input bg-background px-1.5 text-sm"
                        >
                          {r.options.map((option) => (
                            <option key={option} value={option}>
                              {ACTION_LABEL[option]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Badge variant={ACTION_BADGE[action]} aria-label={`Row ${r.row} decision`}>
                          {ACTION_LABEL[action]}
                        </Badge>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {action === "update" && r.matchId ? (
                        <>
                          {r.reason}
                          {": "}
                          <Link
                            to={object === "person" ? "/people/$id" : "/organisations/$id"}
                            params={{ id: r.matchId }}
                            className="underline"
                            target="_blank"
                          >
                            existing record
                          </Link>
                          {". "}
                          {r.changes.length ? `Changes ${r.changes.join(", ")}.` : "No changes."}
                        </>
                      ) : action === "skip" && r.suggested !== "skip" ? (
                        "Skipped by you."
                      ) : (
                        (r.reason ?? (action === "create" ? "New record." : ""))
                      )}
                    </td>
                  </tr>
                );
              })}
              {current.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                    No rows.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {pages > 1 && (
          <div className="flex items-center justify-end gap-2 text-sm">
            <Button
              size="sm"
              variant="outline"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              Previous
            </Button>
            <span className="text-muted-foreground">
              Page {page + 1} of {pages}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= pages - 1}
              onClick={() => setPage(page + 1)}
            >
              Next
            </Button>
          </div>
        )}

        {pending && (
          <div
            className="grid gap-1.5"
            role="status"
            aria-live="polite"
            data-testid="import-progress"
          >
            <span className="text-sm">
              Importing {writes} {noun}… all rows are written in one transaction.
            </span>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full w-1/3 animate-[import-progress_1.2s_ease-in-out_infinite] rounded-full bg-primary" />
            </div>
            <style>
              {
                "@keyframes import-progress{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}"
              }
            </style>
          </div>
        )}
        <div className="flex flex-wrap justify-between gap-2">
          <Button variant="outline" onClick={onBack} disabled={pending}>
            <ArrowLeftIcon />
            Back
          </Button>
          <Button onClick={onCommit} disabled={pending || writes === 0}>
            {pending && <Loader2Icon className="animate-spin" />}
            {pending ? "Importing…" : `Import ${writes} ${writes === 1 ? "row" : "rows"}`}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, detail }: { label: string; value: number; detail?: ReactNode }) {
  return (
    <div className="rounded-md border px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className="text-xl font-semibold tabular-nums"
        data-testid={`count-${label.toLowerCase()}`}
      >
        {value}
      </dd>
      {detail && <dd className="text-xs text-muted-foreground">{detail}</dd>}
    </div>
  );
}

// --- 4. Result ---------------------------------------------------------------------------------

function ResultStep({
  object,
  result,
  onRestart,
}: {
  object: ImportObject;
  result: Commit;
  onRestart: () => void;
}) {
  const { counts } = result;
  const skipped = result.rows.filter((r) => r.action === "skip");
  return (
    <Card data-testid="import-result">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CheckCircle2Icon className="size-5 text-primary" aria-hidden />
          Import complete
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4">
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Created" value={counts.create} />
          <Stat label="Updated" value={counts.update} />
          <Stat label="Skipped" value={counts.skip} />
          {object === "person" && (
            <Stat
              label="New organisations"
              value={counts.organisationsCreated}
              detail={`${counts.organisationsMatched} matched`}
            />
          )}
        </dl>
        {skipped.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">
              Why {skipped.length} {skipped.length === 1 ? "row was" : "rows were"} skipped
            </summary>
            <ul className="mt-2 grid gap-1">
              {skipped.slice(0, 200).map((r) => (
                <li key={r.row}>
                  Row {r.row}: {r.reason ?? "skipped by you"}
                </li>
              ))}
            </ul>
          </details>
        )}
        <p className="text-sm text-muted-foreground">
          Every created and updated record has an entry in its History.
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={onRestart}>
            Import another file
          </Button>
          <Button asChild>
            <Link to={OBJECTS[object].list}>Go to {OBJECTS[object].label}</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
