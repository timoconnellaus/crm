// Grading an automation: its test-mode report against the case's expected writes, notifications
// and waits; its host summary against the case's keyword groups; and an LLM judge (the eval's own
// model, Workers AI by default) that rules whether the summary states the intent, by a rubric.
import {
  type ModelClient,
  type ModelParams,
  samplingFields,
} from "@relationship-os/evals-mcp/lib/model.ts";
import type { AutomationCase } from "../prompts.ts";

/**
 * The slice of AutomationTestReport (packages/core/src/automations/types.ts) graded here. Kept as
 * a structural copy so the eval stays a plain-Node package without @relationship-os/core.
 */
export interface TestReport {
  matched: boolean;
  matchReason?: string;
  ok: boolean;
  steps: { name: string; kind: string; skippedMs?: number }[];
  writes: { object: string; id?: string; action: string; title?: string | null }[];
  notifications: { to: string[]; toNames?: string[]; type?: string; title: string }[];
  approvals?: { operation: string; reason: string }[];
  error?: { code: string; message: string };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The report from an automation.test result (`{ report }`), or null when it is not one. */
export function parseTestReport(value: unknown): TestReport | null {
  const report = isRecord(value) && isRecord(value.report) ? value.report : value;
  if (!isRecord(report) || typeof report.matched !== "boolean") return null;
  const list = (key: string) => (Array.isArray(report[key]) ? (report[key] as unknown[]) : []);
  return {
    matched: report.matched,
    ...(typeof report.matchReason === "string" ? { matchReason: report.matchReason } : {}),
    ok: report.ok !== false,
    steps: list("steps")
      .filter(isRecord)
      .map((s) => ({
        name: String(s.name ?? ""),
        kind: String(s.kind ?? "do"),
        ...(typeof s.skippedMs === "number" ? { skippedMs: s.skippedMs } : {}),
      })),
    writes: list("writes")
      .filter(isRecord)
      .map((w) => ({
        object: String(w.object ?? ""),
        action: String(w.action ?? "create"),
        ...(typeof w.id === "string" ? { id: w.id } : {}),
        title: typeof w.title === "string" ? w.title : null,
      })),
    notifications: list("notifications")
      .filter(isRecord)
      .map((n) => ({
        to: Array.isArray(n.to) ? n.to.map(String) : [],
        ...(Array.isArray(n.toNames) ? { toNames: n.toNames.map(String) } : {}),
        ...(typeof n.type === "string" ? { type: n.type } : {}),
        title: String(n.title ?? ""),
      })),
    ...(isRecord(report.error)
      ? { error: { code: String(report.error.code), message: String(report.error.message) } }
      : {}),
  };
}

/** What the test run did, condensed for the report. */
export interface TestOutcome {
  matched: boolean;
  writes: Record<string, number>;
  notifications: number;
  waits: number;
}

export function outcomeOf(report: TestReport): TestOutcome {
  const writes: Record<string, number> = {};
  for (const w of report.writes) writes[w.object] = (writes[w.object] ?? 0) + 1;
  return {
    matched: report.matched,
    writes,
    notifications: report.notifications.length,
    waits: report.steps.filter((s) => s.kind === "sleep" || s.kind === "waitForEvent").length,
  };
}

/** Failure messages for a test report; empty when it shows what the case expects. */
export function gradeTest(c: AutomationCase, report: TestReport, userId: string | null): string[] {
  const failures: string[] = [];
  const got = outcomeOf(report);
  if (!report.ok) {
    failures.push(
      `the test run failed: ${report.error ? `${report.error.code}: ${report.error.message}` : "ok is false"}`,
    );
  }
  if (!report.matched) {
    failures.push(
      `the trigger did not match the seeded record${report.matchReason ? ` (${report.matchReason})` : ""}`,
    );
  }
  const objects = new Set([...Object.keys(c.expect.writes), ...Object.keys(got.writes)]);
  for (const object of [...objects].sort()) {
    const want = c.expect.writes[object] ?? 0;
    const have = got.writes[object] ?? 0;
    if (want !== have)
      failures.push(`expected ${want} ${object} write(s), the test run had ${have}`);
  }
  if (got.notifications !== c.expect.notifications) {
    failures.push(
      `expected ${c.expect.notifications} notification(s), the test run had ${got.notifications}`,
    );
  }
  if (c.expect.notify && userId && got.notifications > 0) {
    const reached = report.notifications.some((n) => n.to.includes(userId));
    if (!reached) {
      failures.push(
        `the notification should reach the ${c.expect.notify === "owner" ? "record's owner" : "admins"} (the eval user ${userId}); it went to ${report.notifications.map((n) => n.to.join(", ") || "nobody").join("; ")}`,
      );
    }
  }
  if (got.waits !== c.expect.waits) {
    failures.push(`expected ${c.expect.waits} wait(s), the test run had ${got.waits}`);
  }
  return failures;
}

/** Keyword groups the summary misses (each group needs one match). */
export function keywordFailures(c: AutomationCase, summary: string): string[] {
  return c.keywords
    .filter((group) => !group.some((pattern) => pattern.test(summary)))
    .map((group) => `the summary does not mention ${group.map((p) => p.source).join(" or ")}`);
}

export interface JudgeVerdict {
  pass: boolean;
  reason: string;
}

export const JUDGE_RUBRIC = `You grade whether a CRM automation's plain-English summary matches what a user asked for.
The summary was generated by the CRM from the automation's declared trigger, conditions and steps.
Pass only if ALL of these hold:
1. Trigger: it starts on the event the user described (same object, same change, schedule or date rule).
2. Actions: it creates the records and sends the notifications the user asked for, to the people they named (owner, admins, …), with matching counts when the user gave them.
3. Timing: any wait or offset the user gave (e.g. "after 2 days", "7 days before") is stated.
4. Nothing important is added that the user did not ask for (e.g. extra notifications or deletes).
Wording may differ; judge meaning, not phrasing.
Answer with JSON only: {"verdict": "pass" | "fail", "reason": "<one sentence>"}`;

/** The judge's verdict from its reply text; null when it is not parseable. */
export function parseVerdict(text: string): JudgeVerdict | null {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return null;
  try {
    const value = JSON.parse(match[0]) as unknown;
    if (!isRecord(value)) return null;
    const verdict = String(value.verdict ?? "").toLowerCase();
    if (verdict !== "pass" && verdict !== "fail") return null;
    return { pass: verdict === "pass", reason: String(value.reason ?? "") };
  } catch {
    return null;
  }
}

/** Asks the model whether `summary` states the case's intent. One retry on an unparseable reply. */
export async function judgeSummary(
  model: ModelClient,
  modelId: string,
  c: AutomationCase,
  summary: string,
  params: ModelParams = {},
): Promise<JudgeVerdict> {
  const user =
    `The user asked: ${c.request}\n` +
    `Intended behaviour: ${c.intent}\n\n` +
    `The CRM's summary of the automation:\n${summary}`;
  let last = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await model.createCompletion({
      model: modelId,
      messages: [
        { role: "system", content: JUDGE_RUBRIC },
        { role: "user", content: user },
      ],
      ...samplingFields({ ...params, temperature: 0 }),
      // A verdict is short; the cap bounds the thinking that counts against it.
      max_tokens: params.maxTokens ?? 8000,
    });
    last = response.choices[0]?.message.content ?? "";
    const verdict = parseVerdict(last);
    if (verdict) return verdict;
  }
  return { pass: false, reason: `the judge gave no verdict: ${last.slice(0, 200)}` };
}
