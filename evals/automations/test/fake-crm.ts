// An in-memory deployment for the harness tests, following the tool and operation contracts the
// eval relies on: extension_write / check / propose, person_create and organisation_create
// (curated), and through call_operation user.list, record.list, record.create, automation.list,
// automation.get, automation.test and automation.disable. A proposal installs nothing until the
// test "approves" it, as a person would in the Approvals inbox.
import { fakeSession } from "@relationship-os/evals-mcp/test/fakes.ts";
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
  /** Overrides the pipelines and stages (default: the Deals extension's seeded ones). */
  pipelines?: FakePipeline[];
  /** The installed automation's declarations (default: only its trigger type). */
  spec?: (c: AutomationCase) => Record<string, unknown>;
  /** What extension.proposal says the product's intent check found. */
  intentCheck?: (c: AutomationCase) => Record<string, unknown> | null;
}

export interface FakeStage {
  id: string;
  position: number;
  type: "open" | "won" | "lost";
  requiredFields?: string[];
}

export interface FakePipeline {
  id: string;
  name: string;
  position: number;
  stages: FakeStage[];
}

/**
 * The Deals extension's seeded pipelines (extensions/deals/index.ts). Renewals is listed first and
 * its stages share positions with New business, as on a seeded database where a stage picked by
 * type and position alone lands in Renewals.
 */
export const DEALS_PIPELINES: FakePipeline[] = [
  {
    id: "pip_renewals",
    name: "Renewals",
    position: 2,
    stages: [
      { id: "stg_rnUpcoming", position: 1, type: "open", requiredFields: ["organisation"] },
      { id: "stg_rnInDiscussion", position: 2, type: "open", requiredFields: ["value"] },
      { id: "stg_rnRenewed", position: 4, type: "won", requiredFields: ["value"] },
      { id: "stg_rnChurned", position: 5, type: "lost" },
    ],
  },
  {
    id: "pip_newBusiness",
    name: "New business",
    position: 1,
    stages: [
      { id: "stg_nbLead", position: 1, type: "open" },
      { id: "stg_nbQualified", position: 2, type: "open", requiredFields: ["owner"] },
      { id: "stg_nbWon", position: 5, type: "won", requiredFields: ["value"] },
      { id: "stg_nbLost", position: 6, type: "lost" },
    ],
  },
];

type Condition = { field: string; op: string; value: unknown };
const conditionsOf = (filter: unknown): Condition[] =>
  !filter
    ? []
    : "and" in (filter as object)
      ? (filter as { and: unknown[] }).and.flatMap(conditionsOf)
      : [filter as Condition];

/** The host's stage rules on creating a deal (extensions/deals/README.md, Behaviour). */
function stageRuleError(pipelines: FakePipeline[], values: Record<string, unknown>) {
  const pipeline = pipelines.find((p) => p.stages.some((s) => s.id === values.stage));
  const stage = pipeline?.stages.find((s) => s.id === values.stage);
  const invalid = (message: string, details: Record<string, unknown> = {}) => ({
    isError: true,
    error: { code: "invalid_input", message, details },
  });
  if (!pipeline || !stage) return invalid(`unknown stage ${String(values.stage)}`);
  const inPipeline =
    pipeline.id === (values.pipeline ?? pipelines.find((p) => p.name === "New business")?.id);
  if (!inPipeline) return invalid("The stage is not in the deal's pipeline");
  const required = [
    ...(stage.requiredFields ?? []),
    ...(stage.type === "lost" ? ["lostReason"] : []),
  ];
  const missing = required.find((field) => values[field] === undefined || values[field] === null);
  return missing
    ? invalid(`${stage.id} needs ${missing}`, { rule: "stage_required_fields", field: missing })
    : null;
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
  const pipelines = behaviour.pipelines ?? DEALS_PIPELINES;
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
    "record.list": (input) => {
      const byPosition = <T extends { position: number }>(a: T, b: T) => a.position - b.position;
      if (input.object === "deals.pipeline") {
        const items = [...pipelines]
          .sort(byPosition)
          .map((p) => ({ id: p.id, values: { name: p.name, position: p.position } }));
        return { items, nextCursor: null };
      }
      if (input.object !== "deals.stage") return { items: [], nextCursor: null };
      const where = conditionsOf(input.filter);
      const items = pipelines
        .flatMap((p) =>
          p.stages.map((s) => ({ ...s, pipeline: p.id }) as FakeStage & Record<string, unknown>),
        )
        .filter((s) => where.every((c) => c.op === "eq" && s[c.field] === c.value))
        .sort(byPosition)
        .slice(0, Number(input.limit ?? 50))
        .map((s) => ({
          id: s.id,
          values: { pipeline: s.pipeline, type: s.type, requiredFields: s.requiredFields ?? [] },
        }));
      return { items, nextCursor: null };
    },
    "record.create": (input) => {
      const values = input.values as Record<string, unknown>;
      if (input.object === "deals.deal") {
        const error = stageRuleError(pipelines, values);
        if (error) return error;
      }
      return create(String(input.object), values);
    },
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
        spec: behaviour.spec?.(c) ?? {
          trigger: { type: behaviour.triggerType?.(c) ?? c.triggers[0] },
        },
        summary: { segments: [], text: behaviour.summary?.(c) ?? c.intent },
        diagram: [],
      };
    },
    "extension.proposal": () => ({ intentCheck: null }),
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
