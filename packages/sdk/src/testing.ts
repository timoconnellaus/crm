// @crm/sdk/testing: unit-test an extension locally with in-memory host modules.
//
//   const host = createTestHost(extension, { records: { organisation: [{ id: "org_1", name: "Acme" }] } });
//   expect(host.issues).toEqual([]);
//   const out = await host.runTool("scoreOrganisation", { organisationId: "org_1" });
//   expect(host.calls).toContainEqual({ operation: "record.get", input: { ... } });
//
// The in-memory `crm` module enforces the extension's declared permissions with the host's rules
// (`checkGrant`) and implements the generic record operations over an in-memory store. Pass
// `operations` to fake anything else.
//
// Automations run in memory too, start to finish, without the Workflow:
//
//   const run = await host.runAutomation("wonOnboarding", { record: { object: "deals.deal", id: "d1" } });
//   expect(run.steps.map((s) => s.name)).toEqual(["createTasks", "notifyOwner", "wait", "notifyManager"]);
//   expect(run.notifications[0]?.userIds).toEqual(["usr_owner"]);
//
// `step.do` runs its function, `step.sleep` and `step.waitForEvent` return at once (recorded with
// how long they would wait; pass `events` for waitForEvent payloads), and every step name is held
// to the automation's declarations like the host does. Writes and notifications a step did not
// declare are listed in `undeclared`.
import {
  type AutomationContext,
  type AutomationEvent,
  type AutomationStepApi,
  type AutomationTestStep,
  durationMs,
  type NotificationSendInput,
  notificationInput,
} from "./automation.ts";
import type { AiModule, Extension } from "./contract.ts";
import type { ExtensionManifest, ManifestIssue, ValidateOptions } from "./manifest.ts";
import { CORE_OBJECT_NAMES, toManifest, validateManifest } from "./manifest.ts";
import { checkGrant } from "./permissions.ts";
import { buildContext, type RawHostModules, runExtension } from "./runtime.ts";

type Values = Record<string, unknown> & { id: string };
type OperationFake = (input: Record<string, unknown>) => unknown;

export interface TestHostOptions {
  /** Seed records by object name (`organisation`, `example.project`). */
  records?: Record<string, Values[]>;
  /** Fakes for operations the harness does not implement, by name. */
  operations?: Record<string, OperationFake>;
  /** Fakes for the AI module. Default: deterministic stand-ins. */
  ai?: Partial<AiModule>;
  /** Passed to validateManifest. */
  validate?: ValidateOptions;
  /**
   * Users `notification.send` resolves (`{ role: "admin" }`, `managerOf`). Default one admin,
   * `usr_admin`.
   */
  users?: { id: string; role: "admin" | "member" | "viewer" }[];
}

/** A notification the in-memory `notification.send` delivered. */
export interface SentNotification extends Omit<NotificationSendInput, "type" | "dedupeKey"> {
  type: string;
  dedupeKey: string | null;
  /** Resolved, deduplicated recipients. */
  userIds: string[];
  notes: string[];
  /** The step that sent it (null: outside a step). */
  step: string | null;
}

export interface AutomationRunOptions {
  /** The trigger record, from the seeded `records`. */
  record?: { object: string; id: string };
  change?: AutomationEvent["change"];
  period?: string;
  manual?: AutomationEvent["manual"];
  approval?: AutomationEvent["approval"];
  /** waitForEvent payloads by step name. Default null (the wait timed out). */
  events?: Record<string, unknown>;
  runId?: string;
  /** `event.test`. Default false: the run writes to the in-memory store. */
  test?: boolean;
}

export interface AutomationRunResult {
  /** False when the declared conditions did not match the trigger record (nothing ran). */
  matched: boolean;
  /** What `run` returned. */
  value: unknown;
  /** Set when `run` threw (a step failed, or an undeclared step name). */
  error: { code: string; message: string } | null;
  /** Every step in the order it ran; waits carry `skippedMs`. */
  steps: (AutomationTestStep & { calls: TestHost["calls"] })[];
  /** Record writes the run made (operation, object, the created or changed id). */
  writes: { step: string | null; operation: string; object: string | null; id: string | null }[];
  notifications: SentNotification[];
  /** Effects no declaration covers, e.g. "step notifyOwner wrote task (not in its writes)". */
  undeclared: string[];
}

/** Thrown into `run` when it uses a step name it did not declare (the host refuses it too). */
export class AutomationStepError extends Error {
  override name = "AutomationStepError";
  readonly code = "undeclared_step";
}

export class ExtensionToolError extends Error {
  override name = "ExtensionToolError";
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface TestHost {
  manifest: ExtensionManifest;
  /** Contract and formula issues (`extension.check` minus typecheck and dry-run reconcile). */
  issues: ManifestIssue[];
  /** Runs a tool like the host does: input and output validated, ctx from in-memory modules. */
  runTool<T = unknown>(tool: string, input: unknown): Promise<T>;
  /** Every codemode:crm call, in order (allowed or refused). */
  calls: { operation: string; input: unknown; allowed: boolean }[];
  logs: { level: string; message: string; data: unknown }[];
  storage: Map<string, unknown>;
  records: Map<string, Map<string, Values>>;
  /** Every notification sent through the in-memory `notification.send`. */
  notifications: SentNotification[];
  /**
   * Runs automation `name` in memory, start to finish: conditions checked on the trigger
   * record, waits skipped (and recorded), steps held to the declarations.
   */
  runAutomation(name: string, options?: AutomationRunOptions): Promise<AutomationRunResult>;
}

function riskOf(operation: string): string {
  const verb = operation.split(".").at(-1) ?? "";
  if (/^(get|list|search|listForRecord|listMine|sql|global|count|unreadCount)$/.test(verb))
    return "read";
  if (/^(delete|erase|merge|deleteMany)$/.test(verb)) return "destructive";
  return "write";
}

function objectOf(operation: string, input: Record<string, unknown>): string | null {
  if (operation.startsWith("record."))
    return typeof input.object === "string" ? input.object : null;
  const prefix = operation.split(".")[0] ?? "";
  return (CORE_OBJECT_NAMES as readonly string[]).includes(prefix) ? prefix : null;
}

let sequence = 0;

export function createTestHost(extension: Extension, options: TestHostOptions = {}): TestHost {
  const { manifest: validated, issues } = validateManifest(toManifest(extension), options.validate);
  const manifest = validated ?? toManifest(extension);
  const records = new Map<string, Map<string, Values>>();
  for (const [object, rows] of Object.entries(options.records ?? {})) {
    records.set(object, new Map(rows.map((row) => [row.id, { ...row }])));
  }
  const table = (object: string) => {
    let rows = records.get(object);
    if (!rows) {
      rows = new Map();
      records.set(object, rows);
    }
    return rows;
  };
  const calls: TestHost["calls"] = [];
  const logs: TestHost["logs"] = [];
  const storage = new Map<string, unknown>();

  // Records are stored flat ({ id, ...values }) and returned in the host's record shape.
  const titleOf = (object: string, row: Values): string | null => {
    const local = object.startsWith(`${manifest.id}.`)
      ? object.slice(manifest.id.length + 1)
      : null;
    const field = local ? manifest.objects[local]?.titleField : undefined;
    const title = field ? row[field] : (row.name ?? row.displayName ?? row.title);
    return title == null ? null : String(title);
  };
  const shape = (object: string, row: Values) => {
    const { id, ...values } = row;
    return { object, id, title: titleOf(object, row), values, createdAt: null, updatedAt: null };
  };
  const matches = (row: Values, filter: unknown): boolean => {
    if (!filter || typeof filter !== "object") return true;
    const f = filter as {
      and?: unknown[];
      or?: unknown[];
      field?: string;
      op?: string;
      value?: unknown;
    };
    if (f.and) return f.and.every((child) => matches(row, child));
    if (f.or) return f.or.some((child) => matches(row, child));
    const value = f.field ? row[f.field] : undefined;
    switch (f.op) {
      case "eq":
        return value === f.value;
      case "neq":
        return value !== f.value;
      case "is_null":
        return value == null;
      case "is_not_null":
        return value != null;
      case "in":
        return Array.isArray(f.value) && f.value.includes(value);
      case "not_in":
        return Array.isArray(f.value) && !f.value.includes(value);
      case "lt":
        return value != null && (value as never) < (f.value as never);
      case "lte":
        return value != null && (value as never) <= (f.value as never);
      case "gt":
        return value != null && (value as never) > (f.value as never);
      case "gte":
        return value != null && (value as never) >= (f.value as never);
      case "contains":
        return String(value ?? "").includes(String(f.value));
      case "not_contains":
        return !String(value ?? "").includes(String(f.value));
      case "starts_with":
        return String(value ?? "").startsWith(String(f.value));
      case "ends_with":
        return String(value ?? "").endsWith(String(f.value));
      default:
        throw new ExtensionToolError(
          "unsupported",
          `The test host does not fake filter op ${f.op}`,
        );
    }
  };
  const builtIn: Record<string, OperationFake> = {
    "record.create": (input) => {
      sequence += 1;
      const object = String(input.object);
      const id = `rec_test${sequence}`;
      const row = { ...(input.values as Record<string, unknown>), id };
      table(object).set(id, row);
      return shape(object, row);
    },
    "record.get": (input) => {
      const object = String(input.object);
      const row = table(object).get(String(input.id));
      if (!row) throw new ExtensionToolError("not_found", `No ${object} with id ${input.id}`);
      return shape(object, row);
    },
    "record.update": (input) => {
      const object = String(input.object);
      const rows = table(object);
      const row = rows.get(String(input.id));
      if (!row) throw new ExtensionToolError("not_found", `No ${object} with id ${input.id}`);
      const next = { ...row, ...(input.values as Record<string, unknown>), id: row.id };
      rows.set(row.id, next);
      return shape(object, next);
    },
    "record.delete": (input) => {
      table(String(input.object)).delete(String(input.id));
      return { id: input.id };
    },
    "record.list": (input) => {
      const object = String(input.object);
      return {
        items: [...table(object).values()]
          .filter((row) => matches(row, input.filter))
          .map((row) => shape(object, row)),
        nextCursor: null,
      };
    },
  };
  for (const object of CORE_OBJECT_NAMES) {
    builtIn[`${object}.get`] = (input) => builtIn["record.get"]?.({ ...input, object });
  }

  // Tasks, in the task operations' shape (status, assignee, links).
  const taskShape = (row: Values) => ({
    title: null,
    notes: null,
    dueAt: null,
    status: "open",
    assigneeId: null,
    links: [],
    ...row,
  });
  const requireTask = (id: unknown) => {
    const row = table("task").get(String(id));
    if (!row) throw new ExtensionToolError("not_found", `No task with id ${id}`);
    return row;
  };
  Object.assign(builtIn, {
    "task.create": (input: Record<string, unknown>) => {
      sequence += 1;
      const row: Values = {
        status: "open",
        assigneeId: null,
        links: [],
        ...input,
        id: `tsk_test${sequence}`,
      };
      table("task").set(row.id, row);
      return taskShape(row);
    },
    "task.get": (input: Record<string, unknown>) => taskShape(requireTask(input.id)),
    "task.update": (input: Record<string, unknown>) => {
      const row = { ...requireTask(input.id), ...input } as Values;
      table("task").set(row.id, row);
      return taskShape(row);
    },
    "task.complete": (input: Record<string, unknown>) => {
      const row = { ...requireTask(input.id), status: "done" } as Values;
      table("task").set(row.id, row);
      return taskShape(row);
    },
    "task.list": (input: Record<string, unknown>) => {
      const linked = (row: Values, filter: unknown): boolean => {
        const f = filter as { and?: unknown[]; field?: string; value?: unknown } | undefined;
        if (f?.and) return f.and.every((child) => linked(row, child));
        if (f?.field !== "linkedRecordId") return matches(row, f);
        return (row.links as { id: string }[]).some((link) => link.id === f.value);
      };
      return {
        items: [...table("task").values()]
          .filter((row) => linked(row, input.filter))
          .map(taskShape),
        nextCursor: null,
      };
    },
  });

  // notification.send: resolves recipients like the host (managerOf → the admins, with a note,
  // since users have no manager field) and keeps one notification per (user, dedupeKey).
  const users = options.users ?? [{ id: "usr_admin", role: "admin" as const }];
  const notifications: SentNotification[] = [];
  const delivered = new Set<string>();
  let currentStep: string | null = null;
  let observer:
    | ((operation: string, input: Record<string, unknown>, value: unknown) => void)
    | null = null;
  builtIn["notification.send"] = (input) => {
    const notes: string[] = [];
    const admins = users.filter((u) => u.role === "admin").map((u) => u.id);
    const ids: string[] = [];
    for (const to of input.to as Record<string, unknown>[]) {
      if (typeof to.userId === "string") ids.push(to.userId);
      else if (to.role === "admin") ids.push(...admins);
      else if (typeof to.managerOf === "string") {
        notes.push("no manager field: sent to admins");
        ids.push(...admins);
      } else if (typeof to.field === "string") {
        const ref = to.record as { object: string; id: string };
        const value = table(ref.object).get(ref.id)?.[to.field];
        if (typeof value === "string" && value) ids.push(value);
        else notes.push(`${ref.object} ${ref.id} has no ${to.field}`);
      }
    }
    const key = typeof input.dedupeKey === "string" ? input.dedupeKey : null;
    const userIds = [...new Set(ids)].filter((id) => !key || !delivered.has(`${id}\n${key}`));
    for (const id of userIds) if (key) delivered.add(`${id}\n${key}`);
    const { dedupeKey: _key, type, ...rest } = input as unknown as NotificationSendInput;
    notifications.push({
      ...rest,
      type: String(type ?? "system.message"),
      dedupeKey: key,
      userIds,
      notes,
      step: currentStep,
    });
    return { sent: userIds.length, userIds, notes };
  };

  const has = (name: string) => manifest.permissions.modules.includes(name as never);
  const raw: RawHostModules = {};
  if (has("crm")) {
    raw.crm = {
      call: async (operation, input) => {
        const name = String(operation);
        const body = (input ?? {}) as Record<string, unknown>;
        const decision = checkGrant(manifest.id, manifest.permissions, {
          operation: name,
          risk: riskOf(name),
          object: objectOf(name, body),
        });
        calls.push({ operation: name, input: body, allowed: decision.ok });
        if (!decision.ok)
          return { ok: false, error: { code: "forbidden", message: decision.reason } };
        const fake = options.operations?.[name] ?? builtIn[name];
        if (!fake) {
          return {
            ok: false,
            error: { code: "unknown_operation", message: `No fake for ${name}` },
          };
        }
        try {
          const value = structuredClone(await fake(body));
          observer?.(name, body, value);
          return { ok: true, value };
        } catch (error) {
          const e = error as { code?: string; message?: string };
          return {
            ok: false,
            error: { code: e.code ?? "internal", message: e.message ?? String(error) },
          };
        }
      },
    };
  }
  if (has("storage")) {
    raw.storage = {
      get: async (key) => storage.get(String(key)) ?? null,
      set: async (key, value) => {
        storage.set(String(key), structuredClone(value));
      },
      del: async (key) => {
        storage.delete(String(key));
      },
      list: async (prefix) =>
        [...storage]
          .filter(([key]) => key.startsWith(String(prefix ?? "")))
          .map(([key, value]) => ({ key, value })),
    };
  }
  if (has("log")) {
    raw.log = {
      write: async (level, message, data) => {
        logs.push({ level: String(level), message: String(message), data });
      },
    };
  }
  if (has("ai")) {
    const ai: AiModule = {
      summarise: async (text) => String(text).slice(0, 100),
      extract: async (_text, fields) =>
        Object.fromEntries(Object.keys(fields).map((k) => [k, null])),
      classify: async (_text, labels) => ({ label: labels[0] ?? "" }),
      ...options.ai,
    };
    raw.ai = {
      summarise: (text, opts) => ai.summarise(String(text), opts as never),
      extract: (text, fields) => ai.extract(String(text), fields as Record<string, string>),
      classify: (text, labels) => ai.classify(String(text), labels as string[]),
    };
  }

  async function runAutomation(
    name: string,
    run: AutomationRunOptions = {},
  ): Promise<AutomationRunResult> {
    const automation = extension.automations?.[name];
    if (!automation) {
      throw new ExtensionToolError("unknown_automation", `No automation named ${name}`);
    }
    const declared = new Map(automation.steps.map((step) => [step.name, step]));
    const result: AutomationRunResult = {
      matched: true,
      value: null,
      error: null,
      steps: [],
      writes: [],
      notifications: [],
      undeclared: [],
    };
    let row: Values | undefined;
    if (run.record) {
      row = records.get(run.record.object)?.get(run.record.id);
      if (!row) {
        throw new ExtensionToolError(
          "not_found",
          `Seed ${run.record.object} ${run.record.id} in records to use it as the trigger record`,
        );
      }
    }
    if (automation.conditions && row && !matches(row, automation.conditions)) {
      result.matched = false;
      return result;
    }
    const event: AutomationEvent = {
      automation: `${manifest.id}.${name}`,
      runId: run.runId ?? "arn_TEST",
      trigger: automation.trigger.type,
      ...(run.record && row
        ? {
            record: {
              object: run.record.object,
              id: run.record.id,
              data: Object.fromEntries(Object.entries(row).filter(([key]) => key !== "id")),
              title: titleOf(run.record.object, row),
            },
          }
        : {}),
      ...(run.change ? { change: run.change } : {}),
      ...(run.period ? { period: run.period } : {}),
      ...(run.manual ? { manual: run.manual } : {}),
      ...(run.approval ? { approval: run.approval } : {}),
      test: run.test ?? false,
    };

    const ran = new Set<string>();
    const claim = (stepName: string, kind: "do" | "sleep" | "waitForEvent") => {
      const step = declared.get(stepName);
      if (!step || (step.kind ?? "do") !== kind) {
        throw new AutomationStepError(
          `step.${kind}("${stepName}") is not a declared ${kind} step of ${name}; declare it in steps`,
        );
      }
      if (ran.has(stepName)) {
        throw new AutomationStepError(`Step ${stepName} already ran; each step runs once per run`);
      }
      ran.add(stepName);
      return step;
    };
    const declaredWrites = (stepName: string | null) => {
      const step = stepName ? declared.get(stepName) : undefined;
      return step && (step.kind ?? "do") === "do"
        ? ((step as { writes?: { object: string }[] }).writes ?? []).map((w) => w.object)
        : [];
    };
    const declaresNotify = (stepName: string | null) => {
      const step = stepName ? declared.get(stepName) : undefined;
      return Boolean((step as { notifies?: unknown[] } | undefined)?.notifies?.length);
    };
    const where = (stepName: string | null) =>
      stepName ? `step ${stepName}` : "run (outside a step)";
    const notificationsBefore = notifications.length;
    observer = (operation, input, value) => {
      if (operation === "notification.send") {
        if (!declaresNotify(currentStep)) {
          result.undeclared.push(`${where(currentStep)} sent a notification (not in its notifies)`);
        }
        return;
      }
      if (riskOf(operation) === "read") return;
      const object = objectOf(operation, input);
      const id =
        value && typeof value === "object" && "id" in value
          ? String((value as { id: unknown }).id)
          : null;
      result.writes.push({ step: currentStep, operation, object, id });
      if (!object || !declaredWrites(currentStep).includes(object)) {
        result.undeclared.push(
          `${where(currentStep)} called ${operation}${object ? ` on ${object}` : ""} (not in its writes)`,
        );
      }
    };

    const pending: Promise<unknown>[] = [];
    const base = buildContext(extension, raw, pending);
    const notifyCounts = new Map<string, number>();
    const ctx: AutomationContext = {
      ...base,
      async notify(to, message) {
        const key = currentStep ?? "run";
        const n = (notifyCounts.get(key) ?? 0) + 1;
        notifyCounts.set(key, n);
        const input = notificationInput(event, to, message, `${key}:${n}`);
        const sent = await base.crm.call<{ sent: number }>("notification.send", input);
        return { sent: sent.sent };
      },
    };
    const stepApi: AutomationStepApi = {
      async do<T>(stepName: string, a: unknown, b?: unknown): Promise<T> {
        const fn = (typeof a === "function" ? a : b) as () => Promise<T> | T;
        const step = claim(stepName, "do");
        if (typeof a === "object" && a !== null) {
          const intent = a as { writes?: { object: string }[] };
          const allowed = declaredWrites(step.name);
          for (const write of intent.writes ?? []) {
            if (!allowed.includes(write.object)) {
              throw new AutomationStepError(
                `step.do("${stepName}") says it writes ${write.object}, but its declaration does not`,
              );
            }
          }
        }
        const first = calls.length;
        currentStep = stepName;
        try {
          const value = await fn();
          result.steps.push({
            name: stepName,
            kind: "do",
            value: value === undefined ? null : structuredClone(value),
            calls: calls.slice(first),
          });
          return value;
        } finally {
          currentStep = null;
        }
      },
      async sleep(stepName, duration) {
        claim(stepName, "sleep");
        result.steps.push({
          name: stepName,
          kind: "sleep",
          skippedMs: durationMs(duration),
          calls: [],
        });
      },
      async waitForEvent<T>(stepName: string): Promise<T | null> {
        const step = claim(stepName, "waitForEvent") as { timeout?: number | string };
        const value = (run.events?.[stepName] ?? null) as T | null;
        result.steps.push({
          name: stepName,
          kind: "waitForEvent",
          value,
          skippedMs: durationMs((step.timeout ?? "7 days") as never),
          calls: [],
        });
        return value;
      },
    };
    try {
      const value = await automation.run(event, stepApi, ctx);
      result.value = value === undefined ? null : structuredClone(value);
    } catch (error) {
      const e = error as { code?: unknown; message?: unknown };
      result.error = {
        code: typeof e.code === "string" ? e.code : "automation_error",
        message: typeof e.message === "string" ? e.message : String(error),
      };
    } finally {
      observer = null;
      currentStep = null;
      await Promise.all(pending);
    }
    result.notifications = notifications.slice(notificationsBefore);
    return result;
  }

  return {
    manifest,
    issues,
    calls,
    logs,
    storage,
    records,
    notifications,
    runAutomation,
    async runTool<T>(tool: string, input: unknown): Promise<T> {
      const response = await runExtension(extension, { kind: "tool", tool, input }, raw);
      if (!response.ok) {
        throw new ExtensionToolError(
          response.error.code,
          response.error.message,
          response.error.details,
        );
      }
      return response.value as T;
    },
  };
}
