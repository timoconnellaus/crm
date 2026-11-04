// extension.* operations (stage 3a, ADR 0025): list, get, check, install, disable, enable,
// rollback, dropHidden and runs. Authoring over the approval queue (write, propose, approve,
// reject, eject) comes in stage 3b; approve will call `installExtension` like install does.
import type { ExtensionManifest } from "@crm/sdk";
import { EXTENSION_ID_RE } from "@crm/sdk";
import { z } from "zod";
import { NotFoundError, ValidationError } from "../errors.ts";
import { checkExtension, installExtension, requireHost } from "../extensions/install.ts";
import { HIDDEN_RETENTION_DAYS, planDropHidden } from "../extensions/reconciler.ts";
import { loadSchemaState } from "../extensions/schema.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { shippedIssue, shippedRefusal } from "./extension-authoring.ts";

const extensionId = z.string().regex(EXTENSION_ID_RE).describe("Extension id, e.g. example");
const filesSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/),
    z.string().max(200_000),
  )
  .refine((files) => Object.keys(files).length > 0 && Object.keys(files).length <= 100, {
    message: "Between 1 and 100 files",
  })
  .describe("Source files by path relative to the extension root; index.ts is the entry");

const issueSchema = z.object({
  stage: z.enum(["typecheck", "contract", "formula", "reconcile"]),
  code: z.string(),
  path: z.string(),
  message: z.string(),
  suggestion: z.string().optional(),
  span: z.object({ start: z.number(), end: z.number() }).optional(),
});

const changeSchema = z.object({
  kind: z.string(),
  object: z.string(),
  field: z.string().optional(),
  from: z.string().optional(),
  detail: z.string().optional(),
});

const permissionsSchema = z.object({
  read: z.array(z.string()),
  write: z.array(z.string()),
  operations: z.array(z.string()),
  modules: z.array(z.string()),
});

export const extensionSummarySchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  source: z.enum(["shipped", "runtime"]),
  status: z.enum(["active", "disabled", "quarantined"]),
  statusReason: z.string().nullable(),
  version: z.string(),
  commit: z.string(),
  lastGoodCommit: z.string().nullable(),
  failureCount: z.number(),
  permissions: permissionsSchema,
  objects: z.array(z.string()),
  tools: z.array(z.string()),
  installedAt: z.string(),
  updatedAt: z.string(),
});
export type ExtensionSummary = z.infer<typeof extensionSummarySchema>;

interface ExtensionRow {
  id: string;
  source: "shipped" | "runtime";
  status: "active" | "disabled" | "quarantined";
  status_reason: string | null;
  version: string;
  commit_oid: string;
  last_good_commit: string | null;
  manifest: string;
  failure_count: number;
  installed_at: string;
  updated_at: string;
}

function summary(row: ExtensionRow): ExtensionSummary {
  const manifest = JSON.parse(row.manifest) as ExtensionManifest;
  return {
    id: row.id,
    label: manifest.label ?? row.id,
    description: manifest.description ?? null,
    source: row.source,
    status: row.status,
    statusReason: row.status_reason,
    version: row.version,
    commit: row.commit_oid,
    lastGoodCommit: row.last_good_commit,
    failureCount: row.failure_count,
    permissions: manifest.permissions,
    objects: Object.keys(manifest.objects ?? {}).map((name) => `${row.id}.${name}`),
    tools: Object.keys(manifest.tools ?? {}).map((name) => `x.${row.id}.${name}`),
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
  };
}

async function loadRow(ctx: HandlerContext, id: string): Promise<ExtensionRow> {
  const row = await ctx.db
    .selectFrom("core_extensions")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw new NotFoundError("extension", id);
  return row;
}

const runSchema = z.object({
  id: z.string(),
  commit: z.string().nullable(),
  kind: z.string(),
  name: z.string().nullable(),
  actor: z.string().nullable(),
  userId: z.string().nullable(),
  startedAt: z.string(),
  durationMs: z.number(),
  outcome: z.enum(["ok", "error", "timeout"]),
  error: z.unknown().nullable(),
  logs: z.array(z.unknown()),
  operations: z.array(z.unknown()),
});

export const extensionList = defineOperation({
  name: "extension.list",
  description:
    "List installed extensions (shipped and runtime) with version, status (active, disabled or " +
    "quarantined), declared permissions, objects and tools, plus `workspace`: every extension " +
    "in the extension workspace with its working-copy files and whether it has uncommitted " +
    "edits or is installed, and `shipped`: the shipped extension ids (extend them, don't " +
    "modify them). Read-only.",
  input: z.object({}),
  output: z.object({
    items: z.array(extensionSummarySchema),
    workspace: z.array(
      z.object({
        id: z.string(),
        head: z.string().nullable(),
        files: z.array(z.string()),
        changed: z.boolean(),
        installed: z.boolean(),
        ejected: z.boolean(),
      }),
    ),
    shipped: z.array(z.string()),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { curated: true, idempotent: true, title: "List extensions" },
  async handler(_input, ctx) {
    const rows = await ctx.db.selectFrom("core_extensions").selectAll().orderBy("id").execute();
    const host = ctx.extensionHost;
    const [workspace, shipped] = host
      ? await Promise.all([host.listWorkspace(), host.shipped()])
      : [[], []];
    const installed = new Set(rows.map((r) => r.id));
    return {
      items: rows.map(summary),
      workspace: workspace.map((w) => ({ ...w, installed: installed.has(w.id) })),
      shipped: shipped.map((s) => s.id),
    };
  },
});

export const extensionGet = defineOperation({
  name: "extension.get",
  description:
    "Get one installed extension: its summary, manifest, installed versions (git commits, " +
    "newest first), recent runs, and hidden fields and objects with the date their data can " +
    "be dropped. Read-only.",
  input: z.object({ id: extensionId, runs: z.number().int().min(0).max(100).default(20) }),
  output: extensionSummarySchema.extend({
    manifest: z.record(z.string(), z.unknown()),
    versions: z.array(
      z.object({ commit: z.string(), version: z.string(), installedAt: z.string() }),
    ),
    runs: z.array(runSchema),
    hidden: z.array(
      z.object({
        object: z.string(),
        field: z.string().nullable(),
        hiddenAt: z.string(),
        droppableAt: z.string(),
      }),
    ),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const row = await loadRow(ctx, input.id);
    const [versions, runs, state] = await Promise.all([
      ctx.db
        .selectFrom("core_extension_versions")
        .select(["commit_oid", "version", "installed_at"])
        .where("extension_id", "=", input.id)
        .orderBy("installed_at", "desc")
        .execute(),
      ctx.db
        .selectFrom("core_extension_runs")
        .selectAll()
        .where("extension_id", "=", input.id)
        .orderBy("started_at", "desc")
        .orderBy("id", "desc")
        .limit(input.runs)
        .execute(),
      loadSchemaState(ctx.db),
    ]);
    const droppable = (at: string) =>
      new Date(Date.parse(at) + HIDDEN_RETENTION_DAYS * 86_400_000).toISOString();
    const hidden = [
      ...state.objects
        .filter((o) => o.extensionId === input.id && o.status === "hidden" && o.hiddenAt)
        .map((o) => ({
          object: o.name,
          field: null,
          hiddenAt: o.hiddenAt as string,
          droppableAt: droppable(o.hiddenAt as string),
        })),
      ...state.fields
        .filter((f) => f.extensionId === input.id && f.status === "hidden" && f.hiddenAt)
        .map((f) => ({
          object: f.object,
          field: f.name,
          hiddenAt: f.hiddenAt as string,
          droppableAt: droppable(f.hiddenAt as string),
        })),
    ];
    return {
      ...summary(row),
      manifest: JSON.parse(row.manifest) as Record<string, unknown>,
      versions: versions.map((v) => ({
        commit: v.commit_oid,
        version: v.version,
        installedAt: v.installed_at,
      })),
      runs: runs.map((r) => ({
        id: r.id,
        commit: r.commit_oid,
        kind: r.kind,
        name: r.name,
        actor: r.actor,
        userId: r.user_id,
        startedAt: r.started_at,
        durationMs: r.duration_ms,
        outcome: r.outcome,
        error: r.error ? (JSON.parse(r.error) as unknown) : null,
        logs: JSON.parse(r.logs) as unknown[],
        operations: JSON.parse(r.operations) as unknown[],
      })),
      hidden,
    };
  },
});

const checkOutput = z.object({
  ok: z.boolean(),
  issues: z.array(issueSchema),
  manifest: z.record(z.string(), z.unknown()).nullable(),
  plan: z.object({ ddl: z.array(z.string()), changes: z.array(changeSchema) }).nullable(),
});

export const extensionCheck = defineOperation({
  name: "extension.check",
  description:
    "Check extension source without installing it: TypeScript (syntax and types against " +
    "@crm/sdk), allowed imports, the defineExtension contract, formula parsing and types, and " +
    "a dry-run of the schema reconcile (the DDL it would run and the changes it makes, e.g. " +
    "lossy type changes are refused). Pass just id to check its working copy (what " +
    "extension.write wrote), or files (path → source, entry index.ts), or a workspace commit. " +
    "Returns structured issues with stage, code, path, message and often a suggestion; fix " +
    "them all and check again until ok is true. Changes nothing.",
  input: z.union([
    z.object({ id: extensionId, files: filesSchema }),
    z.object({ id: extensionId, commit: z.string().min(4).max(64) }),
    z.object({ id: extensionId }),
  ]),
  output: checkOutput,
  permission: "extensions:manage",
  risk: "read",
  mcp: { curated: true, idempotent: true, title: "Check an extension" },
  async handler(input, ctx) {
    const host = requireHost(ctx);
    let target: { id: string; commit: string } | { id: string; files: Record<string, string> };
    if ("files" in input || "commit" in input) {
      target = input;
    } else {
      const wc = await host.workingCopy(input.id);
      if (!wc.exists || !Object.keys(wc.files).length) {
        throw new NotFoundError("extension in the workspace (write its files first)", input.id);
      }
      target = { id: input.id, files: wc.files };
    }
    const refusal = await shippedRefusal(ctx, host, input.id);
    const result = await checkExtension(ctx, target);
    if (refusal) {
      return {
        ...result,
        ok: false,
        issues: [shippedIssue(refusal), ...result.issues],
        manifest: result.manifest as Record<string, unknown> | null,
      };
    }
    return { ...result, manifest: result.manifest as Record<string, unknown> | null };
  },
});

const installOutput = z.object({
  id: z.string(),
  version: z.string(),
  commit: z.string(),
  source: z.enum(["shipped", "runtime"]),
  changed: z.boolean(),
  changes: z.array(changeSchema),
});

export const extensionInstall = defineOperation({
  name: "extension.install",
  description:
    "Install or upgrade an extension, admin and human only: commits the files (or a shipped " +
    "extension's bundled source) to the extension workspace, checks it, reconciles its schema " +
    "(x_* tables and crm_* views) and makes the commit the live version, all or nothing. " +
    "Fails with the check's issues if it does not pass. Installing the current version again " +
    "changes nothing.",
  input: z.union([
    z.object({ id: extensionId, shipped: z.literal(true) }),
    z.object({
      id: extensionId,
      files: filesSchema,
      message: z.string().max(500).optional(),
    }),
  ]),
  output: installOutput,
  permission: "extensions:manage",
  risk: "extension",
  actors: ["human"],
  redact: ["files"],
  async handler(input, ctx) {
    const host = requireHost(ctx);
    if ("shipped" in input) {
      const shipped = await host.shipped();
      if (!shipped.some((s) => s.id === input.id)) {
        throw new NotFoundError("shipped extension", input.id);
      }
      const { commit } = await host.commitShipped(input.id);
      return installExtension(ctx, { id: input.id, commit, source: "shipped" });
    }
    const { commit } = await host.commit({
      id: input.id,
      files: input.files,
      message: input.message ?? `Install ${input.id}`,
      author: { name: ctx.user.name, email: ctx.user.email },
    });
    return installExtension(ctx, { id: input.id, commit, source: "runtime" });
  },
});

export const extensionRollback = defineOperation({
  name: "extension.rollback",
  description:
    "Roll an extension back to a previously installed version (a commit from extension.get's " +
    "versions, e.g. the last-known-good one after a quarantine). Fields the later version " +
    "added are hidden with their data kept; the extension becomes active again. Admin, human " +
    "only.",
  input: z.object({ id: extensionId, commit: z.string().min(4).max(64) }),
  output: installOutput,
  permission: "extensions:manage",
  risk: "extension",
  actors: ["human"],
  async handler(input, ctx) {
    const row = await loadRow(ctx, input.id);
    const version = await ctx.db
      .selectFrom("core_extension_versions")
      .select("commit_oid")
      .where("extension_id", "=", input.id)
      .where("commit_oid", "=", input.commit)
      .executeTakeFirst();
    if (!version) {
      throw new ValidationError(`${input.commit} is not an installed version of ${input.id}`, {
        field: "commit",
      });
    }
    return installExtension(ctx, { id: input.id, commit: input.commit, source: row.source });
  },
});

function statusOperation(name: "extension.disable" | "extension.enable") {
  const disable = name === "extension.disable";
  return defineOperation({
    name,
    description: disable
      ? "Disable an extension: its tools stop running (its objects and data stay readable). " +
        "Admin, human only."
      : "Enable a disabled or quarantined extension again and reset its failure counter. " +
        "Admin, human only.",
    input: z.object({ id: extensionId, reason: z.string().max(500).optional() }),
    output: extensionSummarySchema,
    permission: "extensions:manage",
    risk: "extension",
    actors: ["human"],
    async handler(input, ctx) {
      await loadRow(ctx, input.id);
      ctx.write(
        ctx.db
          .updateTable("core_extensions")
          .set({
            status: disable ? "disabled" : "active",
            status_reason: disable ? (input.reason ?? "Disabled by an admin") : null,
            ...(disable ? {} : { failure_count: 0 }),
            updated_at: ctx.now,
          })
          .where("id", "=", input.id),
      );
      return ctx.afterCommit(async () => summary(await loadRow(ctx, input.id)));
    },
  });
}

export const extensionDisable = statusOperation("extension.disable");
export const extensionEnable = statusOperation("extension.enable");

export const extensionDropHidden = defineOperation({
  name: "extension.dropHidden",
  description:
    `Permanently drop the data of an extension's removed fields and objects that have been ` +
    `hidden for at least ${HIDDEN_RETENTION_DAYS} days (see extension.get's hidden list). ` +
    "Optionally only some (`object.field` or object names). Destructive and irreversible. " +
    "Admin, human only.",
  input: z.object({
    id: extensionId,
    only: z.array(z.string().max(120)).max(100).optional(),
  }),
  output: z.object({ changes: z.array(changeSchema), ddl: z.array(z.string()) }),
  permission: "extensions:manage",
  risk: "destructive",
  // An AI may ask for it (extension.propose's dropHidden), but only a person can approve it.
  actors: ["human", "mcp", "assistant"],
  alwaysReview: ["mcp", "assistant"],
  async handler(input, ctx) {
    const plan = await planDropHidden(ctx.db, input.id, {
      now: ctx.now,
      ...(input.only ? { only: input.only } : {}),
    });
    if (plan.changes.length) ctx.write(...plan.statements);
    return { changes: plan.changes, ddl: plan.changes.length ? plan.ddl : [] };
  },
});

export const extensionOperations = [
  extensionList,
  extensionGet,
  extensionCheck,
  extensionInstall,
  extensionRollback,
  extensionDisable,
  extensionEnable,
  extensionDropHidden,
] as const;
