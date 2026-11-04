// An in-memory deployment for the harness tests, following the tool and operation contracts the
// eval relies on: extension_write / check / propose, person_create and organisation_create
// (curated), and through call_operation user.list, record.list, record.create, automation.list,
// automation.get, automation.test and automation.disable. A proposal installs nothing until the
// test "approves" it, as a person would in the Approvals inbox.
import { fakeSession } from "@crm/evals-mcp/test/fakes.ts";
import { type AutomationCase, cases } from "../prompts.ts";

export const USER_ID = "usr_eval";
export const EMAIL = "mcp-eval@example.com";

export interface FakeBehaviour {
  /** Overrides the test report (default: exactly what the case expects). */
  report?: (c: AutomationCase) => Record<string, unknown>;
  /** Overrides the summary text (default: the case's intent). */
  summary?: (c: AutomationCase) => string;
  /** Overrides the installed trigger type (default: the case's first). */
  triggerType?: (c: AutomationCase) => string;
}

const caseOf = (extensionId: string) =>
  [...cases]
    .sort((a, b) => b.idBase.length - a.idBase.length)
    .find((c) => extensionId.startsWith(c.idBase));

export function expectedReport(c: AutomationCase): Record<string, unknown> {
  const writes = Object.entries(c.expect.writes).flatMap(([object, n]) =>
    Array.from({ length: n }, (_, i) => ({ object, id: `sim_${i}`, action: "create", title: "t" })),
  );
  return {
    automationId: "x",
    record: null,
    matched: true,
    matchReason: "trigger matched",
    steps: [
      { name: "work", kind: "do", operations: [], logs: [] },
      ...Array.from({ length: c.expect.waits }, (_, i) => ({
        name: `wait${i}`,
        kind: "sleep",
        skippedMs: 86_400_000,
        operations: [],
        logs: [],
      })),
    ],
    writes,
    notifications: Array.from({ length: c.expect.notifications }, () => ({
      to: [USER_ID],
      toNames: ["MCP Eval"],
      type: "automation.message",
      title: "hello",
    })),
    approvals: [],
    policyPreset: "balanced",
    ok: true,
  };
}

export function fakeCrm(behaviour: FakeBehaviour = {}) {
  const files = new Map<string, string>();
  const proposed = new Set<string>();
  const installed = new Set<string>();
  const disabled = new Set<string>();
  const records: { object: string; id: string; values: Record<string, unknown> }[] = [];
  const tests: Record<string, unknown>[] = [];
  let seq = 0;

  const automationId = (extensionId: string) => `${extensionId}.auto`;
  const create = (object: string, values: Record<string, unknown>) => {
    seq += 1;
    const id = `rec_${seq}`;
    records.push({ object, id, values });
    return { id, object, values };
  };
  const operations: Record<string, (input: Record<string, unknown>) => unknown> = {
    "user.list": () => ({ items: [{ id: USER_ID, email: EMAIL }], nextCursor: null }),
    "record.list": (input) =>
      input.object === "deals.stage"
        ? { items: [{ id: `stg_${(input.filter as { value: string }).value}` }], nextCursor: null }
        : { items: [], nextCursor: null },
    "record.create": (input) =>
      create(String(input.object), input.values as Record<string, unknown>),
    "automation.list": (input) => ({
      items: [...installed]
        .filter((id) => !input.extensionId || id === input.extensionId)
        .map((id) => ({
          id: automationId(id),
          key: "auto",
          triggerType: "x",
          status: disabled.has(id) ? "disabled" : "active",
        })),
      killSwitch: false,
    }),
    "automation.get": (input) => {
      const extensionId = String(input.id).split(".")[0] ?? "";
      const c = caseOf(extensionId);
      if (!c || !installed.has(extensionId)) return { isError: true, error: { code: "not_found" } };
      return {
        id: input.id,
        spec: { trigger: { type: behaviour.triggerType?.(c) ?? c.triggers[0] } },
        summary: { segments: [], text: behaviour.summary?.(c) ?? c.intent },
        diagram: [],
      };
    },
    "automation.test": (input) => {
      tests.push(input);
      const c = caseOf(String(input.id).split(".")[0] ?? "");
      if (!c) return { isError: true, error: { code: "not_found" } };
      return { report: behaviour.report?.(c) ?? expectedReport(c) };
    },
    "automation.disable": (input) => {
      disabled.add(String(input.id).split(".")[0] ?? "");
      return { id: input.id, status: "disabled" };
    },
  };
  const check = (id: string) => {
    const source = files.get(id);
    if (source === undefined) return { isError: true, error: { code: "not_found" } };
    const broken = source.includes("BROKEN");
    return {
      ok: !broken,
      issues: broken ? [{ stage: "contract", code: "contract", message: "broken" }] : [],
      manifest: { id },
    };
  };
  const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
    extension_write: (args) => {
      files.set(String(args.id), (args.files as Record<string, string>)["index.ts"] ?? "");
      return { id: args.id, changed: ["index.ts"] };
    },
    extension_check: (args) => check(String(args.id)),
    extension_propose: (args) => {
      const result = check(String(args.id)) as { ok?: boolean; issues?: unknown[] };
      if (!result.ok) return { status: "check_failed", issues: result.issues };
      proposed.add(String(args.id));
      return { status: "pending_approval", changeSetId: `chs_${args.id}`, actionId: "act_1" };
    },
    person_create: (args) => create("person", args),
    organisation_create: (args) => create("organisation", args),
    call_operation: (args) => {
      const op = operations[String(args.name)];
      return op
        ? op((args.input ?? {}) as Record<string, unknown>)
        : { isError: true, error: { code: "unknown_operation" } };
    },
  };
  return {
    files,
    proposed,
    installed,
    disabled,
    records,
    tests,
    /** Approves every proposal so far: their automations are installed. */
    approveAll() {
      for (const id of proposed) installed.add(id);
    },
    openSession: async () => fakeSession(handlers, "CRM instructions"),
  };
}
