// Grading the tool choice of a run. A tool token is either a tool name ("search_global") or an
// operation ("op:person.merge"), which matches call_operation with that name or the curated tool
// for it (person.changeJob → person_changeJob), so a task need not care which route the model took.
import type { AgentRun, RecordedCall } from "./agent.ts";
import { isPending } from "./mcp.ts";

export type ToolToken = string;
export type ToolExpectation = ToolToken | { anyOf: ToolToken[] };

export interface TextExpectation {
  pattern: RegExp;
  /** What the pattern stands for, shown when it fails. */
  why: string;
}

export interface ReasonExpectation {
  /** The write call whose reason is checked. */
  tool: ToolToken;
  pattern: RegExp;
  why: string;
}

export interface ToolRules {
  /** Each must be matched by at least one call that did not fail. */
  expectTools?: ToolExpectation[];
  /** No call may match these at all. */
  forbidTools?: ToolToken[];
  /** No call matching these may succeed (an attempt that fails is fine). */
  forbidSuccess?: ToolToken[];
  /** Checked against the reply to the last prompt; all must match. */
  expectText?: TextExpectation[];
  /** A succeeding call matching `tool` must have a reason matching `pattern`. */
  expectReason?: ReasonExpectation[];
}

/** MCP tool names use `_` where operation names use `.`. */
export const toolNameFor = (operation: string) => operation.replace(/\./g, "_");

/** The operation a call runs: call_operation's `name`, or null for a curated tool. */
export function calledOperation(call: RecordedCall): string | null {
  return call.name === "call_operation" && typeof call.input.name === "string"
    ? call.input.name
    : null;
}

export function callMatches(token: ToolToken, call: RecordedCall): boolean {
  if (token.startsWith("op:")) {
    const operation = token.slice(3);
    return calledOperation(call) === operation || call.name === toolNameFor(operation);
  }
  return call.name === token;
}

export const succeeded = (call: RecordedCall) => !call.isError;

/** The `reason` a call gave: top level, or inside call_operation's input as a fallback. */
export function reasonOf(call: RecordedCall): string | null {
  if (typeof call.input.reason === "string") return call.input.reason;
  const inner = call.input.input as Record<string, unknown> | undefined;
  return typeof inner?.reason === "string" ? inner.reason : null;
}

const describe = (e: ToolExpectation) =>
  typeof e === "string" ? e : `one of ${e.anyOf.join(", ")}`;

/** Failure reasons for the tool rules (empty when they all hold). */
export function gradeTools(rules: ToolRules, run: AgentRun): string[] {
  const failures: string[] = [];
  const ok = run.calls.filter(succeeded);
  for (const expectation of rules.expectTools ?? []) {
    const tokens = typeof expectation === "string" ? [expectation] : expectation.anyOf;
    if (!ok.some((call) => tokens.some((t) => callMatches(t, call)))) {
      const attempted = run.calls.some((call) => tokens.some((t) => callMatches(t, call)));
      failures.push(
        `expected a successful call to ${describe(expectation)}${attempted ? " (attempted, but it failed)" : ""}`,
      );
    }
  }
  for (const token of rules.forbidTools ?? []) {
    if (run.calls.some((call) => callMatches(token, call)))
      failures.push(`called forbidden ${token}`);
  }
  for (const token of rules.forbidSuccess ?? []) {
    if (ok.some((call) => callMatches(token, call))) {
      failures.push(`${token} must not succeed, but it did`);
    }
  }
  for (const text of rules.expectText ?? []) {
    if (!text.pattern.test(run.finalText)) failures.push(`final reply does not ${text.why}`);
  }
  for (const reason of rules.expectReason ?? []) {
    const calls = ok.filter((call) => callMatches(reason.tool, call));
    if (!calls.some((call) => reason.pattern.test(reasonOf(call) ?? ""))) {
      failures.push(`reason given for ${reason.tool} does not ${reason.why}`);
    }
  }
  return failures;
}

/** Calls that came back pending approval, optionally only those running `token`. */
export function pendingCalls(run: AgentRun, token?: ToolToken): RecordedCall[] {
  return run.calls.filter(
    (call) => isPending(call.result) && (token === undefined || callMatches(token, call)),
  );
}

/** A compact label for the report: the tool, and the operation for call_operation. */
export function callLabel(call: RecordedCall): string {
  const operation = calledOperation(call);
  const base = operation ? `call_operation(${operation})` : call.name;
  if (call.isError) return `${base} ✗`;
  return isPending(call.result) ? `${base} ⏳` : base;
}
