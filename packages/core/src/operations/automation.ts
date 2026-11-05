// automation.* operations (ADR 0028, ADR 0130, ADR 0133): listing and inspecting automations,
// test mode, enabling and disabling, run history, manual runs, retry / replay / cancel, the
// optional AI explanation, the kill switch and the automation settings.
//
// Permissions: reading automations and runs is `records:read`; enable, disable and the settings
// are `settings:manage` (admins: they change what runs for everyone); starting, retrying,
// replaying and cancelling runs is `records:write`; the kill switch is human admins only and
// never reachable over MCP. Runs execute in ros-runner, reached through `ctx.automationHost`.
import type { CoreDatabase } from "@relationship-os/db";
import type { AutomationManifest, ExtensionManifest } from "@relationship-os/sdk";
import { type Kysely, sql } from "kysely";
import type { z } from "zod";
import {
  type AutomationRow,
  effectiveRails,
  isTimeZone,
  loadAutomationSettings,
  parseSpec,
  triggerObject,
} from "../automations/registry.ts";
import {
  type AutomationListItem,
  type RunItem,
  AUTOMATION_OPERATION_SCHEMAS as S,
} from "../automations/schemas.ts";
import {
  automationDiagram,
  automationSummary,
  type SummaryContext,
  triggerText,
} from "../automations/summary.ts";
import {
  AUTOMATION_SETTINGS,
  type AutomationHost,
  MAX_CASCADE_DEPTH,
  type RunStatus,
} from "../automations/types.ts";
import { ConfigError, NotFoundError, ValidationError } from "../errors.ts";
import { refreshSchemaRegistry } from "../extensions/schema.ts";
import { getObject } from "../fields/index.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { jsonList } from "../records/common.ts";
import { loadRecordTitles } from "../records/links.ts";

const DAY_MS = 86_400_000;

function host(ctx: HandlerContext): AutomationHost {
  if (!ctx.automationHost) {
    throw new ConfigError("The automation runtime (ros-runner) is not available to this caller");
  }
  return ctx.automationHost;
}

function parse<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** Labels for the host-rendered summary, from the field registry. */
export function summaryContext(timezone: string): SummaryContext {
  return {
    objectLabel(object) {
      const def = getObject(object);
      if (!def) return null;
      return { label: def.label, plural: def.plural ?? `${def.label}s` };
    },
    fieldLabel(object, field) {
      return getObject(object)?.fields.find((f) => f.name === field)?.label ?? null;
    },
    optionLabel(object, field, value) {
      const def = getObject(object)?.fields.find((f) => f.name === field);
      return def?.options?.choices?.find((c) => c.value === value)?.label ?? null;
    },
    timezone,
  };
}

type Status = AutomationListItem["status"];

function statusOf(row: AutomationRow, killSwitch: boolean): Status {
  if (row.removed_at) return "removed";
  if (!row.enabled) return "disabled";
  if (killSwitch) return "killed";
  if (row.paused_reason) return "paused";
  return "active";
}

const AUTOMATION_COLUMNS = [
  "a.id",
  "a.extension_id",
  "a.key",
  "a.label",
  "a.trigger_type",
  "a.trigger_object",
  "a.spec",
  "a.commit_oid",
  "a.enabled",
  "a.paused_reason",
  "a.paused_at",
  "a.removed_at",
] as const;

async function loadAutomation(db: Kysely<CoreDatabase>, id: string) {
  const row = await db
    .selectFrom("core_automations as a")
    .leftJoin("core_extensions as e", "e.id", "a.extension_id")
    .select([
      ...AUTOMATION_COLUMNS,
      "e.manifest",
      "e.source",
      "e.installed_by",
      "e.installed_at",
      "e.version",
    ])
    .where("a.id", "=", id)
    .executeTakeFirst();
  if (!row) throw new NotFoundError("automation", id);
  const spec = parseSpec(row.spec);
  if (!spec) throw new NotFoundError("automation", id);
  return { row: row as typeof row & AutomationRow, spec };
}

/** Run counts in the last 7 days and the last run, per automation (index range per id). */
async function runStats(db: Kysely<CoreDatabase>, ids: readonly string[], now: string) {
  const out = new Map<
    string,
    { runs7d: number; errors7d: number; lastRunAt: string | null; lastRunStatus: RunStatus | null }
  >();
  if (!ids.length) return out;
  const since = new Date(Date.parse(now) - 7 * DAY_MS).toISOString();
  const rows = await db
    .selectFrom("core_automation_runs")
    .select([
      "automation_id",
      sql<number>`count(*)`.as("runs"),
      sql<number>`sum(status = 'failed')`.as("errors"),
      sql<string>`max(started_at)`.as("last"),
    ])
    .where("automation_id", "in", jsonList([...ids]))
    .where("started_at", ">=", since)
    .where("test", "=", 0)
    .groupBy("automation_id")
    .execute();
  const lastStatus = rows.length
    ? await db
        .selectFrom("core_automation_runs")
        .select(["automation_id", "status", "started_at"])
        .where(
          sql<boolean>`(automation_id, started_at) IN (SELECT key, value FROM json_each(${JSON.stringify(
            Object.fromEntries(rows.map((r) => [r.automation_id, r.last])),
          )}))`,
        )
        .execute()
    : [];
  for (const r of rows) {
    const last = lastStatus.find((l) => l.automation_id === r.automation_id);
    out.set(r.automation_id, {
      runs7d: Number(r.runs),
      errors7d: Number(r.errors ?? 0),
      lastRunAt: r.last,
      lastRunStatus: (last?.status as RunStatus | undefined) ?? null,
    });
  }
  return out;
}

function listItem(
  row: AutomationRow & { manifest?: string | null },
  spec: AutomationManifest,
  killSwitch: boolean,
  summary: SummaryContext,
  stats: ReturnType<typeof runStats> extends Promise<Map<string, infer V>> ? V | undefined : never,
): AutomationListItem {
  const manifest = parse<Partial<ExtensionManifest> | null>(row.manifest ?? null, null);
  const t = spec.trigger;
  return {
    id: row.id,
    extensionId: row.extension_id,
    extensionLabel: manifest?.label ?? null,
    key: row.key,
    label: spec.label,
    description: spec.description,
    triggerType: t.type,
    triggerObject: triggerObject(spec),
    triggerText: triggerText(spec, summary),
    status: statusOf(row, killSwitch),
    pausedReason: row.paused_reason,
    lastRunAt: stats?.lastRunAt ?? null,
    lastRunStatus: stats?.lastRunStatus ?? null,
    runs7d: stats?.runs7d ?? 0,
    errors7d: stats?.errors7d ?? 0,
    manual:
      t.type === "manual" ? { label: t.label, object: t.object, bulk: t.bulk ?? false } : null,
  };
}

export const automationList = defineOperation({
  name: "automation.list",
  description:
    "List the automations installed extensions declare, with their status (active, disabled, " +
    "paused by a rail, stopped by the kill switch, removed), trigger in plain English, last run " +
    "and 7-day run and error counts. `manualFor` lists the manual automations of one object (the " +
    "buttons on its record pages and bulk actions on its lists). Read-only.",
  input: S["automation.list"].input,
  output: S["automation.list"].output,
  permission: "records:read",
  risk: "read",
  mcp: { curated: true, title: "List automations", idempotent: true },
  async handler(input, ctx) {
    await refreshSchemaRegistry(ctx.db);
    const settings = await loadAutomationSettings(ctx.db);
    let q = ctx.db
      .selectFrom("core_automations as a")
      .leftJoin("core_extensions as e", "e.id", "a.extension_id")
      .select([...AUTOMATION_COLUMNS, "e.manifest"])
      .orderBy("a.id");
    if (input.extensionId) q = q.where("a.extension_id", "=", input.extensionId);
    if (input.manualFor) {
      q = q
        .where("a.trigger_type", "=", "manual")
        .where("a.trigger_object", "=", input.manualFor)
        .where("a.removed_at", "is", null);
    }
    const rows = (await q.execute()) as (AutomationRow & { manifest: string | null })[];
    const stats = await runStats(
      ctx.db,
      rows.map((r) => r.id),
      ctx.now,
    );
    const summary = summaryContext(settings.timezone);
    const items: AutomationListItem[] = [];
    for (const row of rows) {
      const spec = parseSpec(row.spec);
      if (!spec) continue;
      const item = listItem(row, spec, settings.killSwitch, summary, stats.get(row.id));
      if (input.manualFor && item.status !== "active") continue;
      items.push(item);
    }
    return { items, killSwitch: settings.killSwitch };
  },
});

function onRejectedText(spec: AutomationManifest): string {
  const r = spec.onRejected ?? "stop";
  if (r === "stop") return "Stop the run";
  if (r === "continue") return "Continue without the change";
  return "Notify and stop the run";
}

export const automationGet = defineOperation({
  name: "automation.get",
  description:
    "Get one automation: the host-written plain-English summary and step diagram (generated " +
    "from its declarations, not by AI), its permissions, safety rails, what happens when a " +
    "change it queued is rejected, provenance, run count and the latest test-mode report. " +
    "Read-only.",
  input: S["automation.get"].input,
  output: S["automation.get"].output,
  permission: "records:read",
  risk: "read",
  mcp: { curated: true, title: "Get automation", idempotent: true },
  async handler(input, ctx) {
    await refreshSchemaRegistry(ctx.db);
    const settings = await loadAutomationSettings(ctx.db);
    const { row, spec } = await loadAutomation(ctx.db, input.id);
    const summary = summaryContext(settings.timezone);
    const stats = await runStats(ctx.db, [row.id], ctx.now);
    const manifest = parse<Partial<ExtensionManifest> | null>(row.manifest ?? null, null);
    const permissions = manifest?.permissions;
    const [count, lastTest, approver] = await Promise.all([
      ctx.db
        .selectFrom("core_automation_runs")
        .select(sql<number>`count(*)`.as("n"))
        .where("automation_id", "=", row.id)
        .where("test", "=", 0)
        .executeTakeFirst(),
      ctx.db
        .selectFrom("core_automation_runs")
        .select("report")
        .where("automation_id", "=", row.id)
        .where(sql<boolean>`test = 1`)
        .orderBy("started_at", "desc")
        .limit(1)
        .executeTakeFirst(),
      row.installed_by
        ? ctx.db
            .selectFrom("core_user")
            .select("name")
            .where("id", "=", row.installed_by)
            .executeTakeFirst()
        : Promise.resolve(undefined),
    ]);
    const rails = effectiveRails(spec, settings);
    const operations = permissions?.operations ?? [];
    return {
      ...listItem(row, spec, settings.killSwitch, summary, stats.get(row.id)),
      version: row.version ?? null,
      commit: row.commit_oid,
      provenance: {
        author: row.source === "shipped" ? "Shipped with Relationship OS" : null,
        approvedBy: approver?.name ?? null,
        approvedAt: row.installed_by ? (row.installed_at ?? null) : null,
        shipped: row.source === "shipped",
      },
      spec,
      summary: automationSummary(spec, summary),
      diagram: automationDiagram(spec, summary),
      permissions: {
        read: permissions?.read ?? [],
        write: permissions?.write ?? [],
        notify: operations.includes("notification.send"),
        operations,
        principal: `extension:${row.extension_id}`,
      },
      rails: {
        ...rails,
        cascadeDepth: MAX_CASCADE_DEPTH,
        selfRetrigger: false as const,
      },
      onRejected: onRejectedText(spec),
      runCount: Number(count?.n ?? 0),
      lastTest: parse<unknown>(lastTest?.report ?? null, null),
      killSwitch: settings.killSwitch,
    };
  },
});

export const automationTest = defineOperation({
  name: "automation.test",
  description:
    "Test mode: dry-run an automation against a chosen record with nothing written. Every step " +
    "runs as it would for real, through the approval policy, but writes are simulated (later " +
    "steps see them) and waits are skipped and shown. Reports whether the trigger and conditions " +
    "match the record, each step, the records it would create or change, the notifications it " +
    "would send and the changes that would need approval. Use it after writing an automation.",
  input: S["automation.test"].input,
  output: S["automation.test"].output,
  permission: "records:read",
  risk: "read",
  mcp: { curated: true, title: "Test automation" },
  async handler(input, ctx) {
    const report = await host(ctx).testAutomation({
      automationId: input.id,
      ...(input.record ? { record: input.record } : {}),
      userId: ctx.user.id,
    });
    return { report };
  },
});

function statusOperation(name: "automation.enable" | "automation.disable") {
  const enable = name === "automation.enable";
  return defineOperation({
    name,
    description: enable
      ? "Enable an automation (admins). Also clears an auto-pause from a rate limit, so it runs " +
        "again from the next event. The kill switch, when engaged, still stops everything."
      : "Disable an automation (admins): it stops starting runs. Runs already in progress " +
        "finish. Enable it again with automation.enable.",
    input: S[name].input,
    output: S[name].output,
    permission: "settings:manage",
    risk: "write",
    async handler(input, ctx) {
      const { row } = await loadAutomation(ctx.db, input.id);
      if (row.removed_at) {
        throw new ValidationError(`${input.id} was removed from its extension`, { id: input.id });
      }
      ctx.write(
        ctx.db
          .updateTable("core_automations")
          .set({
            enabled: enable ? 1 : 0,
            ...(enable ? { paused_reason: null, paused_at: null } : {}),
            updated_at: ctx.now,
          })
          .where("id", "=", input.id),
      );
      const settings = await loadAutomationSettings(ctx.db);
      const status = statusOf(
        { ...row, enabled: enable ? 1 : 0, paused_reason: enable ? null : row.paused_reason },
        settings.killSwitch,
      );
      return { id: input.id, status };
    },
  });
}

export const automationEnable = statusOperation("automation.enable");
export const automationDisable = statusOperation("automation.disable");

function outcomeText(row: {
  status: string;
  status_reason: string | null;
  wait_until: string | null;
  error: string | null;
  retry_of: string | null;
}): string {
  const error = parse<{ message?: string } | null>(row.error, null);
  switch (row.status) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "waiting":
      return row.wait_until
        ? `Waiting until ${row.wait_until.slice(0, 16).replace("T", " ")}`
        : "Waiting";
    case "review":
      return "Waiting for approval";
    case "completed":
      return row.retry_of ? "Completed · retried ✓" : "Completed";
    case "failed":
      return `Failed${error?.message ? `: ${error.message}` : ""}`;
    case "cancelled":
      return `Cancelled${row.status_reason ? `: ${row.status_reason}` : ""}`;
    case "expired":
      return "Approval expired";
    case "skipped":
      return `Skipped${row.status_reason ? `: ${row.status_reason}` : ""}`;
    default:
      return row.status;
  }
}

type RunRow = {
  id: string;
  automation_id: string;
  status: RunStatus;
  status_reason: string | null;
  trigger: string;
  record_object: string | null;
  record_id: string | null;
  test: number;
  depth: number;
  steps: string;
  writes: number;
  change_set_id: string | null;
  wait_until: string | null;
  retry_of: string | null;
  replay_of: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  label: string | null;
};

const RUN_COLUMNS = [
  "r.id",
  "r.automation_id",
  "r.status",
  "r.status_reason",
  "r.trigger",
  "r.record_object",
  "r.record_id",
  "r.test",
  "r.depth",
  "r.steps",
  "r.writes",
  "r.change_set_id",
  "r.wait_until",
  "r.retry_of",
  "r.replay_of",
  "r.error",
  "r.started_at",
  "r.finished_at",
  "a.label",
] as const;

async function toRunItems(db: Kysely<CoreDatabase>, rows: RunRow[]): Promise<RunItem[]> {
  const refs = rows
    .filter((r) => r.record_object && r.record_id)
    .map((r) => ({ object: r.record_object as string, id: r.record_id as string }));
  const titles = refs.length ? await loadRecordTitles(db, refs) : new Map<string, string>();
  return rows.map((r) => ({
    id: r.id,
    automationId: r.automation_id,
    automationLabel: r.label ?? r.automation_id,
    status: r.status,
    statusReason: r.status_reason,
    outcomeText: outcomeText(r),
    trigger: parse<unknown>(r.trigger, null),
    record:
      r.record_object && r.record_id
        ? {
            object: r.record_object,
            id: r.record_id,
            title: titles.get(`${r.record_object}:${r.record_id}`) ?? null,
          }
        : null,
    test: r.test === 1,
    depth: r.depth,
    steps: parse<unknown[]>(r.steps, []),
    writes: r.writes,
    changeSetId: r.change_set_id,
    waitUntil: r.wait_until,
    retryOf: r.retry_of,
    replayOf: r.replay_of,
    error: parse<unknown>(r.error, null),
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  }));
}

function decodeCursor(cursor: string | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  const at = cursor.indexOf("|");
  return at > 0 ? { at: cursor.slice(0, at), id: cursor.slice(at + 1) } : null;
}

export const automationRuns = defineOperation({
  name: "automation.runs",
  description:
    "Run history, newest first: one automation's runs (`id`), the runs that touched a record " +
    "(`record`), or one run (`runId`). Each run has its trigger and record, status, steps with " +
    "timings, operations called and logs, writes, its change set when it waits for approval, " +
    "and errors. Kept 30 days (failed runs 90). Test runs only with includeTests. Read-only.",
  input: S["automation.runs"].input,
  output: S["automation.runs"].output,
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    let q = ctx.db
      .selectFrom("core_automation_runs as r")
      .leftJoin("core_automations as a", "a.id", "r.automation_id")
      .select([...RUN_COLUMNS]);
    if (input.runId) {
      q = q.where("r.id", "=", input.runId);
    } else if (input.record) {
      q = q.where(
        "r.id",
        "in",
        ctx.db
          .selectFrom("core_automation_run_records")
          .select("run_id")
          .where("object_type", "=", input.record.object)
          .where("record_id", "=", input.record.id),
      );
    }
    if (input.id) q = q.where("r.automation_id", "=", input.id);
    if (input.status) q = q.where("r.status", "=", input.status);
    if (!input.includeTests && !input.runId) q = q.where("r.test", "=", 0);
    const cursor = decodeCursor(input.cursor);
    if (cursor) {
      q = q.where((eb) =>
        eb.or([
          eb("r.started_at", "<", cursor.at),
          eb.and([eb("r.started_at", "=", cursor.at), eb("r.id", "<", cursor.id)]),
        ]),
      );
    }
    const rows = (await q
      .orderBy("r.started_at", "desc")
      .orderBy("r.id", "desc")
      .limit(input.limit + 1)
      .execute()) as RunRow[];
    const page = rows.slice(0, input.limit);
    const last = page[page.length - 1];
    return {
      items: await toRunItems(ctx.db, page),
      nextCursor: rows.length > input.limit && last ? `${last.started_at}|${last.id}` : null,
    };
  },
});

export const automationRun = defineOperation({
  name: "automation.run",
  description:
    "Start a manual automation for records (the button on a record page, or a bulk action on " +
    "selected records): one run per record, subject to the automation's conditions and rails. " +
    "Returns the run ids and how many records were skipped.",
  input: S["automation.run"].input,
  output: S["automation.run"].output,
  permission: "records:write",
  risk: "write",
  bulkSize: (input) => input.recordIds.length,
  async handler(input, ctx) {
    const { row, spec } = await loadAutomation(ctx.db, input.id);
    const t = spec.trigger;
    if (t.type !== "manual") {
      throw new ValidationError(`${input.id} is not started by hand (its trigger is ${t.type})`);
    }
    if (t.object !== input.object) {
      throw new ValidationError(`${input.id} runs on ${t.object}, not ${input.object}`);
    }
    if (!t.bulk && input.recordIds.length > 1) {
      throw new ValidationError(`${input.id} runs on one record at a time`);
    }
    if (row.removed_at || !row.enabled) {
      throw new ValidationError(`${input.id} is not enabled`, { id: input.id });
    }
    return host(ctx).startManualRun({
      automationId: input.id,
      trigger: "manual",
      userId: ctx.user.id,
      object: input.object,
      recordIds: input.recordIds,
    });
  },
});

function runOperation(
  name: "automation.retry" | "automation.replay" | "automation.cancel",
  description: string,
  call: (h: AutomationHost, runId: string) => Promise<{ runId: string }>,
) {
  return defineOperation({
    name,
    description,
    input: S[name].input,
    output: S[name].output,
    permission: "records:write",
    risk: "write",
    async handler(input, ctx) {
      const run = await ctx.db
        .selectFrom("core_automation_runs")
        .select(["id", "status"])
        .where("id", "=", input.runId)
        .executeTakeFirst();
      if (!run) throw new NotFoundError("automation run", input.runId);
      return call(host(ctx), input.runId);
    },
  });
}

export const automationRetry = runOperation(
  "automation.retry",
  "Retry a failed automation run from the step that failed: the steps that completed keep " +
    "their results and are not repeated. Returns the new run's id.",
  (h, id) => h.retryRun(id),
);
export const automationReplay = runOperation(
  "automation.replay",
  "Replay an automation run from the start against current data, with the same trigger. Its " +
    "steps run again (and write again). Returns the new run's id.",
  (h, id) => h.replayRun(id),
);
export const automationCancel = runOperation(
  "automation.cancel",
  "Cancel a running or waiting automation run. Steps already done stay done.",
  (h, id) => h.cancelRun(id),
);

export const automationExplain = defineOperation({
  name: "automation.explain",
  description:
    "An optional AI-written explanation of an automation in plain words (labelled as AI-written; " +
    "the host's own summary from automation.get is the authoritative one). Null when the " +
    "deployment has no AI. Read-only.",
  input: S["automation.explain"].input,
  output: S["automation.explain"].output,
  permission: "records:read",
  risk: "read",
  async handler(input, ctx) {
    const { spec } = await loadAutomation(ctx.db, input.id);
    if (!ctx.models) return { text: null, model: null, aiWritten: true as const };
    try {
      const result = await ctx.models.run(
        "build",
        [
          {
            role: "system",
            content:
              "You explain CRM automations to business users in two to four short sentences: " +
              "what starts it, what it does, what it waits for, and anything that needs " +
              "approval. Plain words, no code, no markdown.",
          },
          { role: "user", content: JSON.stringify(spec) },
        ],
        { maxTokens: 300 },
      );
      return { text: result.text || null, model: result.model, aiWritten: true as const };
    } catch (error) {
      console.error("automation.explain failed", error);
      return { text: null, model: null, aiWritten: true as const };
    }
  },
});

function settingWrite(ctx: HandlerContext, key: string, value: unknown) {
  const json = JSON.stringify(value);
  ctx.write(
    ctx.db
      .insertInto("core_settings")
      .values({ key, value: json, updated_at: ctx.now, updated_by: ctx.user.id })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet({ value: json, updated_at: ctx.now, updated_by: ctx.user.id }),
      ),
  );
}

export const automationKillSwitch = defineOperation({
  name: "automation.killSwitch",
  description:
    "Engage or release the automation kill switch (human admins only). Engaged, no automation " +
    "starts a run, and running runs stop before their next step.",
  input: S["automation.killSwitch"].input,
  output: S["automation.killSwitch"].output,
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    settingWrite(ctx, AUTOMATION_SETTINGS.killSwitch, input.engaged);
    return { engaged: input.engaged };
  },
});

export const automationSettings = defineOperation({
  name: "automation.settings",
  description:
    "The automation settings: whether the kill switch is engaged, the timezone schedules and " +
    "date-relative triggers run in, and the debounce window for record updates. Read-only.",
  input: S["automation.settings"].input,
  output: S["automation.settings"].output,
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(_input, ctx) {
    return loadAutomationSettings(ctx.db);
  },
});

export const automationUpdateSettings = defineOperation({
  name: "automation.updateSettings",
  description:
    "Change the automation timezone (IANA, e.g. Australia/Sydney) or the debounce window in " +
    "seconds (admins).",
  input: S["automation.updateSettings"].input,
  output: S["automation.updateSettings"].output,
  permission: "settings:manage",
  risk: "write",
  mcp: { expose: false },
  async handler(input, ctx) {
    if (input.timezone !== undefined && !isTimeZone(input.timezone)) {
      throw new ValidationError(`"${input.timezone}" is not a timezone`, { field: "timezone" });
    }
    const before = await loadAutomationSettings(ctx.db);
    if (input.timezone !== undefined)
      settingWrite(ctx, AUTOMATION_SETTINGS.timezone, input.timezone);
    if (input.debounceSeconds !== undefined) {
      settingWrite(ctx, AUTOMATION_SETTINGS.debounceSeconds, input.debounceSeconds);
    }
    return { ...before, ...input } as z.infer<(typeof S)["automation.updateSettings"]["output"]>;
  },
});

export const automationOperations = [
  automationList,
  automationGet,
  automationTest,
  automationEnable,
  automationDisable,
  automationRuns,
  automationRun,
  automationRetry,
  automationReplay,
  automationCancel,
  automationExplain,
  automationKillSwitch,
  automationSettings,
  automationUpdateSettings,
] as const;
