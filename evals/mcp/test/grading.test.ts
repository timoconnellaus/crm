import { describe, expect, it } from "vitest";
import type { AgentRun, RecordedCall } from "../lib/agent.ts";
import { callLabel, callMatches, gradeTools, pendingCalls, reasonOf } from "../lib/grading.ts";

function call(
  name: string,
  input: Record<string, unknown> = {},
  result: unknown = {},
  isError = false,
): RecordedCall {
  return {
    promptIndex: 0,
    turn: 1,
    name,
    input,
    isError,
    resultText: JSON.stringify(result),
    result,
  };
}

function run(calls: RecordedCall[], finalText = ""): AgentRun {
  return {
    calls,
    replies: [finalText],
    finalText,
    stopReason: "end_turn",
    turns: 1,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

const PENDING = { status: "pending_approval", actionId: "act_1", operation: "person.merge" };

describe("callMatches", () => {
  it("matches tool names exactly", () => {
    expect(callMatches("person_create", call("person_create"))).toBe(true);
    expect(callMatches("person_create", call("person_update"))).toBe(false);
  });

  it("matches op: tokens through call_operation or the curated tool", () => {
    expect(callMatches("op:person.merge", call("call_operation", { name: "person.merge" }))).toBe(
      true,
    );
    expect(callMatches("op:person.merge", call("call_operation", { name: "person.delete" }))).toBe(
      false,
    );
    expect(callMatches("op:person.changeJob", call("person_changeJob"))).toBe(true);
    expect(
      callMatches("op:person.changeJob", call("call_operation", { name: "person.changeJob" })),
    ).toBe(true);
  });
});

describe("gradeTools", () => {
  it("passes when every expectation is met by a successful call", () => {
    const r = run([call("search_global"), call("person_create", { reason: "New lead" })]);
    expect(gradeTools({ expectTools: ["search_global", "person_create"] }, r)).toEqual([]);
  });

  it("fails a missing expected tool, and says when it was attempted but failed", () => {
    const r = run([call("person_create", {}, { error: {} }, true)]);
    expect(gradeTools({ expectTools: ["person_create", "search_global"] }, r)).toEqual([
      "expected a successful call to person_create (attempted, but it failed)",
      "expected a successful call to search_global",
    ]);
  });

  it("accepts any member of an anyOf group", () => {
    const rules = { expectTools: [{ anyOf: ["search_global", "query_sql", "op:person.list"] }] };
    expect(gradeTools(rules, run([call("query_sql")]))).toEqual([]);
    expect(gradeTools(rules, run([call("call_operation", { name: "person.list" })]))).toEqual([]);
    expect(gradeTools(rules, run([call("person_get")]))).toEqual([
      "expected a successful call to one of search_global, query_sql, op:person.list",
    ]);
  });

  it("fails forbidden tools even when they fail, but forbidSuccess only when they succeed", () => {
    const failedErase = call("call_operation", { name: "person.erase" }, { error: {} }, true);
    expect(gradeTools({ forbidSuccess: ["op:person.erase"] }, run([failedErase]))).toEqual([]);
    expect(gradeTools({ forbidTools: ["op:person.erase"] }, run([failedErase]))).toEqual([
      "called forbidden op:person.erase",
    ]);
    const erased = call("call_operation", { name: "person.erase" });
    expect(gradeTools({ forbidSuccess: ["op:person.erase"] }, run([erased]))).toEqual([
      "op:person.erase must not succeed, but it did",
    ]);
  });

  it("checks the final reply", () => {
    const rules = { expectText: [{ pattern: /approv/i, why: "mention approval" }] };
    expect(gradeTools(rules, run([], "This is waiting for approval."))).toEqual([]);
    expect(gradeTools(rules, run([], "Done!"))).toEqual(["final reply does not mention approval"]);
  });

  it("checks reasons, including call_operation's top-level reason", () => {
    const rules = {
      expectReason: [{ tool: "op:person.merge", pattern: /duplicate/i, why: "say why" }],
    };
    const merge = (reason: string) =>
      call("call_operation", { name: "person.merge", input: {}, reason }, PENDING);
    expect(gradeTools(rules, run([merge("Duplicate of Daniel")]))).toEqual([]);
    expect(gradeTools(rules, run([merge("User asked")]))).toEqual([
      "reason given for op:person.merge does not say why",
    ]);
    expect(reasonOf(call("x", { input: { reason: "inner" } }))).toBe("inner");
  });
});

describe("pending calls and labels", () => {
  it("finds pending results and labels calls for the report", () => {
    const calls = [
      call("call_operation", { name: "person.merge" }, PENDING),
      call("person_create", {}, { id: "per_1" }),
      call("person_update", {}, { error: {} }, true),
    ];
    expect(pendingCalls(run(calls))).toHaveLength(1);
    expect(pendingCalls(run(calls), "op:person.merge")).toHaveLength(1);
    expect(pendingCalls(run(calls), "person_create")).toHaveLength(0);
    expect(calls.map(callLabel)).toEqual([
      "call_operation(person.merge) ⏳",
      "person_create",
      "person_update ✗",
    ]);
  });
});
