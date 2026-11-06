// Agents and approvals end to end in workerd (ADR 0344, ADR 0345, stage 17 acceptance criteria 7, 8
// and the spoken approval of 12): the person's AssistantAgent, AgentJob objects with their alarms,
// the in-process tools and the scripted model, over real D1. The stand-in judge answers
// `grant.leastPrivilege` and `approval.intent` (AI_FAKE_MODEL).
import { env } from "cloudflare:workers";
import type { Principal } from "@relationship-os/auth";
import {
  type AssistantEvent,
  type AssistantThreadState,
  type CoreOutput,
  fakeStandIn,
  invokeByName,
  resolveActingUser,
} from "@relationship-os/core";
import { createCrmDb } from "@relationship-os/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AssistantHttpEnv,
  handleState,
  handleTurn,
  threadStub,
} from "../src/server/assistant/http.ts";
import { agentJobsFor, type OperationsEnv } from "../src/server/operations.ts";

const ORIGIN = "https://crm.test";
const appEnv = env as unknown as AssistantHttpEnv;
const opsEnv = env as unknown as OperationsEnv;
const db = createCrmDb(env.DB);

let n = 0;
async function member(role: "member" | "admin" = "member") {
  n += 1;
  const principal: Principal = {
    userId: `auth-agent-${Date.now()}-${n}`,
    email: `agents-${Date.now()}-${n}@example.com`,
    name: `Agent tester ${n}`,
    roles: [],
  };
  const user = await resolveActingUser(db, principal);
  await env.DB.prepare("UPDATE core_user SET role = ? WHERE id = ?").bind(role, user.id).run();
  return { principal, user: { ...user, role } };
}
type Member = Awaited<ReturnType<typeof member>>;

const human = (user: Member["user"]) => {
  const agentJobs = agentJobsFor(opsEnv);
  return {
    actor: "human" as const,
    user,
    origin: { surface: "ui" as const },
    db,
    ...(agentJobs ? { agentJobs } : {}),
  };
};

async function turn(principal: Principal, body: Record<string, unknown>) {
  const response = await handleTurn(
    new Request(`${ORIGIN}/api/assistant/turn`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify(body),
    }),
    appEnv,
    principal,
  );
  expect(response.status).toBe(200);
  const text = await response.text();
  return text
    .split("\n\n")
    .map((frame) => frame.split("\n").find((l) => l.startsWith("data: ")))
    .filter((l): l is string => Boolean(l))
    .map((l) => JSON.parse(l.slice(6)) as AssistantEvent);
}

async function state(principal: Principal): Promise<AssistantThreadState> {
  const response = await handleState(
    new Request(`${ORIGIN}/api/assistant/thread`),
    appEnv,
    principal,
  );
  return (await response.json()) as AssistantThreadState;
}

const orgIn = async (m: Member, name: string, website?: string) =>
  (await invokeByName(
    "organisation.create",
    { name, ...(website ? { website } : {}) },
    human(m.user),
  )) as { id: string };

const orgOf = async (m: Member, id: string) =>
  (await invokeByName("organisation.get", { id }, human(m.user))) as {
    website: string | null;
    name: string;
  };

const status = async (m: Member, jobId: string) => {
  const out = (await invokeByName("agent.status", { jobId }, human(m.user))) as CoreOutput<"agent.status">;
  const [job] = out.jobs;
  if (!job) throw new Error("no job");
  return job;
};

const started = (events: AssistantEvent[]) => {
  const result = events.find((e) => e.type === "tool-result" && e.tool === "start_agent");
  if (result?.type !== "tool-result") throw new Error("no agent started");
  return result.output as { jobId: string; state: string; status: string };
};

const finished = (m: Member, jobId: string) =>
  vi.waitFor(
    async () => {
      const job = await status(m, jobId);
      expect(["done", "failed", "stopped"]).toContain(job.state);
      return job;
    },
    { timeout: 15_000, interval: 50 },
  );

const research = (m: Member, ids: string[]) =>
  turn(m.principal, {
    text: `Research these ${ids.length} accounts`,
    context: {
      path: "/organisations",
      selection: { object: "organisation", ids },
    },
  });

afterEach(() => {
  fakeStandIn.holdAgent = null;
});

describe("agents", () => {
  it("runs in the background: fills what is empty, stages what is not, and Approve all applies it", async () => {
    const m = await member();
    const empty = await orgIn(m, "Bluegum Analytics");
    const filled = await orgIn(m, "Cobalt Dental", "https://cobalt.example.com");
    let release = () => {};
    fakeStandIn.holdAgent = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events = await research(m, [empty.id, filled.id]);
    const start = started(events);
    expect(start.status).toBe("a2ui_card");
    const card = events.find((e) => e.type === "tool-result" && e.card);
    expect(card?.type === "tool-result" && card.card?.document?.root.type).toBe("agentJob");

    // The person keeps chatting while it works.
    const chat = await turn(m.principal, { text: "hello" });
    expect(chat.at(-1)).toMatchObject({ type: "turn-end", status: "done" });

    release();
    const job = await finished(m, start.jobId);
    expect(job.state).toBe("done");
    expect(job.fieldsFilled).toBe(1);
    expect(job.toReview).toBe(1);
    expect((await orgOf(m, empty.id)).website).toContain("found-");
    expect((await orgOf(m, filled.id)).website).toBe("https://cobalt.example.com");

    // Its report is in the thread, with one review.
    const thread = await vi.waitFor(
      async () => {
        const s = await state(m.principal);
        expect(JSON.stringify(s.items)).toContain("changeReview");
        return s;
      },
      { timeout: 5_000, interval: 50 },
    );
    expect(JSON.stringify(thread.items)).toContain("Researched 2 organisations");

    const applied = (await invokeByName(
      "approval.decide",
      { changeSetId: job.changeSetId, decision: "approve", via: "tap" },
      human(m.user),
    )) as CoreOutput<"approval.decide">;
    expect(applied.status).toBe("decided");
    expect((await orgOf(m, filled.id)).website).toContain("found-");
    expect((await status(m, job.id)).toReview).toBe(0);
  });

  it("stops when asked, keeping what it did", async () => {
    const m = await member();
    const org = await orgIn(m, "Stopped Ltd");
    fakeStandIn.holdAgent = new Promise<void>(() => {});
    const start = started(await research(m, [org.id]));
    const out = (await invokeByName("agent.stop", { jobId: start.jobId }, human(m.user))) as {
      state: string;
    };
    expect(out.state).toBe("stopped");
    fakeStandIn.holdAgent = null;
    expect((await status(m, start.jobId)).state).toBe("stopped");
  });

  it("queues a fifth job, and starts it when a slot frees up", async () => {
    const m = await member();
    const org = await orgIn(m, "Busy Pty");
    fakeStandIn.holdAgent = new Promise<void>(() => {});
    const jobs: string[] = [];
    for (let i = 0; i < 5; i += 1) jobs.push(started(await research(m, [org.id])).jobId);
    const fifth = jobs.at(-1) as string;
    const queued = await status(m, fifth);
    expect(queued.state).toBe("queued");
    expect(queued.placeLabel).toBe("1st in line");
    await invokeByName("agent.stop", { jobId: jobs[0] as string }, human(m.user));
    expect((await status(m, fifth)).state).toBe("running");
    for (const id of jobs.slice(1)) await invokeByName("agent.stop", { jobId: id }, human(m.user));
    fakeStandIn.holdAgent = null;
  });

  it("refuses a grant wider than its starter in code, whatever the judge says", async () => {
    const m = await member();
    const org = await orgIn(m, "Wide Ltd");
    const assistant = { ...human(m.user), actor: "assistant" as const };
    await expect(
      invokeByName(
        "agent.start",
        {
          title: "Too much",
          brief: "Do a thing that needs a lot of access to the workspace.",
          records: [{ object: "organisation", id: org.id }],
          operations: ["organisation.get", "person.erase"],
        },
        assistant,
      ),
    ).rejects.toThrow(/person\.erase/);
    await expect(
      invokeByName(
        "agent.start",
        {
          title: "Memory",
          brief: "Save a line to memory for the person, please and thanks.",
          records: [{ object: "organisation", id: org.id }],
          operations: ["memory.propose"],
        },
        assistant,
      ),
    ).rejects.toThrow(/cannot be granted/);
  });
});

describe("approvals in the chat", () => {
  const pendingDelete = async (m: Member, name: string) => {
    const org = await orgIn(m, name);
    const events = await turn(m.principal, {
      text: "Delete this one please",
      context: {
        path: `/organisations/${org.id}`,
        record: { object: "organisation", id: org.id, label: name },
      },
    });
    const result = events.find((e) => e.type === "tool-result" && e.pending);
    if (result?.type !== "tool-result" || !result.pending) throw new Error("not pending");
    return { org, pending: result.pending };
  };

  const decision = (events: AssistantEvent[]) => {
    const result = events.find((e) => e.type === "tool-result" && e.tool === "decide_approval");
    if (result?.type !== "tool-result") throw new Error("no decision");
    return result.output as CoreOutput<"approval.decide">;
  };

  it("takes a high-risk item only with the exact phrase, typed or spoken", async () => {
    const m = await member();
    const { org, pending } = await pendingDelete(m, "Kestrel Energy");
    const refused = decision(await turn(m.principal, { text: "yes do it" }));
    expect(refused).toMatchObject({ status: "asked", reason: "phrase" });
    const phrase = refused.status === "asked" ? refused.phrase : null;
    expect(phrase).toContain("Kestrel Energy");
    const applied = decision(await turn(m.principal, { text: phrase ?? "" }));
    expect(applied.status).toBe("decided");
    const action = (await invokeByName(
      "approval.status",
      { actionId: pending.actionId },
      human(m.user),
    )) as CoreOutput<"approval.status">;
    expect(action.changeSets[0]?.actions[0]).toMatchObject({
      status: "applied",
      decidedVia: "typed",
    });
    await expect(orgOf(m, org.id)).rejects.toThrow();
  });

  it("refuses a direct approval of a high-risk item without its second step", async () => {
    const m = await member();
    const { pending } = await pendingDelete(m, "Direct Ltd");
    await expect(
      invokeByName("approval.approve", { actionIds: [pending.actionId] }, human(m.user)),
    ).rejects.toMatchObject({ code: "second_step_required" });
    const out = (await invokeByName(
      "approval.approve",
      { actionIds: [pending.actionId], confirm: "Confirm: delete Direct Ltd" },
      human(m.user),
    )) as CoreOutput<"approval.approve">;
    expect(out.results[0]?.status).toBe("applied");
  });

  it("applies once when two approvals arrive together", async () => {
    const m = await member();
    const { pending } = await pendingDelete(m, "Twice Ltd");
    const input = {
      actionIds: [pending.actionId],
      decision: "approve",
      via: "tap",
      confirm: "Confirm: delete Twice Ltd",
    };
    const [one, two] = (await Promise.all([
      invokeByName("approval.decide", input, human(m.user)),
      invokeByName("approval.decide", input, human(m.user)),
    ])) as CoreOutput<"approval.decide">[];
    expect(one?.status).toBe("decided");
    expect(two?.status).toBe("decided");
    const audit = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_audit WHERE pending_action_id = ? AND operation = 'organisation.delete' AND outcome = 'ok'",
    )
      .bind(pending.actionId)
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it("an agent's call cannot approve anything", async () => {
    const m = await member();
    const { pending } = await pendingDelete(m, "Agent Ltd");
    await expect(
      invokeByName(
        "approval.decide",
        { actionIds: [pending.actionId], decision: "approve" },
        {
          ...human(m.user),
          actor: "assistant",
          origin: { surface: "assistant", sessionId: "job:job_x", jobId: "job_x" },
        },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

void threadStub;
