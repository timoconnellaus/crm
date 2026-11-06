// An agent (ADR 0344): one `AgentJob` Durable Object per job, named `job:<jobId>`, doing longer work
// beside the chat. It gets a brief, records by id, the person's memory read at start and a grant,
// never the thread. It works in slices of a few model steps, its messages kept in its own SQLite,
// so an eviction costs at most the slice it was in: the next alarm carries on.
//
// It never blocks. Every call goes through the pipeline with a grant guard (core's grants.ts):
// filling an empty field or adding a note or task applies at once, anything else needing review
// goes into the job's change set, and the work moves on. Something outside the grant comes back as
// its own card. When it finishes it copies its results to the parent and to D1, then deletes its
// storage; while changes still wait for the person, a small row and a reminder alarm stay.
//
// Writes to D1 go only through operations: `agent.report`, as its person.
import { DurableObject } from "cloudflare:workers";
import { type A2uiPart, prepareCard } from "@relationship-os/agent-a2ui";
import {
  finishedJob,
  type JobBudget,
  type JobMessage,
  type JobUsage,
  jobResult,
  reachedLimit,
  runTurn,
  stepCostMicrousd,
  trimJobMessages,
} from "@relationship-os/agent-core";
import {
  type ActingUser,
  type AgentJobHost,
  type AssistantTool,
  agentInstructions,
  agentProfiles,
  BASE_OPERATIONS,
  type ChatModel,
  type ConversationScrub,
  conversationRefs,
  coreRegistry,
  EMPTY_GRANT_USAGE,
  errorForLog,
  type Grant,
  type GrantUsage,
  grantGuard,
  type InvocationContext,
  invokeByName,
  jobSession,
  loadAgentSettings,
  loadGeneralSettings,
  memoryForAgent,
  parseFloor,
  pendingOf,
  parseToolOutput,
  type RateLimitBinding,
  RateLimitedError,
  ROLES,
  type Role,
  rateLimit,
  scrubMessage,
  scrubPattern,
  scrubText,
} from "@relationship-os/core";
import { createCrmDb } from "@relationship-os/db";
import { getAgentByName } from "agents";
import { aiContextFor } from "../ai.ts";
import { blobStoreFor, integrationRuntimeFor } from "../integrations.ts";
import { curatedToolName, type McpCaller } from "../mcp/tools.ts";
import {
  agentJobsFor,
  automationWiring,
  extensionHostFor,
  type OperationsEnv,
} from "../operations.ts";
import type { AssistantAgent } from "./agent.ts";
import { type AssistantMcp, connectAssistantMcp } from "./mcp-client.ts";

export interface AgentJobEnv extends OperationsEnv {
  MCP_WRITE_RATE_LIMIT?: RateLimitBinding;
}

/** The Durable Object name of a job. */
export function jobName(jobId: string): string {
  return `job:${jobId}`;
}

/** Model steps per alarm: budgets are checked after every step, the slice just bounds an alarm. */
const SLICE_STEPS = 8;

/** The card's words stay fresh without a write per token. */
const REPORT_EVERY_MS = 3_000;

interface JobSpec {
  id: string;
  userId: string;
  title: string;
  brief: string;
  role: string;
  profile: string | null;
  records: { object: string; id: string }[];
  grant: Grant;
  reviewEverything: boolean;
  /** The change set this job's staged work goes into. */
  changeSetId: string | null;
}

type Phase = "running" | "reviewing" | "finished";

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export class AgentJob extends DurableObject<Cloudflare.Env> {
  #abort: AbortController | null = null;
  #waiters = new Set<() => void>();
  #ready = false;

  get #env(): AgentJobEnv {
    return this.env as unknown as AgentJobEnv;
  }

  get #sql() {
    if (!this.#ready) {
      const sql = this.ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS job_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS job_messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        message TEXT NOT NULL
      )`);
      this.#ready = true;
    }
    return this.ctx.storage.sql;
  }

  #meta<T>(key: string): T | null {
    const row = this.#sql
      .exec<{ value: string }>("SELECT value FROM job_meta WHERE key = ?", key)
      .toArray()[0];
    return row ? (JSON.parse(row.value) as T) : null;
  }

  #setMeta(key: string, value: unknown) {
    this.#sql.exec(
      "INSERT INTO job_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      key,
      JSON.stringify(value),
    );
  }

  #messages(): JobMessage[] {
    return this.#sql
      .exec<{ message: string }>("SELECT message FROM job_messages ORDER BY seq")
      .toArray()
      .map((r) => JSON.parse(r.message) as JobMessage);
  }

  #append(messages: readonly JobMessage[]) {
    for (const message of messages) {
      this.#sql.exec("INSERT INTO job_messages (message) VALUES (?)", JSON.stringify(message));
    }
  }

  // -------------------------------------------------------------------------------------------
  // What operations call (AgentJobHost)

  /** Starts or resumes the job. Idempotent: the alarm owns the work. */
  async begin(jobId: string): Promise<void> {
    const phase = this.#meta<Phase>("phase");
    if (phase === "reviewing" || phase === "finished") return;
    if (!this.#meta<JobSpec>("spec")) await this.#seed(jobId);
    this.#setMeta("phase", "running" satisfies Phase);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
  }

  /** Stops it after its current step. `agent.stop` has already said so in D1. */
  async stop(_jobId: string): Promise<void> {
    this.#abort?.abort();
    if (this.#meta<Phase>("phase") === "running") {
      await this.ctx.storage.setAlarm(Date.now());
    }
  }

  /** Waits up to `ms` for the job to finish. True when it has. */
  async wait(_jobId: string, ms: number): Promise<boolean> {
    const phase = this.#meta<Phase>("phase");
    if (phase !== "running" && phase !== null) return true;
    return new Promise<boolean>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.#waiters.delete(done);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(done);
        resolve(false);
      }, ms);
      this.#waiters.add(done);
    });
  }

  /** Redacts an erased subject from what this object still holds. */
  async scrub(_jobId: string, scrub: ConversationScrub): Promise<void> {
    const pattern = scrubPattern(scrub);
    if (!pattern) return;
    const spec = this.#meta<JobSpec>("spec");
    if (spec) {
      this.#setMeta("spec", {
        ...spec,
        title: scrubText(spec.title, pattern),
        brief: scrubText(spec.brief, pattern),
        records: spec.records.filter((r) => !scrub.terms.includes(r.id)),
      });
    }
    const rows = this.#sql
      .exec<{ seq: number; message: string }>("SELECT seq, message FROM job_messages")
      .toArray();
    for (const row of rows) {
      const message = JSON.parse(row.message) as JobMessage;
      const scrubbed = JSON.stringify(scrubMessage(message, pattern));
      if (scrubbed !== row.message) {
        this.#sql.exec("UPDATE job_messages SET message = ? WHERE seq = ?", scrubbed, row.seq);
      }
    }
  }

  /** Reads the job's row, once, and writes what the agent is told. Never the thread. */
  async #seed(jobId: string): Promise<void> {
    const env = this.#env;
    const db = createCrmDb(env.DB);
    const row = await db.query
      .selectFrom("core_agent_job")
      .selectAll()
      .where("id", "=", jobId)
      .executeTakeFirstOrThrow();
    const records = JSON.parse(row.records) as JobSpec["records"];
    const spec: JobSpec = {
      id: row.id,
      userId: row.user_id,
      title: row.title,
      brief: row.brief,
      role: row.role,
      profile: row.profile,
      records,
      grant: JSON.parse(row.access) as Grant,
      reviewEverything: row.review_everything === 1,
      changeSetId: null,
    };
    // Memory and pending lines as they are now, read-only (ADR 0342): the line saved on the last
    // turn is here. The call passes no turn, so an agent can never write memory.
    const [only] = records.length === 1 ? records : [];
    const memory = await memoryForAgent(db.query, row.user_id, only);
    const lines = [
      `Your brief:\n${row.brief}`,
      records.length
        ? `The records you work on:\n${records.map((r) => `- ${r.object} ${r.id}`).join("\n")}`
        : "",
      memory ? `What the person has asked their assistant to remember:\n${memory}` : "",
    ].filter(Boolean);
    this.#setMeta("spec", spec);
    this.#setMeta("usage", { steps: 0, runningMs: 0, spentMicrousd: 0 } satisfies JobUsage);
    this.#setMeta("grantUsage", EMPTY_GRANT_USAGE);
    this.#setMeta("filled", 0);
    this.#append([{ role: "user", content: lines.join("\n\n") }]);
  }

  // -------------------------------------------------------------------------------------------
  // The work

  override async alarm(): Promise<void> {
    const phase = this.#meta<Phase>("phase");
    if (phase === "reviewing") return this.#remind();
    if (phase !== "running") return;
    try {
      await this.#slice();
    } catch (error) {
      console.error("agent slice failed", errorForLog(error));
      await this.#finish("failed", {
        error: error instanceof Error ? error.message.slice(0, 500) : "The agent failed",
      });
    }
  }

  async #user(userId: string): Promise<ActingUser> {
    const db = createCrmDb(this.#env.DB);
    const row = await db.query
      .selectFrom("core_user")
      .select(["id", "email", "name", "role", "deactivated_at"])
      .where("id", "=", userId)
      .executeTakeFirst();
    if (!row || row.deactivated_at) throw new Error("This person's account is closed");
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      role: (ROLES as readonly string[]).includes(row.role) ? (row.role as Role) : "viewer",
    };
  }

  /** Invocation context for this job: the agent's actor, its session and its guard. */
  #context(user: ActingUser, spec: JobSpec, guard?: InvocationContext["grantGuard"]) {
    const env = this.#env;
    const db = createCrmDb(env.DB);
    const extensionHost = extensionHostFor(env);
    const integrations = integrationRuntimeFor(env);
    const blobs = blobStoreFor(env);
    const context: InvocationContext = {
      ...(integrations ? { integrations } : {}),
      ...(blobs ? { blobs } : {}),
      actor: "assistant",
      user,
      origin: { surface: "assistant", sessionId: jobSession(spec.id), jobId: spec.id },
      db,
      floor: parseFloor(env.APPROVAL_FLOOR),
      approvalExpiryDays: int(env.APPROVAL_EXPIRY_DAYS, 7),
      ...(extensionHost ? { extensionHost } : {}),
      ...automationWiring(env),
      ...aiContextFor(env, db),
      ...(guard ? { grantGuard: guard } : {}),
    };
    return context;
  }

  /** The tools: the granted operations, and `call_operation` for anything else (it comes back). */
  #tools(mcp: AssistantMcp, spec: JobSpec): AssistantTool[] {
    const allowed = new Set(
      [...spec.grant.operations, ...BASE_OPERATIONS].flatMap((name) => {
        const op = coreRegistry.get(name);
        return op ? [curatedToolName(op)] : [];
      }),
    );
    const kept = mcp.tools.filter(
      (t) => allowed.has(t.name) || t.name === "call_operation" || t.name === "describe_operations",
    );
    // A change outside the grant comes back as its own card, at once.
    return kept.map((tool) => ({
      ...tool,
      call: async (args) => {
        const result = await tool.call(args);
        const pending = result.isError ? undefined : pendingOf(parseToolOutput(result.text));
        if (pending && pending.changeSetId !== spec.changeSetId) {
          await this.#outsideCard(spec, pending.changeSetId, pending.actionId);
          return {
            ...result,
            modelText:
              "That was outside your grant, so it was set aside for the person as its own card. Carry on with the rest.",
          };
        }
        return result;
      },
    }));
  }

  async #parent(userId: string): Promise<DurableObjectStub<AssistantAgent> | null> {
    const namespace = this.#env.ASSISTANT;
    if (!namespace) return null;
    return (await getAgentByName(
      namespace as never,
      `user:${userId}`,
    )) as unknown as DurableObjectStub<AssistantAgent>;
  }

  async #outsideCard(spec: JobSpec, changeSetId: string, actionId: string) {
    const part: A2uiPart = prepareCard(
      {
        a2ui: 1,
        root: {
          type: "approval",
          changeSetId,
          actionIds: [actionId],
          title: `Outside what you allowed: ${spec.title}`,
        },
      },
      { source: "host", text: `${spec.title} wants to do something outside what you allowed.` },
    );
    // Not awaited inline: the parent may be in a turn, and the work must not wait for it.
    this.ctx.waitUntil(
      this.#parent(spec.userId)
        .then((parent) => parent?.postCard(spec.userId, part, "agent"))
        .catch((error) => console.warn("agent: could not post a card", error)),
    );
  }

  /** The job's change set, titled, so the person reviews it as one. */
  async #openChangeSet(user: ActingUser, spec: JobSpec): Promise<JobSpec> {
    if (spec.changeSetId) return spec;
    const out = (await invokeByName(
      "changeset.begin",
      { title: spec.title },
      this.#context(user, spec),
    )) as { changeSetId: string };
    const next = { ...spec, changeSetId: out.changeSetId };
    this.#setMeta("spec", next);
    return next;
  }

  async #report(
    spec: JobSpec,
    user: ActingUser,
    extra: {
      end?: { state: "done" | "failed" | "stopped" | "paused"; result?: string; error?: string };
      refs?: string[];
      remind?: boolean;
    } = {},
  ): Promise<string> {
    const usage = this.#meta<JobUsage>("usage") as JobUsage;
    const env = this.#env;
    const out = (await invokeByName(
      "agent.report",
      {
        jobId: spec.id,
        steps: usage.steps,
        spentMicrousd: usage.spentMicrousd,
        fieldsFilled: this.#meta<number>("filled") ?? 0,
        ...extra,
      },
      {
        actor: "human",
        user,
        origin: { surface: "system", jobId: spec.id },
        db: createCrmDb(env.DB),
        ...(agentJobsFor(env) ? { agentJobs: agentJobsFor(env) as AgentJobHost } : {}),
      },
    )) as { state: string };
    return out.state;
  }

  async #slice(): Promise<void> {
    const env = this.#env;
    const db = createCrmDb(env.DB);
    let spec = this.#meta<JobSpec>("spec") as JobSpec;
    const row = await db.query
      .selectFrom("core_agent_job")
      .select(["state", "budget"])
      .where("id", "=", spec.id)
      .executeTakeFirst();
    if (!row) return this.#cleanUp();
    // `agent.stop` says so in D1 first.
    if (row.state === "stopped" || row.state === "cancelled") return this.#finish("stopped", {});
    if (row.state !== "running") return;
    const budget = JSON.parse(row.budget) as JobBudget;
    const user = await this.#user(spec.userId);
    spec = await this.#openChangeSet(user, spec);

    const ai = aiContextFor(env, db);
    const models = ai.models?.chatModels
      ? await ai.models.chatModels(spec.role as "assistant.subagent")
      : [];
    if (!models.length) throw new Error("AI is not configured for this deployment");

    const usage = this.#meta<JobUsage>("usage") as JobUsage;
    const guard = grantGuard({
      jobId: spec.id,
      grant: spec.grant,
      reviewEverything: spec.reviewEverything,
      used: this.#meta<GrantUsage>("grantUsage") ?? EMPTY_GRANT_USAGE,
      onApplied: (used, filled) => {
        this.#setMeta("grantUsage", used);
        this.#setMeta("filled", (this.#meta<number>("filled") ?? 0) + filled);
      },
    });
    const caller: McpCaller = {
      context: this.#context(user, spec, guard),
      async consumeWrite() {
        const writes = await rateLimit(env.MCP_WRITE_RATE_LIMIT, `job:${spec.id}`);
        if (!writes.ok) {
          throw new RateLimitedError(
            `Rate limit: too many changes this minute. Retry in ${writes.retryAfterSeconds}s.`,
            { retryAfterSeconds: writes.retryAfterSeconds },
          );
        }
      },
    };
    const mcp = await connectAssistantMcp(caller);
    const started = Date.now();
    const abort = new AbortController();
    this.#abort = abort;
    const running = () => ({ ...usage, runningMs: usage.runningMs + Date.now() - started });
    let lastReport = Date.now();
    let result: Awaited<ReturnType<typeof runTurn>>;
    try {
      const settings = await loadGeneralSettings(db.query);
      const profile = spec.profile ? agentProfiles.get(spec.profile) : undefined;
      result = await runTurn({
        models,
        system: agentInstructions({
          name: settings.assistantName,
          user: { name: user.name, role: user.role },
          orgName: settings.orgName,
          title: spec.title,
          instructions: profile?.instructions,
          grant: spec.grant,
          reviewEverything: spec.reviewEverything,
          serverInstructions: mcp.instructions,
        }),
        messages: trimJobMessages(this.#messages()),
        tools: this.#tools(mcp, spec),
        emit: () => {},
        maxSteps: SLICE_STEPS,
        signal: abort.signal,
        onStep: (step) => {
          usage.steps += 1;
          const model = models.find((m: ChatModel) => m.modelId === step.modelId);
          usage.spentMicrousd += stepCostMicrousd(step, model?.pricing);
          this.#setMeta("usage", running());
          if (Date.now() - lastReport >= REPORT_EVERY_MS) {
            lastReport = Date.now();
            this.ctx.waitUntil(this.#tell(spec).catch(() => {}));
          }
        },
        stopAfterStep: () => reachedLimit(budget, running()) !== null,
      });
    } finally {
      this.#abort = null;
      await mcp.close();
    }
    usage.runningMs += Date.now() - started;
    this.#setMeta("usage", usage);
    this.#append(result.response);

    if (result.status === "error") {
      return this.#finish("failed", { error: (result.error ?? "The model failed").slice(0, 500) });
    }
    const messages = this.#messages();
    if (result.status === "stopped") return this.#finish("stopped", {});
    if (finishedJob(messages)) return this.#finish("done", { result: jobResult(messages) });
    const limit = reachedLimit(budget, usage);
    if (limit === "spend") return this.#pause(spec, user);
    if (limit) {
      return this.#finish("stopped", {
        error:
          limit === "steps"
            ? `It reached its limit of ${budget.steps} steps.`
            : `It reached its limit of ${budget.minutes} minutes.`,
      });
    }
    const state = await this.#report(spec, user, { refs: await this.#refs() });
    await this.#tell(spec);
    if (state === "stopped" || state === "cancelled") return this.#finish("stopped", {});
    await this.ctx.storage.setAlarm(Date.now());
  }

  /** The records and emails it has seen, for erase (ADR 0320). */
  async #refs(): Promise<string[]> {
    return (await conversationRefs(this.#messages())).slice(0, 100);
  }

  /** Tells the open chats to read the job again. */
  async #tell(spec: JobSpec): Promise<void> {
    const parent = await this.#parent(spec.userId);
    await parent?.jobChanged(spec.userId, spec.id);
  }

  async #pause(spec: JobSpec, user: ActingUser): Promise<void> {
    await this.#report(spec, user, { end: { state: "paused" }, refs: await this.#refs() });
    await this.#tell(spec);
    // Nothing runs until "Allow $X more" puts it back in line and `begin` is called.
  }

  async #finish(
    state: "done" | "failed" | "stopped",
    outcome: { result?: string; error?: string },
  ): Promise<void> {
    const spec = this.#meta<JobSpec>("spec") as JobSpec;
    const env = this.#env;
    const db = createCrmDb(env.DB);
    const user = await this.#user(spec.userId);
    const result = outcome.result ?? (jobResult(this.#messages()) || undefined);
    await this.#report(spec, user, {
      end: {
        state,
        ...(result ? { result: result.slice(0, 40_000) } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
      },
      refs: await this.#refs(),
    });
    const row = await db.query
      .selectFrom("core_agent_job")
      .select(["mode", "state"])
      .where("id", "=", spec.id)
      .executeTakeFirst();
    const toReview = await this.#pendingCount(spec);
    this.#setMeta("phase", (toReview ? "reviewing" : "finished") satisfies Phase);
    // An awaited job's words go back through the tool call that waits for it. Telling the parent
    // now would wait for that same turn.
    const waited = this.#waiters.size > 0;
    if (row?.mode === "background" && !waited) {
      const parent = await this.#parent(spec.userId);
      await parent?.jobFinished(spec.userId, {
        jobId: spec.id,
        title: spec.title,
        state: row.state,
        text: result ?? outcome.error ?? `${spec.title} has finished.`,
        changeSetId: toReview ? spec.changeSetId : null,
        toReview,
      });
    }
    for (const done of [...this.#waiters]) done();
    if (toReview) {
      // Only the reminder stays: what the agent read and said is gone.
      this.#sql.exec("DELETE FROM job_messages");
      await this.#scheduleReminder();
      return;
    }
    await this.#cleanUp();
  }

  async #pendingCount(spec: Pick<JobSpec, "id">): Promise<number> {
    const db = createCrmDb(this.#env.DB);
    const now = new Date().toISOString();
    const row = await db.query
      .selectFrom("core_pending_action as p")
      .innerJoin("core_change_set as c", "c.id", "p.change_set_id")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("c.session_id", "=", jobSession(spec.id))
      .where("p.status", "=", "pending")
      .where("p.expires_at", ">", now)
      .executeTakeFirst();
    return Number(row?.n ?? 0);
  }

  async #scheduleReminder(): Promise<void> {
    const settings = await loadAgentSettings(createCrmDb(this.#env.DB).query);
    await this.ctx.storage.setAlarm(Date.now() + settings.reminderHours * 3_600_000);
  }

  /** Changes still waiting: say so, and come back. None: nothing is left to keep. */
  async #remind(): Promise<void> {
    const spec = this.#meta<JobSpec>("spec") as JobSpec;
    if (!(await this.#pendingCount(spec))) return this.#cleanUp();
    const user = await this.#user(spec.userId);
    await this.#report(spec, user, { remind: true });
    await this.#scheduleReminder();
  }

  async #cleanUp(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.#ready = false;
  }
}
