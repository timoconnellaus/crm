// Running one eval task: fixture setup over a separate "admin" MCP connection, the agent loop over
// a fresh connection of its own (a new OAuth client, so its MCP session and any simulated pending
// state are its own), then grading tool choice, the reply and the CRM's state afterwards.
import type { AgentRun, ModelClient } from "./agent.ts";
import { emptyRun, runAgent } from "./agent.ts";
import { toOpenAiTools } from "./convert.ts";
import { callLabel, gradeTools, type ToolRules } from "./grading.ts";
import { isPending, type McpSession, parseResult } from "./mcp.ts";
import type { ModelParams } from "./model.ts";
import type { TaskResult } from "./report.ts";

export type Fixture = Record<string, string>;

export interface SetupContext {
  /** A capitalised word unique to this task run, e.g. "Varodin"; part of fixture names. */
  suffix: string;
  /** The same in lower case, for emails and domains. */
  slug: string;
  /** Four more unique words (words[0] is suffix), for fixtures that need several surnames. */
  words: string[];
  /** Today's date (UTC), YYYY-MM-DD. */
  today: string;
  /** Calls a tool on the admin connection; throws on an error or a pending approval. */
  call(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Creates a person; returns their id. */
  person(fields: Record<string, unknown>): Promise<string>;
  /** Creates an organisation; returns its id. */
  organisation(fields: Record<string, unknown>): Promise<string>;
}

export interface ToolJson {
  isError: boolean;
  data: unknown;
}

export interface CheckContext {
  fixture: Fixture;
  run: AgentRun;
  /** Read-only SQL over the crm_* views, on the admin connection (real state, no simulation). */
  sql<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
  /** A tool call on the agent's own connection (its MCP session: approval_status sees its sets). */
  agentCall(tool: string, args: Record<string, unknown>): Promise<ToolJson>;
  adminCall(tool: string, args: Record<string, unknown>): Promise<ToolJson>;
}

export interface EvalTask extends ToolRules {
  id: string;
  title: string;
  /** What the task covers, for the report. */
  covers: string[];
  setup?(ctx: SetupContext): Promise<Fixture>;
  /** The user's messages, in order; most tasks have one. `fixture` includes suffix and today. */
  prompts(fixture: Fixture): string[];
  /** Failure reasons from inspecting the CRM afterwards (empty when it is right). */
  check?(ctx: CheckContext): Promise<string[]>;
  /** Tidies up so later runs are not affected (e.g. completes tasks assigned to the eval user). */
  cleanup?(ctx: CheckContext): Promise<void>;
}

const CONSONANTS = "bdfgklmnprstvz";
const VOWELS = "aeiou";

/** A pronounceable, capitalised word ("Varodin") used to make fixture names unique per run. */
export function makeSuffix(random: () => number = Math.random): string {
  const pick = (chars: string) => chars[Math.floor(random() * chars.length)] as string;
  let word = "";
  for (let i = 0; i < 3; i++) word += pick(CONSONANTS) + pick(VOWELS);
  word += pick("nrsl");
  return word[0]?.toUpperCase() + word.slice(1);
}

export const todayUtc = (now = new Date()) => now.toISOString().slice(0, 10);

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function callJson(
  session: McpSession,
  tool: string,
  args: Record<string, unknown>,
): Promise<ToolJson> {
  const result = await session.callTool(tool, args);
  return { isError: result.isError, data: parseResult(result.text) };
}

const FIXTURE_REASON = "MCP eval fixture setup";

export function setupContext(admin: McpSession, words: string[], today: string): SetupContext {
  const suffix = words[0] as string;
  const call = async (tool: string, args: Record<string, unknown>) => {
    // A reason is stripped from read calls by the server, so it can always be sent.
    const { isError, data } = await callJson(admin, tool, { reason: FIXTURE_REASON, ...args });
    if (isError) throw new Error(`setup ${tool} failed: ${JSON.stringify(data)}`);
    if (isPending(data)) {
      throw new Error(
        `setup ${tool} was queued for approval: the eval needs the org's approval policy on ` +
          "Balanced (single creates and updates apply immediately)",
      );
    }
    return (data ?? {}) as Record<string, unknown>;
  };
  return {
    suffix,
    slug: suffix.toLowerCase(),
    words,
    today,
    call,
    person: async (fields) => String((await call("person_create", fields)).id),
    organisation: async (fields) => String((await call("organisation_create", fields)).id),
  };
}

export interface HarnessDeps {
  /** Opens a new MCP connection (a new OAuth client) named `clientName`. */
  openSession(clientName: string): Promise<McpSession>;
  model: ModelClient;
  modelId: string;
  /** Temperature, max tokens and so on, sent with every model request. */
  params?: ModelParams;
  maxTurns: number;
  today?: string;
  suffix?: () => string;
  log?: (line: string) => void;
  /** Errors that should stop the whole run (e.g. a rejected API key) rather than fail a task. */
  isFatal?: (error: unknown) => boolean;
}

export function systemPrompt(instructions: string | undefined, today: string): string {
  return `${instructions ?? ""}\n\nToday's date is ${today} (UTC).`.trim();
}

export async function runTask(task: EvalTask, deps: HarnessDeps): Promise<TaskResult> {
  const started = Date.now();
  const today = deps.today ?? todayUtc();
  const words: string[] = [];
  while (words.length < 5) {
    const word = (deps.suffix ?? makeSuffix)();
    if (!words.includes(word)) words.push(word);
  }
  const suffix = words[0] as string;
  const failures: string[] = [];
  let run: AgentRun = emptyRun();
  const sessions: McpSession[] = [];
  try {
    const admin = await deps.openSession(`MCP eval setup (${task.id})`);
    sessions.push(admin);
    const fixture: Fixture = { suffix, slug: suffix.toLowerCase(), today };
    try {
      Object.assign(fixture, await task.setup?.(setupContext(admin, words, today)));
    } catch (error) {
      throw new Error(`setup failed: ${(error as Error).message}`);
    }

    const agent = await deps.openSession(`Agent MCP eval (${task.id})`);
    sessions.push(agent);
    const tools = toOpenAiTools(await agent.listTools());
    run = await runAgent({
      ...deps.params,
      model: deps.model,
      executor: agent,
      modelId: deps.modelId,
      system: systemPrompt(agent.instructions, today),
      tools,
      prompts: task.prompts(fixture),
      maxTurns: deps.maxTurns,
    });
    if (run.error) failures.push(run.error);
    failures.push(...gradeTools(task, run));

    const ctx: CheckContext = {
      fixture,
      run,
      async sql<T>(query: string, params: unknown[] = []) {
        const { isError, data } = await callJson(admin, "query_sql", {
          sql: query,
          params,
          maxRows: 1000,
        });
        if (isError) throw new Error(`check query failed: ${JSON.stringify(data)}`);
        return ((data as { rows?: T[] }).rows ?? []) as T[];
      },
      agentCall: (tool, args) => callJson(agent, tool, args),
      adminCall: (tool, args) => callJson(admin, tool, args),
    };
    if (task.check) {
      try {
        failures.push(...(await task.check(ctx)));
      } catch (error) {
        failures.push(`outcome check threw: ${(error as Error).message}`);
      }
    }
    if (task.cleanup) {
      await task
        .cleanup(ctx)
        .catch((error: Error) => deps.log?.(`cleanup ${task.id}: ${error.message}`));
    }
  } catch (error) {
    if (deps.isFatal?.(error)) throw error;
    failures.push((error as Error).message ?? String(error));
  } finally {
    await Promise.all(sessions.map((s) => s.close().catch(() => {})));
  }
  return {
    id: task.id,
    title: task.title,
    covers: task.covers,
    passed: failures.length === 0,
    failures,
    toolCalls: run.calls.map(callLabel),
    finalText: run.finalText,
    turns: run.turns,
    stopReason: run.stopReason,
    durationMs: Date.now() - started,
    usage: run.usage,
  };
}
