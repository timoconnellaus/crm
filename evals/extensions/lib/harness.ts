// Running one authoring prompt: the model gets a fresh MCP connection (scopes read write admin,
// since authoring needs extensions:manage), writes and checks an extension until it proposes it,
// then the grader checks the extension's working copy on its own connection and holds the
// proposed manifest to the prompt's expectations.
import {
  emptyRun,
  type ModelClient,
  type RecordedCall,
  runAgent,
} from "@relationship-os/evals-mcp/lib/agent.ts";
import { toOpenAiTools } from "@relationship-os/evals-mcp/lib/convert.ts";
import { callLabel, callMatches } from "@relationship-os/evals-mcp/lib/grading.ts";
import { makeSuffix, systemPrompt, todayUtc } from "@relationship-os/evals-mcp/lib/harness.ts";
import { type McpSession, parseResult } from "@relationship-os/evals-mcp/lib/mcp.ts";
import type { ModelParams } from "@relationship-os/evals-mcp/lib/model.ts";
import { type AuthoringPrompt, extensionIdFor, promptText } from "../prompts.ts";
import type { Manifest } from "./manifest.ts";

/** The tools the model cannot author without. */
export const AUTHORING_TOOLS = ["extension_write", "extension_check", "extension_propose"];

export interface CheckIssue {
  stage: string;
  code: string;
  path?: string;
  message: string;
  suggestion?: string;
}

export interface CheckResult {
  ok: boolean;
  issues: CheckIssue[];
  manifest: Manifest | null;
  plan?: { ddl?: string[]; changes?: unknown[] } | null;
}

/** A check issue the model saw during its run, from extension_check or a failed propose. */
export interface SeenIssue extends CheckIssue {
  turn: number;
  tool: string;
}

export interface Proposal {
  extensionId: string;
  actionId?: string;
  changeSetId?: string;
  commit?: string;
  turn: number;
}

export type FailureKind = "propose" | "check" | "expectation" | "error";

export interface Failure {
  kind: FailureKind;
  message: string;
}

export interface PromptResult {
  id: string;
  title: string;
  covers: string[];
  /** The id the model was told to use. */
  requestedId: string;
  /** The id that was proposed and graded (null when nothing was proposed). */
  extensionId: string | null;
  request: string;
  passed: boolean;
  failures: Failure[];
  /** Not failures, but worth knowing (a different id, a run cut short after proposing). */
  notes: string[];
  proposal: Proposal | null;
  /** The grader's extension_check of the working copy after the run. */
  finalCheck: { ok: boolean; issues: CheckIssue[] } | null;
  issuesSeen: SeenIssue[];
  counts: { writes: number; checks: number; proposes: number; toolCalls: number };
  toolCalls: string[];
  finalText: string;
  turns: number;
  stopReason: string | null;
  durationMs: number;
  usage: { inputTokens: number; outputTokens: number };
}

export interface ExtensionsHarnessDeps {
  /** Opens a new MCP connection (a new OAuth client with scopes read write admin). */
  openSession(clientName: string): Promise<McpSession>;
  model: ModelClient;
  modelId: string;
  params?: ModelParams;
  maxTurns: number;
  today?: string;
  /** The run's word generator; its output, lower-cased, is appended to each extension id. */
  suffix?: () => string;
  log?: (line: string) => void;
  /** Errors that should stop the whole run (e.g. a rejected API token). */
  isFatal?: (error: unknown) => boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The input of an extension_* call, whether curated or through call_operation. */
function inputOf(call: RecordedCall): Record<string, unknown> {
  if (call.name === "call_operation" && isRecord(call.input.input)) return call.input.input;
  return call.input;
}

const is = (call: RecordedCall, operation: string) => callMatches(`op:${operation}`, call);

function issuesOf(value: unknown): CheckIssue[] {
  if (!isRecord(value) || !Array.isArray(value.issues)) return [];
  return value.issues.filter(isRecord).map((i) => ({
    stage: String(i.stage ?? "?"),
    code: String(i.code ?? "?"),
    ...(i.path !== undefined ? { path: String(i.path) } : {}),
    message: String(i.message ?? ""),
    ...(i.suggestion !== undefined ? { suggestion: String(i.suggestion) } : {}),
  }));
}

/** Parses an extension_check result; null when it is not one. */
export function parseCheck(value: unknown): CheckResult | null {
  if (!isRecord(value) || typeof value.ok !== "boolean") return null;
  return {
    ok: value.ok,
    issues: issuesOf(value),
    manifest: isRecord(value.manifest) ? (value.manifest as Manifest) : null,
    plan: isRecord(value.plan) ? (value.plan as CheckResult["plan"]) : null,
  };
}

/** Successful proposals in the run: extension_propose calls that came back pending_approval. */
export function proposalsOf(calls: RecordedCall[]): Proposal[] {
  return calls
    .filter((c) => is(c, "extension.propose") && !c.isError)
    .filter((c) => isRecord(c.result) && c.result.status === "pending_approval")
    .map((c) => {
      const result = c.result as Record<string, unknown>;
      const id = inputOf(c).id ?? result.id;
      return {
        extensionId: String(id ?? ""),
        turn: c.turn,
        ...(typeof result.actionId === "string" ? { actionId: result.actionId } : {}),
        ...(typeof result.changeSetId === "string" ? { changeSetId: result.changeSetId } : {}),
        ...(typeof result.commit === "string" ? { commit: result.commit } : {}),
      };
    });
}

/** Every check issue the model was shown: extension_check results and check_failed proposals. */
export function issuesSeenIn(calls: RecordedCall[]): SeenIssue[] {
  return calls
    .filter((c) => is(c, "extension.check") || is(c, "extension.propose"))
    .flatMap((c) => issuesOf(c.result).map((issue) => ({ ...issue, turn: c.turn, tool: c.name })));
}

/** Why no proposal succeeded, from the last propose attempt. */
function proposeFailure(calls: RecordedCall[]): string {
  const attempts = calls.filter((c) => is(c, "extension.propose"));
  const last = attempts.at(-1);
  if (!last) return "the model never called extension_propose";
  const status = isRecord(last.result) ? last.result.status : undefined;
  const detail = last.isError
    ? `it failed: ${last.resultText.slice(0, 300)}`
    : `the last came back ${String(status ?? "without a status")}`;
  return `no extension_propose came back pending_approval (${attempts.length} attempt(s); ${detail})`;
}

const describeIssue = (i: CheckIssue) =>
  `${i.stage}/${i.code}${i.path ? ` at ${i.path}` : ""}: ${i.message}`;

export async function runPrompt(
  prompt: AuthoringPrompt,
  deps: ExtensionsHarnessDeps,
): Promise<PromptResult> {
  const started = Date.now();
  const today = deps.today ?? todayUtc();
  const requestedId = extensionIdFor(prompt, (deps.suffix ?? makeSuffix)());
  const request = promptText(prompt, requestedId);
  const failures: Failure[] = [];
  const notes: string[] = [];
  let run = emptyRun();
  let proposal: Proposal | null = null;
  let finalCheck: PromptResult["finalCheck"] = null;
  const sessions: McpSession[] = [];
  try {
    const grader = await deps.openSession(`Extensions eval grader (${prompt.id})`);
    sessions.push(grader);
    const agent = await deps.openSession(`Agent extensions eval (${prompt.id})`);
    sessions.push(agent);
    const listed = await agent.listTools();
    const missing = AUTHORING_TOOLS.filter((name) => !listed.some((t) => t.name === name));
    if (missing.length) {
      throw new Error(
        `the MCP server offers no ${missing.join(", ")}: the eval user must be an admin and the ` +
          "connection needs the admin scope (extensions:manage)",
      );
    }
    run = await runAgent({
      ...deps.params,
      model: deps.model,
      executor: agent,
      modelId: deps.modelId,
      system: systemPrompt(agent.instructions, today),
      tools: toOpenAiTools(listed),
      prompts: [request],
      maxTurns: deps.maxTurns,
    });
    if (run.error) notes.push(run.error);

    const proposals = proposalsOf(run.calls);
    proposal =
      proposals.filter((p) => p.extensionId === requestedId).at(-1) ?? proposals.at(-1) ?? null;
    if (!proposal) {
      failures.push({ kind: "propose", message: proposeFailure(run.calls) });
    } else {
      if (proposal.extensionId !== requestedId) {
        notes.push(`proposed extension ${proposal.extensionId}, not the requested ${requestedId}`);
      }
      const answer = await grader.callTool("extension_check", { id: proposal.extensionId });
      const check = parseCheck(parseResult(answer.text));
      if (answer.isError || !check) {
        failures.push({
          kind: "check",
          message: `extension_check on ${proposal.extensionId} failed: ${answer.text.slice(0, 300)}`,
        });
      } else {
        finalCheck = { ok: check.ok, issues: check.issues };
        if (!check.ok) {
          failures.push({
            kind: "check",
            message: `the working copy does not pass check: ${check.issues.map(describeIssue).join("; ") || "(no issues listed)"}`,
          });
        }
        if (check.manifest) {
          for (const message of prompt.expect(check.manifest)) {
            failures.push({ kind: "expectation", message });
          }
        } else {
          failures.push({ kind: "check", message: "extension_check returned no manifest" });
        }
      }
    }
  } catch (error) {
    if (deps.isFatal?.(error)) throw error;
    failures.push({ kind: "error", message: (error as Error).message ?? String(error) });
  } finally {
    await Promise.all(sessions.map((s) => s.close().catch(() => {})));
  }
  const count = (operation: string) => run.calls.filter((c) => is(c, operation)).length;
  return {
    id: prompt.id,
    title: prompt.title,
    covers: prompt.covers,
    requestedId,
    extensionId: proposal?.extensionId ?? null,
    request,
    passed: failures.length === 0,
    failures,
    notes,
    proposal,
    finalCheck,
    issuesSeen: issuesSeenIn(run.calls),
    counts: {
      writes: count("extension.write"),
      checks: count("extension.check"),
      proposes: count("extension.propose"),
      toolCalls: run.calls.length,
    },
    toolCalls: run.calls.map(callLabel),
    finalText: run.finalText,
    turns: run.turns,
    stopReason: run.stopReason,
    durationMs: Date.now() - started,
    usage: run.usage,
  };
}
