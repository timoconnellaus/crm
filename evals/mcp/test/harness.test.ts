// runTask end to end with a scripted model and an in-memory CRM: setup, the agent loop on its own
// connection, grading and cleanup.
import { describe, expect, it } from "vitest";
import { addDays, type HarnessDeps, makeSuffix, runTask, systemPrompt } from "../lib/harness.ts";
import { tasks } from "../tasks.ts";
import { fakeSession, message, scriptedModel, text, toolUse } from "./fakes.ts";

const mergeTask = tasks.find((t) => t.id === "merge");
if (!mergeTask) throw new Error("merge task missing");

/** A tiny CRM: people, and person.merge always queued for approval in the caller's session. */
function fakeCrm() {
  const people = new Map<string, Record<string, unknown>>();
  const pending: Record<string, unknown>[] = [];
  let n = 0;
  const handlers = (session: string) => ({
    person_create: (args: Record<string, unknown>) => {
      n += 1;
      const id = `per_${n}`;
      people.set(id, { id, ...args });
      return { id };
    },
    query_sql: (args: Record<string, unknown>) => {
      const params = (args.params as string[]) ?? [];
      return { rows: params.filter((id) => people.has(id)).map((id) => ({ id })) };
    },
    call_operation: (args: Record<string, unknown>) => {
      const action = { operation: args.name, status: "pending", input: args.input, session };
      pending.push(action);
      return {
        status: "pending_approval",
        actionId: `act_${pending.length}`,
        operation: args.name,
      };
    },
    approval_status: () => ({
      changeSets: [{ actions: pending.filter((a) => a.session === session) }],
    }),
  });
  return { people, pending, handlers };
}

function deps(script: ReturnType<typeof scriptedModel>, crm: ReturnType<typeof fakeCrm>) {
  const sessions: ReturnType<typeof fakeSession>[] = [];
  const names: string[] = [];
  const words = ["Varodin", "Kelipas", "Monuter", "Saridol", "Fetanol"];
  const value: HarnessDeps = {
    openSession: async (clientName) => {
      names.push(clientName);
      const session = fakeSession(crm.handlers(clientName), "CRM instructions");
      sessions.push(session);
      return session;
    },
    model: script.model,
    modelId: "claude-opus-5-5",
    effort: "high",
    maxTurns: 10,
    today: "2026-11-04",
    suffix: () => words.shift() ?? "Extra",
  };
  return { value, sessions, names };
}

describe("runTask", () => {
  it("passes when the model queues the right merge and says so", async () => {
    const crm = fakeCrm();
    const script = scriptedModel([
      message([
        toolUse("call_operation", {
          name: "person.merge",
          input: { survivorId: "per_1", mergedId: "per_2" },
          reason: "Dan and Daniel are the same person (duplicate)",
        }),
      ]),
      message([text("The merge is queued and waiting for approval in the Approvals inbox.")]),
    ]);
    const { value, sessions, names } = deps(script, crm);
    const result = await runTask(mergeTask, value);

    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.toolCalls).toEqual(["call_operation(person.merge) ⏳"]);
    // Setup and the agent use separate connections, and both are closed.
    expect(names).toEqual(["MCP eval setup (merge)", "Claude MCP eval (merge)"]);
    expect(sessions.every((s) => s.closed)).toBe(true);
    // Fixture names carry the run's unique word; the prompt uses them.
    expect([...crm.people.values()].map((p) => p.familyName)).toEqual(["Varodin", "Varodin"]);
    const firstRequest = script.requests[0];
    expect(firstRequest?.messages[0]?.content).toContain("Daniel Varodin and Dan Varodin");
    expect(firstRequest?.system).toBe("CRM instructions\n\nToday's date is 2026-11-04 (UTC).");
    // Setup sends a reason with every call.
    expect(sessions[0]?.calls.find((c) => c.name === "person_create")?.args.reason).toBeTruthy();
  });

  it("fails with reasons when the model merges the wrong way round and does not mention approval", async () => {
    const crm = fakeCrm();
    const script = scriptedModel([
      message([
        toolUse("call_operation", {
          name: "person.merge",
          input: { survivorId: "per_2", mergedId: "per_1" },
          reason: "User asked",
        }),
      ]),
      message([text("Done, merged.")]),
    ]);
    const result = await runTask(mergeTask, deps(script, crm).value);
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual([
      "final reply does not tell the user the change is waiting for approval",
      "reason given for op:person.merge does not say the records are duplicates",
      "no pending merge of Dan into Daniel",
    ]);
  });

  it("records setup failures and model errors as task failures", async () => {
    const crm = fakeCrm();
    const broken = {
      ...deps(scriptedModel([]), crm).value,
      openSession: async () =>
        fakeSession({ person_create: () => ({ status: "pending_approval", actionId: "act_1" }) }),
    };
    const result = await runTask(mergeTask, broken);
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toMatch(
      /^setup failed: setup person_create was queued for approval/,
    );

    const noScript = await runTask(mergeTask, deps(scriptedModel([]), fakeCrm()).value);
    expect(noScript.failures).toEqual(["the script ran out"]);
  });

  it("rethrows fatal errors so the run stops", async () => {
    const value = { ...deps(scriptedModel([]), fakeCrm()).value, isFatal: () => true };
    await expect(runTask(mergeTask, value)).rejects.toThrow("the script ran out");
  });
});

describe("helpers", () => {
  it("makes capitalised pronounceable suffixes", () => {
    let i = 0;
    const seq = [0, 0, 0.5, 0.5, 0.99, 0.99, 0];
    expect(makeSuffix(() => seq[i++] ?? 0)).toBe("Banizun");
    expect(makeSuffix()).toMatch(/^[A-Z][a-z]{6}$/);
  });

  it("adds days across month ends and builds the system prompt", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-11-01", -1)).toBe("2026-10-31");
    expect(systemPrompt(undefined, "2026-11-04")).toBe("Today's date is 2026-11-04 (UTC).");
  });
});
