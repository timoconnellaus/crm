// Running the automations eval in three phases, so the eval's own automations never fire on the
// records they are tested on, and so one person can approve every proposal in one sitting:
//
//   1. seed:   the grader creates each case's test record (before any automation exists);
//   2. author: per case, the model gets a fresh MCP connection (scopes read write admin) and
//              writes, checks and proposes an extension with an automation;
//   3. grade:  once the proposals are approved (a person, in the Approvals inbox: installing an
//              extension is human-only, ADR 0041), the grader checks the working copy, waits for
//              the automation to be installed, runs automation.test on the seeded record, reads
//              the host summary with automation.get, judges it, and disables the automation.
import {
  emptyRun,
  type ModelClient,
  type RecordedCall,
  runAgent,
} from "@crm/evals-mcp/lib/agent.ts";
import { toOpenAiTools } from "@crm/evals-mcp/lib/convert.ts";
import { callLabel, callMatches } from "@crm/evals-mcp/lib/grading.ts";
import { makeSuffix, systemPrompt, todayUtc } from "@crm/evals-mcp/lib/harness.ts";
import { type McpSession, parseResult } from "@crm/evals-mcp/lib/mcp.ts";
import type { ModelParams } from "@crm/evals-mcp/lib/model.ts";
import { type AutomationCase, extensionIdFor, promptText } from "../prompts.ts";
import {
  type AutomationListing,
  automationsOf,
  CrmClient,
  type SeededRecord,
  seedRecord,
  userIdByEmail,
} from "./crm.ts";
import {
  gradeTest,
  type JudgeVerdict,
  judgeSummary,
  keywordFailures,
  outcomeOf,
  parseTestReport,
  type TestOutcome,
} from "./grading.ts";

/** The tools the model cannot author without. */
export const AUTHORING_TOOLS = ["extension_write", "extension_check", "extension_propose"];

export interface CheckIssue {
  stage: string;
  code: string;
  path?: string;
  message: string;
}

export type FailureKind =
  | "seed"
  | "propose"
  | "check"
  | "install"
  | "trigger"
  | "test"
  | "summary"
  | "error";

export interface Failure {
  kind: FailureKind;
  message: string;
}

export interface Proposal {
  extensionId: string;
  changeSetId?: string;
  actionId?: string;
  commit?: string;
  turn: number;
}

/** One case after authoring (phase 2). */
export interface Authored {
  case: AutomationCase;
  requestedId: string;
  request: string;
  seeded: SeededRecord | null;
  proposal: Proposal | null;
  failures: Failure[];
  notes: string[];
  issuesSeen: (CheckIssue & { turn: number; tool: string })[];
  counts: { writes: number; checks: number; proposes: number; toolCalls: number };
  toolCalls: string[];
  finalText: string;
  turns: number;
  stopReason: string | null;
  durationMs: number;
  usage: { inputTokens: number; outputTokens: number };
}

export interface CaseResult extends Omit<Authored, "case"> {
  id: string;
  title: string;
  covers: string[];
  extensionId: string | null;
  automationId: string | null;
  passed: boolean;
  check: { ok: boolean; issues: CheckIssue[] } | null;
  triggerType: string | null;
  test: TestOutcome | null;
  summary: string | null;
  judge: JudgeVerdict | null;
}

export interface AutomationsHarnessDeps {
  /** Opens a new MCP connection (a new OAuth client with scopes read write admin). */
  openSession(clientName: string): Promise<McpSession>;
  model: ModelClient;
  modelId: string;
  params?: ModelParams;
  maxTurns: number;
  /** The eval user's email: seeded deals are theirs, and they are an admin. */
  userEmail: string;
  today?: string;
  /** The run's word generator; its output, lower-cased, is appended to each extension id. */
  suffix?: () => string;
  /** How long to wait for an approved proposal's automation to appear. Default 30 minutes. */
  installTimeoutMs?: number;
  /** Poll interval while waiting. Default 5 s. */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Errors that should stop the whole run (e.g. a rejected API token). */
  isFatal?: (error: unknown) => boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const is = (call: RecordedCall, operation: string) => callMatches(`op:${operation}`, call);

function inputOf(call: RecordedCall): Record<string, unknown> {
  if (call.name === "call_operation" && isRecord(call.input.input)) return call.input.input;
  return call.input;
}

function issuesOf(value: unknown): CheckIssue[] {
  if (!isRecord(value) || !Array.isArray(value.issues)) return [];
  return value.issues.filter(isRecord).map((i) => ({
    stage: String(i.stage ?? "?"),
    code: String(i.code ?? "?"),
    ...(i.path !== undefined ? { path: String(i.path) } : {}),
    message: String(i.message ?? ""),
  }));
}

/** Successful proposals: extension_propose calls that came back pending_approval. */
export function proposalsOf(calls: RecordedCall[]): Proposal[] {
  return calls
    .filter((c) => is(c, "extension.propose") && !c.isError)
    .filter((c) => isRecord(c.result) && c.result.status === "pending_approval")
    .map((c) => {
      const result = c.result as Record<string, unknown>;
      return {
        extensionId: String(inputOf(c).id ?? result.id ?? ""),
        turn: c.turn,
        ...(typeof result.changeSetId === "string" ? { changeSetId: result.changeSetId } : {}),
        ...(typeof result.actionId === "string" ? { actionId: result.actionId } : {}),
        ...(typeof result.commit === "string" ? { commit: result.commit } : {}),
      };
    });
}

const describeIssue = (i: CheckIssue) =>
  `${i.stage}/${i.code}${i.path ? ` at ${i.path}` : ""}: ${i.message}`;

export interface RunContext {
  grader: CrmClient;
  userId: string;
  today: string;
  slug: string;
}

/** Opens the grader's connection and resolves the eval user. */
export async function startRun(
  deps: AutomationsHarnessDeps,
): Promise<RunContext & { close(): Promise<void> }> {
  const session = await deps.openSession("Automations eval grader");
  const grader = new CrmClient(session);
  const userId = await userIdByEmail(grader, deps.userEmail);
  return {
    grader,
    userId,
    today: deps.today ?? todayUtc(),
    slug: (deps.suffix ?? makeSuffix)().toLowerCase(),
    close: () => session.close(),
  };
}

/** Phase 1: the case's test record (null when the case has none). */
export async function seedCase(
  c: AutomationCase,
  run: RunContext,
): Promise<{ seeded: SeededRecord | null; failure?: Failure }> {
  if (!c.seed) return { seeded: null };
  try {
    return {
      seeded: await seedRecord(run.grader, c.seed, {
        userId: run.userId,
        today: run.today,
        suffix: run.slug,
      }),
    };
  } catch (error) {
    return { seeded: null, failure: { kind: "seed", message: (error as Error).message } };
  }
}

/** Phase 2: the model writes, checks and proposes the extension. */
export async function authorCase(
  c: AutomationCase,
  run: RunContext,
  seeded: SeededRecord | null,
  deps: AutomationsHarnessDeps,
): Promise<Authored> {
  const started = Date.now();
  const requestedId = extensionIdFor(c, run.slug);
  const request = promptText(c, requestedId);
  const failures: Failure[] = [];
  const notes: string[] = [];
  let agentRun = emptyRun();
  let proposal: Proposal | null = null;
  let session: McpSession | null = null;
  try {
    session = await deps.openSession(`Automations eval agent (${c.id})`);
    const listed = await session.listTools();
    const missing = AUTHORING_TOOLS.filter((name) => !listed.some((t) => t.name === name));
    if (missing.length) {
      throw new Error(
        `the MCP server offers no ${missing.join(", ")}: the eval user must be an admin and the ` +
          "connection needs the admin scope (extensions:manage)",
      );
    }
    agentRun = await runAgent({
      ...deps.params,
      model: deps.model,
      executor: session,
      modelId: deps.modelId,
      system: systemPrompt(session.instructions, run.today),
      tools: toOpenAiTools(listed),
      prompts: [request],
      maxTurns: deps.maxTurns,
    });
    if (agentRun.error) notes.push(agentRun.error);
    const proposals = proposalsOf(agentRun.calls);
    proposal =
      proposals.filter((p) => p.extensionId === requestedId).at(-1) ?? proposals.at(-1) ?? null;
    if (!proposal) {
      const attempts = agentRun.calls.filter((call) => is(call, "extension.propose"));
      failures.push({
        kind: "propose",
        message: attempts.length
          ? `no extension_propose came back pending_approval (${attempts.length} attempt(s); last: ${(attempts.at(-1)?.resultText ?? "").slice(0, 300)})`
          : "the model never called extension_propose",
      });
    } else if (proposal.extensionId !== requestedId) {
      notes.push(`proposed extension ${proposal.extensionId}, not the requested ${requestedId}`);
    }
  } catch (error) {
    if (deps.isFatal?.(error)) throw error;
    failures.push({ kind: "error", message: (error as Error).message ?? String(error) });
  } finally {
    await session?.close().catch(() => {});
  }
  const count = (operation: string) => agentRun.calls.filter((call) => is(call, operation)).length;
  return {
    case: c,
    requestedId,
    request,
    seeded,
    proposal,
    failures,
    notes,
    issuesSeen: agentRun.calls
      .filter((call) => is(call, "extension.check") || is(call, "extension.propose"))
      .flatMap((call) =>
        issuesOf(call.result).map((issue) => ({ ...issue, turn: call.turn, tool: call.name })),
      ),
    counts: {
      writes: count("extension.write"),
      checks: count("extension.check"),
      proposes: count("extension.propose"),
      toolCalls: agentRun.calls.length,
    },
    toolCalls: agentRun.calls.map(callLabel),
    finalText: agentRun.finalText,
    turns: agentRun.turns,
    stopReason: agentRun.stopReason,
    durationMs: Date.now() - started,
    usage: agentRun.usage,
  };
}

/** Waits until the approved extension's automation is installed; null on timeout. */
export async function waitForAutomation(
  run: RunContext,
  extensionId: string,
  deps: AutomationsHarnessDeps,
): Promise<AutomationListing | null> {
  const deadline = Date.now() + (deps.installTimeoutMs ?? 30 * 60_000);
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (;;) {
    const found = await automationsOf(run.grader, extensionId);
    if (found.length) return found[0] ?? null;
    if (Date.now() >= deadline) return null;
    await sleep(deps.pollMs ?? 5_000);
  }
}

/**
 * Waits until every proposed extension has an installed automation, or `timeoutMs` passes.
 * Returns the extension ids still not installed.
 */
export async function waitForInstalls(
  authored: Authored[],
  run: RunContext,
  deps: AutomationsHarnessDeps,
  timeoutMs: number,
  onPending?: (pending: string[]) => void,
): Promise<string[]> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  let pending = authored.flatMap((a) => (a.proposal ? [a.proposal.extensionId] : []));
  for (;;) {
    const still: string[] = [];
    for (const id of pending) {
      if ((await automationsOf(run.grader, id)).length === 0) still.push(id);
    }
    pending = still;
    if (pending.length === 0 || Date.now() >= deadline) return pending;
    onPending?.(pending);
    await sleep(deps.pollMs ?? 5_000);
  }
}

/** Phase 3: grade an authored case after its proposal was (or should have been) approved. */
export async function gradeCase(
  authored: Authored,
  run: RunContext,
  deps: AutomationsHarnessDeps,
): Promise<CaseResult> {
  const { case: c, ...rest } = authored;
  const failures = [...authored.failures];
  const notes = [...authored.notes];
  const extensionId = authored.proposal?.extensionId ?? null;
  let check: CaseResult["check"] = null;
  let automationId: string | null = null;
  let triggerType: string | null = null;
  let test: TestOutcome | null = null;
  let summary: string | null = null;
  let judge: JudgeVerdict | null = null;
  const fail = (kind: FailureKind, message: string) => failures.push({ kind, message });

  if (extensionId && !failures.some((f) => f.kind === "seed")) {
    try {
      // 1. The working copy passes check.
      const answer = await run.grader.session.callTool("extension_check", { id: extensionId });
      const parsed = parseResult(answer.text);
      if (answer.isError || !isRecord(parsed) || typeof parsed.ok !== "boolean") {
        fail("check", `extension_check on ${extensionId} failed: ${answer.text.slice(0, 300)}`);
      } else {
        check = { ok: parsed.ok, issues: issuesOf(parsed) };
        if (!check.ok) {
          fail(
            "check",
            `the working copy does not pass check: ${check.issues.map(describeIssue).join("; ") || "(no issues listed)"}`,
          );
        }
      }

      // 2. Installed once approved.
      const listing = await waitForAutomation(run, extensionId, deps);
      if (!listing) {
        fail(
          "install",
          `no automation of ${extensionId} was installed in time: approve the proposal${authored.proposal?.changeSetId ? ` (change set ${authored.proposal.changeSetId})` : ""} in the Approvals inbox`,
        );
      } else {
        automationId = listing.id;
        const detail = await run.grader.call<Record<string, unknown>>("automation.get", {
          id: automationId,
        });
        const spec = isRecord(detail.spec) ? detail.spec : {};
        const trigger = isRecord(spec.trigger) ? spec.trigger : {};
        triggerType =
          typeof trigger.type === "string" ? trigger.type : (listing.triggerType ?? null);
        if (!triggerType || !(c.triggers as string[]).includes(triggerType)) {
          fail(
            "trigger",
            `trigger type ${triggerType ?? "unknown"}; the request needs ${c.triggers.join(" or ")}`,
          );
        }
        summary =
          isRecord(detail.summary) && typeof detail.summary.text === "string"
            ? detail.summary.text
            : null;

        // 3. Test mode on the seeded record.
        const tested = await run.grader.call("automation.test", {
          id: automationId,
          ...(authored.seeded ? { record: authored.seeded } : {}),
        });
        const report = parseTestReport(tested);
        if (!report) {
          fail(
            "test",
            `automation.test returned no report: ${JSON.stringify(tested).slice(0, 300)}`,
          );
        } else {
          test = outcomeOf(report);
          for (const message of gradeTest(c, report, run.userId)) fail("test", message);
        }

        // 4. The host summary states the intent.
        if (!summary) {
          fail("summary", "automation.get returned no summary text");
        } else {
          for (const message of keywordFailures(c, summary)) fail("summary", message);
          judge = await judgeSummary(deps.model, deps.modelId, c, summary, deps.params);
          if (!judge.pass) fail("summary", `the judge: ${judge.reason}`);
        }

        // Leave nothing running in the deployment.
        await run.grader
          .call("automation.disable", { id: automationId }, { write: true })
          .catch((error: unknown) =>
            notes.push(`could not disable ${automationId}: ${(error as Error).message}`),
          );
      }
    } catch (error) {
      if (deps.isFatal?.(error)) throw error;
      fail("error", (error as Error).message ?? String(error));
    }
  }
  return {
    ...rest,
    id: c.id,
    title: c.title,
    covers: c.covers,
    extensionId,
    automationId,
    failures,
    notes,
    passed: failures.length === 0,
    check,
    triggerType,
    test,
    summary,
    judge,
  };
}

/**
 * The whole eval: seed every case, author every case, call `awaitApprovals` with the proposals
 * (the runner tells the operator what to approve), then grade every case.
 */
export async function runEval(
  selected: AutomationCase[],
  deps: AutomationsHarnessDeps,
  awaitApprovals: (authored: Authored[], run: RunContext) => Promise<void> = async () => {},
): Promise<CaseResult[]> {
  const run = await startRun(deps);
  try {
    const seeds = [];
    for (const c of selected) seeds.push(await seedCase(c, run));
    const authored: Authored[] = [];
    for (const [i, c] of selected.entries()) {
      const seed = seeds[i] ?? { seeded: null };
      deps.log?.(`author ${c.id}`);
      const result = await authorCase(c, run, seed.seeded, deps);
      if (seed.failure) result.failures.unshift(seed.failure);
      authored.push(result);
    }
    await awaitApprovals(authored, run);
    const results: CaseResult[] = [];
    for (const a of authored) {
      deps.log?.(`grade ${a.case.id}`);
      results.push(await gradeCase(a, run, deps));
    }
    return results;
  } finally {
    await run.close().catch(() => {});
  }
}
