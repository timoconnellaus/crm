// Running one dashboard prompt, in either mode:
//
// - agent:    an MCP client model gets a fresh MCP connection, the server's instructions plus the
//             widget guidance the in-app box gives its model, and builds the widget with the
//             CRM's tools, finishing with widget.preview (reached through call_operation).
// - describe: the in-app "Describe a widget" box (widget.describe) reproduced with the eval model:
//             describePrompt's messages go to the model with no tools, the JSON answer is parsed
//             with extractJson and previewed over MCP, and one failure goes back to the model
//             with the error, exactly as the operation does.
//
// Either way the final widget is then re-run through widget.preview on a separate grader
// connection and graded (lib/grading.ts). Dashboards the model saved are deleted afterwards.
import { type ModelClient, runAgent } from "@relationship-os/evals-mcp/lib/agent.ts";
import { toOpenAiTools } from "@relationship-os/evals-mcp/lib/convert.ts";
import { callLabel, callMatches } from "@relationship-os/evals-mcp/lib/grading.ts";
import { systemPrompt, todayUtc } from "@relationship-os/evals-mcp/lib/harness.ts";
import { isPending, type McpSession, parseResult } from "@relationship-os/evals-mcp/lib/mcp.ts";
import {
  type ChatMessage,
  type ModelParams,
  samplingFields,
} from "@relationship-os/evals-mcp/lib/model.ts";
import type { DashboardTask } from "../prompts.ts";
import type { DashboardFilter, DashboardsCore, WidgetSpec } from "./core.ts";
import {
  type Candidate,
  createdDashboards,
  type Failure,
  finalCandidate,
  type GraderPreview,
  gradeCandidate,
  previewWidget,
} from "./grading.ts";

export type Mode = "agent" | "describe";
export const MODES: Mode[] = ["agent", "describe"];

export interface DashboardResult {
  id: string;
  title: string;
  prompt: string;
  mode: Mode;
  accept: string[];
  passed: boolean;
  failures: Failure[];
  /** Not failures, but worth knowing (a fallback widget source, cleanup trouble). */
  notes: string[];
  /** The widget graded, with the filters it was previewed with. */
  candidate: Candidate | null;
  /** The grader's preview: columns, row count and the first rows, or the error. */
  preview:
    | { ok: true; columns: string[]; rowCount: number; truncated: boolean; sample: unknown[] }
    | { ok: false; error: string }
    | null;
  /** widget.preview calls the model made (agent) or answers it gave (describe). */
  attempts: number;
  toolCalls: string[];
  finalText: string;
  turns: number;
  stopReason: string | null;
  durationMs: number;
  usage: { inputTokens: number; outputTokens: number };
}

export interface DashboardsHarnessDeps {
  /** Opens a new MCP connection (a new OAuth client) named `clientName`. */
  openSession(clientName: string): Promise<McpSession>;
  core: DashboardsCore;
  model: ModelClient;
  modelId: string;
  params?: ModelParams;
  /** Model requests per prompt (agent mode). */
  maxTurns: number;
  today?: string;
  log?: (line: string) => void;
  /** Errors that should stop the whole run (e.g. a rejected API token). */
  isFatal?: (error: unknown) => boolean;
}

/** The dashboard every widget is built for: the Overview's filters (date range and owner). */
export const dashboardFilters = (core: DashboardsCore): DashboardFilter[] =>
  core.OVERVIEW_DASHBOARD.spec.filters;

/** The opening line of describePrompt's system message, which agent mode replaces. */
export const DESCRIBE_OPENING = "You write one dashboard widget for a CRM as a single JSON object";

/**
 * The agent's extra instructions: how to finish (widget.preview over call_operation), the
 * dashboard's filters, and the in-app box's widget guidance, so MCP runs and the box get the
 * same advice about types, mappings, parameters and SQL.
 */
export function buildingGuide(core: DashboardsCore, filters: DashboardFilter[]): string {
  const system = core.describePrompt("", filters)[0]?.content ?? "";
  const guidance = system.startsWith(DESCRIBE_OPENING)
    ? system.split("\n").slice(1).join("\n")
    : system;
  return [
    "## Building a dashboard widget",
    "",
    "The user wants one dashboard widget. Build it with the CRM's tools: look at the data with " +
      "query_sql first if that helps, then call call_operation with name `widget.preview` and " +
      'input `{ "widget": <widget spec>, "dashboardFilters": <the filters below> }` to check it ' +
      "runs and returns what the chart needs. When it fails, fix the widget and preview it again. " +
      "Finish with a successful widget.preview of your final widget, then reply in a sentence or " +
      "two. There is no need to save it on a dashboard.",
    "",
    `The dashboard's filters (pass them as dashboardFilters): ${JSON.stringify(filters)}`,
    "",
    "Widget guidance:",
    guidance,
  ].join("\n");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** True when a describe_operations result lists widget.preview as allowed for this connection. */
export function previewAllowed(describeOperationsText: string): boolean {
  const data = parseResult(describeOperationsText);
  const operations = isRecord(data) && Array.isArray(data.operations) ? data.operations : [];
  return operations.some(
    (op) => isRecord(op) && op.name === "widget.preview" && op.allowed === true,
  );
}

/** A model answer → a widget, normalised as widget.describe does; or why it is not one. */
export function parseAnswer(
  core: DashboardsCore,
  text: string,
): { widget: WidgetSpec } | { error: string } {
  const json = core.extractJson(text);
  if (!isRecord(json)) return { error: "The answer was not a JSON object" };
  const id =
    typeof json.id === "string" && /^[a-z0-9][a-z0-9_-]{0,40}$/.test(json.id) ? json.id : "widget";
  return {
    widget: {
      ...json,
      id,
      mapping: isRecord(json.mapping) ? json.mapping : {},
      options: isRecord(json.options) ? json.options : {},
    } as WidgetSpec,
  };
}

interface Outcome {
  candidate: Candidate | null;
  attempts: number;
  toolCalls: string[];
  finalText: string;
  turns: number;
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
  dashboards: string[];
  notes: string[];
}

async function agentOutcome(
  task: DashboardTask,
  deps: DashboardsHarnessDeps,
  agent: McpSession,
  today: string,
): Promise<Outcome> {
  const filters = dashboardFilters(deps.core);
  const run = await runAgent({
    ...deps.params,
    model: deps.model,
    executor: agent,
    modelId: deps.modelId,
    system: `${systemPrompt(agent.instructions, today)}\n\n${buildingGuide(deps.core, filters)}`,
    tools: toOpenAiTools(await agent.listTools()),
    prompts: [task.prompt],
    maxTurns: deps.maxTurns,
  });
  const candidate = finalCandidate(run.calls);
  const notes: string[] = [];
  if (run.error) notes.push(run.error);
  if (candidate && candidate.source !== "widget.preview") {
    notes.push(`never previewed a widget; graded the last one saved with ${candidate.source}`);
  } else if (candidate && !candidate.modelPreviewOk) {
    notes.push("the model's last widget.preview failed");
  }
  return {
    candidate,
    attempts: run.calls.filter((c) => callMatches("op:widget.preview", c)).length,
    toolCalls: run.calls.map(callLabel),
    finalText: run.finalText,
    turns: run.turns,
    stopReason: run.stopReason,
    usage: run.usage,
    dashboards: createdDashboards(run.calls),
    notes,
  };
}

/** The in-app box: two answers at most, the second told why the first failed. */
async function describeOutcome(
  task: DashboardTask,
  deps: DashboardsHarnessDeps,
  app: McpSession,
): Promise<Outcome> {
  const filters = dashboardFilters(deps.core);
  // describePrompt's messages (system, user) are chat-completions messages as they are.
  const messages = [...deps.core.describePrompt(task.prompt, filters)] as ChatMessage[];
  const outcome: Outcome = {
    candidate: null,
    attempts: 0,
    toolCalls: [],
    finalText: "",
    turns: 0,
    stopReason: null,
    usage: { inputTokens: 0, outputTokens: 0 },
    dashboards: [],
    notes: [],
  };
  for (let attempt = 1; attempt <= 2; attempt++) {
    outcome.turns += 1;
    outcome.attempts = attempt;
    const response = await deps.model.createCompletion({
      model: deps.modelId,
      messages,
      max_tokens: deps.params?.maxTokens ?? 16000,
      ...samplingFields(deps.params ?? {}),
    });
    outcome.usage.inputTokens += response.usage?.prompt_tokens ?? 0;
    outcome.usage.outputTokens += response.usage?.completion_tokens ?? 0;
    const choice = response.choices[0];
    if (!choice) throw new Error("The model returned no choices");
    outcome.stopReason = choice.finish_reason;
    const text = choice.message.content ?? "";
    outcome.finalText = text.trim();
    const parsed = parseAnswer(deps.core, text);
    let error: string;
    if ("widget" in parsed) {
      const candidate: Candidate = {
        widget: parsed.widget,
        dashboardFilters: filters,
        filters: {},
        source: "describe",
        modelPreviewOk: false,
      };
      outcome.candidate = candidate;
      const preview = await previewWidget(app, candidate);
      outcome.toolCalls.push(`widget.preview${preview.ok ? "" : " ✗"}`);
      if (preview.ok) {
        candidate.modelPreviewOk = true;
        break;
      }
      error = preview.error;
    } else {
      error = parsed.error;
    }
    if (attempt === 2) {
      outcome.notes.push(`the in-app box would show: ${error}`);
      break;
    }
    messages.push(
      { role: "assistant", content: text },
      {
        role: "user",
        content: `That widget failed: ${error}. Reply with the corrected JSON object only.`,
      },
    );
  }
  return outcome;
}

function summarisePreview(preview: GraderPreview | null): DashboardResult["preview"] {
  if (!preview) return null;
  if (!preview.ok) return { ok: false, error: preview.error };
  return {
    ok: true,
    columns: preview.result.columns,
    rowCount: preview.result.rowCount,
    truncated: preview.result.truncated,
    sample: preview.result.rows.slice(0, 3),
  };
}

export async function runDashboardTask(
  task: DashboardTask,
  mode: Mode,
  deps: DashboardsHarnessDeps,
): Promise<DashboardResult> {
  const started = Date.now();
  const today = deps.today ?? todayUtc();
  const failures: Failure[] = [];
  let outcome: Outcome | null = null;
  let preview: GraderPreview | null = null;
  const sessions: McpSession[] = [];
  try {
    const grader = await deps.openSession(`Dashboards eval grader (${task.id})`);
    sessions.push(grader);
    const agent = await deps.openSession(
      mode === "agent" ? `Agent dashboards eval (${task.id})` : `Describe box eval (${task.id})`,
    );
    sessions.push(agent);
    outcome =
      mode === "agent"
        ? await agentOutcome(task, deps, agent, today)
        : await describeOutcome(task, deps, agent);
    if (outcome.candidate) preview = await previewWidget(grader, outcome.candidate);
    failures.push(...gradeCandidate(task, outcome.candidate, preview));
    for (const id of outcome.dashboards) {
      const deleted = await grader.callTool("call_operation", {
        name: "dashboard.delete",
        input: { id },
        reason: "Dashboards eval cleanup: delete the dashboard the eval model created",
      });
      if (deleted.isError || isPending(parseResult(deleted.text))) {
        outcome.notes.push(`could not delete dashboard ${id}: ${deleted.text.slice(0, 200)}`);
      }
    }
  } catch (error) {
    if (deps.isFatal?.(error)) throw error;
    failures.push({ kind: "error", message: (error as Error).message ?? String(error) });
  } finally {
    await Promise.all(sessions.map((s) => s.close().catch(() => {})));
  }
  return {
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    mode,
    accept: task.accept,
    passed: failures.length === 0,
    failures,
    notes: outcome?.notes ?? [],
    candidate: outcome?.candidate ?? null,
    preview: summarisePreview(preview),
    attempts: outcome?.attempts ?? 0,
    toolCalls: outcome?.toolCalls ?? [],
    finalText: outcome?.finalText ?? "",
    turns: outcome?.turns ?? 0,
    stopReason: outcome?.stopReason ?? null,
    durationMs: Date.now() - started,
    usage: outcome?.usage ?? { inputTokens: 0, outputTokens: 0 },
  };
}
