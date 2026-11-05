// Automation engine pieces that need no runtime (ADR 0130): the cron matcher in a timezone,
// trigger sources (record, fieldChanged incl. stage types, approvalDecided), event chunking, the
// queue sink's batching, retention of automation runs, and automation operations' permissions.
import { env } from "cloudflare:workers";
import type { AutomationManifest } from "@relationship-os/sdk";
import { describe, expect, it } from "vitest";
import {
  type ActingUser,
  type AutomationDefinition,
  type AutomationHost,
  type AutomationTestInput,
  type AutomationTestReport,
  approvalTriggerSource,
  coreRegistry,
  cronMatches,
  type InvocationContext,
  invoke,
  memoryEventSink,
  OperationError,
  PendingApprovalError,
  parseCron,
  purgeAutomationRuns,
  queueEventSink,
  type RecordEventMessage,
  recordEventMessages,
  recordTriggerSource,
  valueMatches,
  zonedTime,
} from "../src/index.ts";
import { context, createUser, db, setPreset, unique } from "./helpers.ts";

describe("cron", () => {
  const at = (iso: string, tz = "UTC") => zonedTime(new Date(iso), tz);

  it("matches fields, ranges, steps, lists and names", () => {
    const t = at("2026-11-06T09:30:00Z"); // a Friday
    expect(cronMatches("30 9 * * *", t)).toBe(true);
    expect(cronMatches("*/15 9-17 * * MON-FRI", t)).toBe(true);
    expect(cronMatches("0,30 9 6 NOV *", t)).toBe(true);
    expect(cronMatches("30 9 * * SAT,SUN", t)).toBe(false);
    expect(cronMatches("@hourly", at("2026-11-06T10:00:00Z"))).toBe(true);
    expect(cronMatches("0 0 * * 7", at("2026-11-08T00:00:00Z"))).toBe(true); // Sunday as 7
  });

  it("day of month and day of week: either matches when both are restricted", () => {
    expect(cronMatches("0 0 1 * MON", at("2026-11-02T00:00:00Z"))).toBe(true); // a Monday
    expect(cronMatches("0 0 1 * MON", at("2026-11-01T00:00:00Z"))).toBe(true); // the 1st
    expect(cronMatches("0 0 1 * MON", at("2026-11-03T00:00:00Z"))).toBe(false);
  });

  it("evaluates in the automation timezone, across DST", () => {
    // Sydney is UTC+11 in November (DST) and UTC+10 in June.
    expect(at("2026-11-05T22:30:00Z", "Australia/Sydney").minuteKey).toBe("2026-11-06T09:30");
    expect(at("2026-06-05T23:30:00Z", "Australia/Sydney").minuteKey).toBe("2026-06-06T09:30");
    expect(cronMatches("30 9 * * *", at("2026-11-05T22:30:00Z", "Australia/Sydney"))).toBe(true);
    expect(cronMatches("30 9 * * *", at("2026-11-05T22:30:00Z", "UTC"))).toBe(false);
  });

  it("rejects malformed expressions (and never matches them)", () => {
    expect(() => parseCron("61 * * * *")).toThrow();
    expect(() => parseCron("* * *")).toThrow();
    expect(cronMatches("nonsense", at("2026-11-06T09:30:00Z"))).toBe(false);
  });
});

function automation(id: string, spec: Partial<AutomationManifest>): AutomationDefinition {
  return {
    id,
    extensionId: id.split(".")[0] as string,
    key: id.split(".")[1] as string,
    commit: "c",
    spec: {
      label: id,
      description: id,
      steps: [{ name: "s" }],
      trigger: { type: "manual", object: "x", label: "x" },
      ...spec,
    } as AutomationManifest,
  };
}

function message(changes: RecordEventMessage["changes"], bulk = false): RecordEventMessage {
  return {
    v: 1,
    kind: "record",
    id: "aud_1:0",
    at: "2026-11-05T00:00:00Z",
    origin: {
      actor: "human",
      userId: "u",
      surface: "ui",
      operation: "op",
      rootEventId: "aud_1",
      depth: 0,
      chain: [],
      bulk,
    },
    changes,
  };
}

describe("trigger sources", () => {
  const onCreate = automation("a.onCreate", {
    trigger: { type: "record", object: "person", on: ["created"] },
  });
  const bulky = automation("a.bulky", {
    trigger: { type: "record", object: "person", on: ["created"], includeBulk: true },
  });
  const toTen = automation("a.toTen", {
    trigger: {
      type: "fieldChanged",
      object: "person",
      field: "level",
      from: { in: [1, 2] },
      to: 10,
    },
  });

  it("record: matches object and event; bulk only with includeBulk", () => {
    const m = message([{ object: "person", id: "per_1", action: "created" }]);
    expect(recordTriggerSource.match(m, [onCreate, bulky]).map((c) => c.automation.id)).toEqual([
      "a.onCreate",
      "a.bulky",
    ]);
    const b = message([{ object: "person", id: "per_1", action: "created" }], true);
    expect(recordTriggerSource.match(b, [onCreate, bulky]).map((c) => c.automation.id)).toEqual([
      "a.bulky",
    ]);
    expect(recordTriggerSource.match(m, [onCreate])[0]?.idempotencyKey).toBe("aud_1:0:per_1");
  });

  it("fieldChanged: from / to values", () => {
    const yes = message([
      { object: "person", id: "p", action: "updated", diff: { level: { before: 2, after: 10 } } },
    ]);
    const no = message([
      { object: "person", id: "p", action: "updated", diff: { level: { before: 3, after: 10 } } },
    ]);
    expect(recordTriggerSource.match(yes, [toTen])).toHaveLength(1);
    expect(recordTriggerSource.match(no, [toTen])).toHaveLength(0);
  });

  it("stage types compare the stage's type (the object's stages.status field)", () => {
    expect(valueMatches({ stageType: "won" }, "stg_x", "won")).toBe(true);
    expect(valueMatches({ stageType: "won" }, "stg_x", "open")).toBe(false);
    expect(valueMatches({ in: ["a", "b"] }, "b", undefined)).toBe(true);
    expect(valueMatches(null, null, undefined)).toBe(true);
  });

  it("approvalDecided: decision, operation and object filters", () => {
    const decided = automation("a.decided", {
      trigger: { type: "approvalDecided", decision: "approved", object: "person" },
    });
    const base = {
      v: 1 as const,
      kind: "approval" as const,
      id: "pac_1:approved",
      at: "2026-11-05T00:00:00Z",
      actionId: "pac_1",
      changeSetId: "chs_1",
      operation: "person.create",
      decidedBy: "u",
      records: [{ object: "person", id: "per_1" }],
      actionOrigin: { surface: "mcp" as const },
      origin: message([]).origin,
    };
    expect(approvalTriggerSource.match({ ...base, decision: "approved" }, [decided])).toHaveLength(
      1,
    );
    expect(approvalTriggerSource.match({ ...base, decision: "rejected" }, [decided])).toHaveLength(
      0,
    );
    expect(approvalTriggerSource.match({ ...base, decision: "expired" }, [decided])).toHaveLength(
      0,
    );
  });
});

describe("events", () => {
  it("chunks 100 changes per message with stable ids", () => {
    const changes = Array.from({ length: 250 }, (_, i) => ({
      object: "person",
      id: `per_${i}`,
      action: "update" as const,
      before: { name: "a" },
      after: { name: "b" },
    }));
    const messages = recordEventMessages(
      "aud_X",
      "2026-11-05T00:00:00Z",
      message([]).origin,
      changes,
    );
    expect(messages.map((m) => [m.id, m.changes.length])).toEqual([
      ["aud_X:0", 100],
      ["aud_X:1", 100],
      ["aud_X:2", 50],
    ]);
    expect(messages[0]?.changes[0]).toEqual({
      object: "person",
      id: "per_0",
      action: "updated",
      diff: { name: { before: "a", after: "b" } },
    });
  });

  it("the queue sink sends at most 100 messages per sendBatch", async () => {
    const calls: number[] = [];
    const sink = queueEventSink({
      async sendBatch(m) {
        calls.push([...m].length);
      },
    });
    const messages = recordEventMessages(
      "aud_Y",
      "2026-11-05T00:00:00Z",
      message([]).origin,
      Array.from({ length: 150 }, (_, i) => ({
        object: "task",
        id: `tsk_${i}`,
        action: "create" as const,
      })),
    );
    await sink.send([...messages, ...messages, ...messages, ...messages, ...messages]);
    expect(calls.every((n) => n <= 100)).toBe(true);
    expect(calls.reduce((a, b) => a + b, 0)).toBe(10);
    const memory = memoryEventSink();
    await memory.send(messages);
    expect(memory.sends).toBe(1);
  });
});

describe("automation operations", () => {
  it("are registered with their permissions and MCP exposure", () => {
    const op = (name: string) => coreRegistry.get(name);
    expect(op("automation.list")?.permission).toBe("records:read");
    expect(op("automation.list")?.mcp?.curated).toBe(true);
    expect(op("automation.get")?.mcp?.curated).toBe(true);
    expect(op("automation.test")?.mcp?.curated).toBe(true);
    expect(op("automation.enable")?.permission).toBe("settings:manage");
    expect(op("automation.disable")?.permission).toBe("settings:manage");
    expect(op("automation.run")?.permission).toBe("records:write");
    expect(op("automation.killSwitch")?.actors).toEqual(["human"]);
    expect(op("automation.killSwitch")?.mcp?.expose).toBe(false);
    expect(op("automation.updateSettings")?.mcp?.expose).toBe(false);
  });

  it("automation.test on an automation that is not installed is not_found, not internal", async () => {
    const admin = await createUser("admin");
    let asked = 0;
    // The runner says "No automation …" with a plain Error (an internal error); the operation
    // must answer before it is asked.
    const automationHost = {
      testAutomation: async () => {
        asked += 1;
        throw new Error("No automation pendingext.renewalTask");
      },
    } as unknown as AutomationHost; // only testAutomation is reachable from automation.test
    const error = await invoke(
      "automation.test",
      { id: "pendingext.renewalTask" },
      context(admin, { automationHost }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OperationError);
    expect((error as OperationError).code).toBe("not_found");
    expect((error as OperationError).message).toMatch(/approved/);
    expect(asked).toBe(0);
  });
});

describe("retention", () => {
  it("purges finished runs after 30 days (failed after 90) with their records, and old counters", async () => {
    const now = "2026-11-05T00:00:00.000Z";
    const old = "2026-09-01T00:00:00.000Z"; // 65 days
    const rows = [
      ["arn_OLDCOMPLETED", "completed", old],
      ["arn_OLDFAILED", "failed", old],
      ["arn_OLDWAITING", "waiting", old],
      ["arn_RECENT", "completed", "2026-11-01T00:00:00.000Z"],
    ];
    for (const [id, status, at] of rows) {
      await env.DB.prepare(
        "INSERT INTO core_automation_runs (id, automation_id, extension_id, trigger, status, started_at, updated_at) VALUES (?, 'r.x', 'r', '{}', ?, ?, ?)",
      )
        .bind(id, status, at, at)
        .run();
      await env.DB.prepare(
        "INSERT INTO core_automation_run_records (object_type, record_id, run_id, role, at) VALUES ('person', 'per_1', ?, 'trigger', ?)",
      )
        .bind(id, at)
        .run();
    }
    await env.DB.prepare(
      "INSERT INTO core_automation_counters (automation_id, hour, runs, writes) VALUES ('r.x', '2026-10-01T10', 1, 1), ('r.x', '2026-11-04T23', 1, 1)",
    ).run();
    const result = await purgeAutomationRuns(db.query, now);
    expect(result.deleted).toBe(1);
    const left = await env.DB.prepare(
      "SELECT id FROM core_automation_runs WHERE automation_id = 'r.x' ORDER BY id",
    ).all<{ id: string }>();
    expect(left.results.map((r) => r.id)).toEqual([
      "arn_OLDFAILED",
      "arn_OLDWAITING",
      "arn_RECENT",
    ]);
    const records = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_automation_run_records WHERE run_id = 'arn_OLDCOMPLETED'",
    ).first<{ n: number }>();
    expect(records?.n).toBe(0);
    const counters = await env.DB.prepare(
      "SELECT hour FROM core_automation_counters WHERE automation_id = 'r.x'",
    ).all<{ hour: string }>();
    expect(counters.results.map((r) => r.hour)).toEqual(["2026-11-04T23"]);
  });
});

// Stage 7b: automation.test on a proposed (not yet installed) automation (ADR 0133 amendment).
describe("automation.test on a proposal", () => {
  const calls: AutomationTestInput[] = [];
  let reply: Partial<AutomationTestReport> = {};
  const fakeHost: AutomationHost = {
    async testAutomation(input) {
      calls.push(input);
      return {
        automationId: input.draft
          ? `${input.draft.extensionId}.${input.draft.key}`
          : (input.automationId ?? ""),
        record: null,
        matched: true,
        matchReason: "This trigger has no record",
        steps: [],
        writes: [],
        notifications: [],
        approvals: [],
        policyPreset: "balanced",
        ok: true,
        stored: !input.draft,
        ...(input.draft ? { draft: input.draft } : {}),
        ...reply,
      };
    },
    startManualRun: async () => ({ runIds: [], skipped: 0 }),
    retryRun: async (runId) => ({ runId }),
    replayRun: async (runId) => ({ runId }),
    cancelRun: async (runId) => ({ runId }),
  };
  const ctx = (user: ActingUser, overrides: Partial<InvocationContext> = {}) =>
    context(user, { automationHost: fakeHost, ...overrides });
  const mcp = (user: ActingUser) =>
    ctx(user, {
      actor: "mcp",
      origin: { surface: "mcp", clientId: "c", clientName: "Test", sessionId: `cap_${unique()}` },
      reason: "Draft test",
    });

  /** A pending extension.apply action with its proposal row, queued by `user` over MCP. */
  async function proposal(user: ActingUser, commit = "c0ffee"): Promise<string> {
    await setPreset("cautious");
    let actionId = "";
    try {
      await invoke("person.create", { displayName: unique("Draft") }, mcp(user));
    } catch (error) {
      if (!(error instanceof PendingApprovalError)) throw error;
      actionId = error.pending.actionId;
    } finally {
      await setPreset("balanced");
    }
    expect(actionId).toMatch(/^pac_/);
    await env.DB.prepare(
      "UPDATE core_pending_action SET operation = 'extension.apply', risk = 'extension' WHERE id = ?",
    )
      .bind(actionId)
      .run();
    await env.DB.prepare(
      `INSERT INTO core_extension_proposals (action_id, extension_id, commit_oid, source, version,
         message, diff, impact, check_result, created_by, created_at)
       VALUES (?, 'draftx', ?, 'runtime', '1.0.0', 'm', '[]', '{}', '{"ok":true,"issues":[]}', ?, ?)`,
    )
      .bind(actionId, commit, user.id, new Date().toISOString())
      .run();
    return actionId;
  }

  it("takes exactly one of id or proposal", async () => {
    const admin = await createUser("admin");
    await expect(invoke("automation.test", {}, ctx(admin))).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      invoke(
        "automation.test",
        { id: "deals.wonOnboarding", proposal: { actionId: "pac_x", key: "a" } },
        ctx(admin),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("tests the proposed commit's automation while the proposal is pending", async () => {
    const member = await createUser("member");
    const actionId = await proposal(member, "feed01");
    calls.length = 0;
    const out = (await invoke(
      "automation.test",
      { proposal: { actionId, key: "onCreate" }, record: { object: "person", id: "per_1" } },
      mcp(member),
    )) as { report: AutomationTestReport };
    expect(calls).toEqual([
      {
        draft: { extensionId: "draftx", commit: "feed01", key: "onCreate" },
        record: { object: "person", id: "per_1" },
        userId: member.id,
      },
    ]);
    expect(out.report).toMatchObject({ stored: false, draft: { key: "onCreate" } });
    // A person (who can approve) sees it too.
    const admin = await createUser("admin");
    await invoke("automation.test", { proposal: { actionId, key: "onCreate" } }, ctx(admin));
  });

  it("is visible like the proposal: another user's agent cannot test it", async () => {
    const owner = await createUser("member");
    const other = await createUser("admin");
    const actionId = await proposal(owner);
    await expect(
      invoke("automation.test", { proposal: { actionId, key: "a" } }, mcp(other)),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      invoke("automation.test", { proposal: { actionId: "pac_missing", key: "a" } }, ctx(other)),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses a decided or expired proposal", async () => {
    const admin = await createUser("admin");
    const rejected = await proposal(admin);
    await env.DB.prepare("UPDATE core_pending_action SET status = 'rejected' WHERE id = ?")
      .bind(rejected)
      .run();
    await expect(
      invoke("automation.test", { proposal: { actionId: rejected, key: "a" } }, ctx(admin)),
    ).rejects.toMatchObject({ code: "invalid_input", details: { status: "rejected" } });
    const expired = await proposal(admin);
    await env.DB.prepare(
      "UPDATE core_pending_action SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
    )
      .bind(expired)
      .run();
    await expect(
      invoke("automation.test", { proposal: { actionId: expired, key: "a" } }, ctx(admin)),
    ).rejects.toMatchObject({ code: "invalid_input", details: { status: "expired" } });
  });

  it("turns an unknown key or a failed evaluation into a typed error", async () => {
    const admin = await createUser("admin");
    const actionId = await proposal(admin);
    reply = {
      ok: false,
      error: {
        code: "unknown_automation",
        message: 'The proposed draftx declares no automation "nope"',
      },
    };
    try {
      await expect(
        invoke("automation.test", { proposal: { actionId, key: "nope" } }, ctx(admin)),
      ).rejects.toMatchObject({
        code: "invalid_input",
        message: expect.stringMatching(/no automation "nope"/),
        details: { code: "unknown_automation", key: "nope" },
      });
    } finally {
      reply = {};
    }
  });
});
