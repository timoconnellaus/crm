// Authoring extensions over the approval queue (stage 3b, ADR 0041): read, write the working copy,
// propose (commit + check + one pending action holding the diff and the host-computed impact),
// apply (what approval runs: installExtension), approve and reject (people only), eject, and the
// proposal detail the approvals inbox shows.

import type { ExtensionManifest } from "@relationship-os/sdk";
import { EXTENSION_ID_RE } from "@relationship-os/sdk";
import { z } from "zod";
import { capFileDiffs } from "../approvals/caps.ts";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  OperationError,
  PendingApprovalError,
  ValidationError,
} from "../errors.ts";
import type { ExtensionHost, WorkingCopy, WorkspaceWrite } from "../extensions/host.ts";
import {
  type CheckIssue,
  type CheckResult,
  checkExtension,
  installExtension,
  requireHost,
} from "../extensions/install.ts";
import { authoringIntent, intentRequestInput, parseIntentCheck } from "../extensions/intent.ts";
import {
  capDiff,
  computeImpact,
  diffFiles,
  type ExtensionImpact,
  type FileDiff,
  summaryPrompt,
} from "../extensions/proposal.ts";
import { HIDDEN_RETENTION_DAYS } from "../extensions/reconciler.ts";
import { judgeUsageStatement } from "../judge/usage.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";

const extensionId = z
  .string()
  .regex(EXTENSION_ID_RE)
  .describe(
    "Extension id: 2-30 lowercase letters or digits, starting with a letter, e.g. projects",
  );
const actionId = z.string().startsWith("pac_").max(64).describe("Pending action id (pac_…)");
const filePath = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/,
    "A relative path such as index.ts or lib/tools.ts",
  )
  .refine((p) => !p.split("/").some((part) => part === ".." || part === "." || part === ".git"), {
    message: "Paths stay inside the extension",
  });

const workingCopySchema = z.object({
  id: z.string(),
  ref: z.string().describe('"working" for the working copy, else the commit read'),
  head: z.string().nullable().describe("The latest commit of the extension, if any"),
  files: z.record(z.string(), z.string()),
  changed: z
    .array(z.string())
    .describe(
      "Working-copy paths that differ from head (only when reading the whole working copy)",
    ),
  ejected: z.boolean(),
});

/** What extension.write and extension.eject return: paths, not contents (ADR 0043). */
const writeSchema = z.object({
  id: z.string(),
  ref: z.literal("working"),
  head: z.string().nullable().describe("The latest commit of the extension, if any"),
  paths: z.array(z.string()).describe("Every file in the working copy now"),
  written: z.array(z.string()).describe("Files this call wrote"),
  deleted: z.array(z.string()).describe("Files this call deleted"),
  changed: z.boolean().describe("The working copy has edits since its last commit"),
  ejected: z.boolean(),
});

function writeView(result: WorkspaceWrite, files: Record<string, string | null>) {
  const entries = Object.entries(files);
  return {
    id: result.id,
    ref: "working" as const,
    head: result.head,
    paths: result.paths,
    written: entries.filter(([, text]) => text !== null).map(([path]) => path),
    deleted: entries.filter(([, text]) => text === null).map(([path]) => path),
    changed: result.changed,
    ejected: result.ejected,
  };
}

// --- Helpers -----------------------------------------------------------------------------------

async function installedRow(ctx: HandlerContext, id: string) {
  return ctx.db.selectFrom("core_extensions").selectAll().where("id", "=", id).executeTakeFirst();
}

/**
 * Why a runtime author may not change extension `id`, or null when it may. Shipped extensions
 * can be extended (fields on their objects, views, tools) from another extension but not
 * modified in place, unless an admin ejects them (ADR 0023).
 */
async function shippedRefusal(
  ctx: HandlerContext,
  host: ExtensionHost,
  id: string,
  wc?: WorkingCopy,
): Promise<string | null> {
  const shipped = await host.shipped();
  if (!shipped.some((s) => s.id === id)) return null;
  const row = await installedRow(ctx, id);
  if (row?.source === "runtime") return null;
  // Only the ejected flag is needed: no file reads, no git status.
  const copy = wc ?? (await host.workingCopy(id, { paths: [], status: false }));
  if (copy.ejected) return null;
  return (
    `${id} is a shipped extension, so it cannot be modified in place. Extend it from your own ` +
    `extension instead (fields on its objects, e.g. fields: { "${id}.<object>": { … } }, views ` +
    "and tools), or call extension.eject to take it over as a runtime extension (it then stops " +
    "receiving upstream updates)."
  );
}

function shippedIssue(message: string): CheckIssue {
  return { stage: "contract", code: "shipped", path: "id", message };
}

function viewOf(wc: WorkingCopy) {
  return {
    id: wc.id,
    ref: "working",
    head: wc.head,
    files: wc.files,
    changed: wc.changed,
    ejected: wc.ejected,
  };
}

const checkSummarySchema = z.object({
  ok: z.boolean(),
  issues: z.array(
    z.object({
      stage: z.string(),
      severity: z.enum(["error", "warning", "info"]).optional(),
      code: z.string(),
      path: z.string(),
      message: z.string(),
      suggestion: z.string().optional(),
    }),
  ),
});

// --- Reading and writing the working copy ------------------------------------------------------

export const extensionRead = defineOperation({
  name: "extension.read",
  description:
    "Read an extension's source files: the working copy (your uncommitted edits, the default) " +
    "or the files at a commit (from extension.get's versions). Use it before editing an " +
    "existing extension, including the shipped ones (e.g. id 'example') to see how they are " +
    "written. Pass path to read one file. Read-only.",
  input: z.object({
    id: extensionId,
    commit: z.string().min(4).max(64).optional().describe("A commit; omit for the working copy"),
    path: filePath.optional().describe("Only this file"),
  }),
  output: workingCopySchema,
  permission: "records:read",
  risk: "read",
  mcp: { curated: true, idempotent: true, title: "Read extension files" },
  async handler(input, ctx) {
    const host = requireHost(ctx);
    // Read only what is asked: one file, or nothing of the working copy for a commit read; git
    // status (which reads every file) only for a whole working-copy read.
    const wc = await host.workingCopy(
      input.id,
      input.commit
        ? { paths: [], status: false }
        : input.path
          ? { paths: [input.path], status: false }
          : {},
    );
    let view = viewOf(wc);
    if (input.commit) {
      let files: Record<string, string>;
      try {
        files = await host.files(input.id, input.commit);
      } catch {
        throw new NotFoundError(`commit of extension ${input.id}`, input.commit);
      }
      view = { ...view, ref: input.commit, files };
    } else if (!wc.exists) {
      throw new NotFoundError("extension in the workspace", input.id);
    }
    if (input.path) {
      const text = view.files[input.path];
      if (text === undefined) throw new NotFoundError(`file of ${input.id}`, input.path);
      view = { ...view, files: { [input.path]: text } };
    }
    return view;
  },
});

export const extensionWrite = defineOperation({
  name: "extension.write",
  description:
    "Write files into an extension's working copy in the extension workspace (creating the " +
    "extension if it is new). Nothing is installed or committed: run extension.check to see " +
    "issues, then extension.propose to send it for approval. files maps paths relative to the " +
    "extension root to their full new contents (index.ts is the entry, whose default export is " +
    "defineExtension({...}) from @relationship-os/sdk); null deletes a file. replace: true deletes every " +
    "other file. Shipped extensions cannot be written unless ejected. Returns the working copy's " +
    "paths (use extension.read for contents).",
  input: z.object({
    id: extensionId,
    files: z
      .record(filePath, z.string().max(200_000).nullable())
      .refine((f) => Object.keys(f).length >= 1 && Object.keys(f).length <= 100, {
        message: "Between 1 and 100 files",
      })
      .describe("Path → full file contents, or null to delete"),
    replace: z.boolean().default(false).describe("Delete files not listed (default false)"),
  }),
  output: writeSchema,
  permission: "extensions:manage",
  risk: "write",
  // It changes only the draft in the workspace, never the live CRM, so it is never queued.
  bookkeeping: true,
  redact: ["files"],
  mcp: { curated: true, title: "Write extension files" },
  async handler(input, ctx) {
    const host = requireHost(ctx);
    const refusal = await shippedRefusal(ctx, host, input.id);
    if (refusal) throw new ForbiddenError(refusal, { id: input.id });
    const written = await host.writeFiles({
      id: input.id,
      files: input.files,
      replace: input.replace,
    });
    return writeView(written, input.files);
  },
});

export const extensionEject = defineOperation({
  name: "extension.eject",
  description:
    "Eject a shipped extension: copy its source into its working copy so it can be edited, " +
    "after which extension.propose installs it as a runtime extension. WARNING: once that " +
    "proposal is approved it stops receiving upstream updates with new releases. Prefer " +
    "extending it from your own extension (fields on its objects, views, tools) when that is " +
    "enough. Nothing changes in the live CRM until a proposal is approved.",
  input: z.object({ id: extensionId }),
  output: writeSchema.extend({ warning: z.string() }),
  permission: "extensions:manage",
  risk: "write",
  bookkeeping: true,
  mcp: { curated: true, title: "Eject a shipped extension" },
  async handler(input, ctx) {
    const host = requireHost(ctx);
    const shipped = await host.shipped();
    if (!shipped.some((s) => s.id === input.id)) {
      throw new NotFoundError("shipped extension", input.id);
    }
    const row = await installedRow(ctx, input.id);
    if (row?.source === "runtime") {
      throw new ConflictError(`${input.id} has already been ejected`, { id: input.id });
    }
    const written = await host.eject(input.id);
    return {
      ...writeView(written, Object.fromEntries(written.paths.map((p) => [p, ""]))),
      warning:
        `${input.id} is now editable in the workspace. When a proposal for it is approved it ` +
        "becomes a runtime extension and stops receiving upstream updates with new releases.",
    };
  },
});

// --- Proposing ---------------------------------------------------------------------------------

const applyInput = z.object({
  id: extensionId,
  commit: z.string().min(4).max(64),
  version: z.string().max(64),
  baseCommit: z.string().max(64).nullable().describe("The installed commit when proposed"),
  eject: z.boolean().default(false),
});

const applyOutput = z.object({
  id: z.string(),
  version: z.string(),
  commit: z.string(),
  source: z.enum(["shipped", "runtime"]),
  changed: z.boolean(),
  changes: z.array(
    z.object({
      kind: z.string(),
      object: z.string(),
      field: z.string().optional(),
      from: z.string().optional(),
      detail: z.string().optional(),
    }),
  ),
});

export const extensionApply = defineOperation({
  name: "extension.apply",
  description:
    "Install a proposed extension commit: what an approved extension proposal runs. It is " +
    "always queued for a person to approve (extension.propose queues it); on approval it " +
    "evaluates and checks the commit again, reconciles the schema and makes the commit live " +
    "in one transaction. Fails if the installed version changed since it was proposed.",
  input: applyInput,
  output: applyOutput,
  permission: "extensions:manage",
  risk: "extension",
  alwaysReview: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    const row = await installedRow(ctx, input.id);
    if ((row?.commit_oid ?? null) !== input.baseCommit) {
      throw new ConflictError(
        `${input.id} changed after this was proposed (installed ${row?.commit_oid ?? "nothing"}, ` +
          `proposed against ${input.baseCommit ?? "nothing"}). Propose it again.`,
        { id: input.id, installed: row?.commit_oid ?? null, base: input.baseCommit },
      );
    }
    if (row?.source === "shipped" && !input.eject) {
      throw new ValidationError(`${input.id} is a shipped extension; eject it first`, {
        id: input.id,
      });
    }
    if (ctx.simulation) {
      // Queued, not applied: the reviewer sees the proposal's diff and impact instead.
      return {
        id: input.id,
        version: input.version,
        commit: input.commit,
        source: "runtime" as const,
        changed: true,
        changes: [],
      };
    }
    return installExtension(ctx, {
      id: input.id,
      commit: input.commit,
      source: "runtime",
      ...(input.eject ? { eject: true } : {}),
    });
  },
});

const impactSchema = z.record(z.string(), z.unknown());

export const extensionPropose = defineOperation({
  name: "extension.propose",
  description:
    "Send an extension's working copy for approval: commits it (a new version in the " +
    "extension workspace), runs extension.check, and queues ONE pending action in your change " +
    "set holding the diff from the installed version and the host-computed impact (schema " +
    "changes, permissions requested or widened, host modules, tools, triggers). Nothing is " +
    "installed until a person approves it in the Approvals inbox. If the check fails it " +
    "returns status 'check_failed' with the issues and queues nothing: fix them with " +
    "extension.write and propose again. Bump `version` in defineExtension for each change. " +
    "impact.triggers holds each automation's host-written summary, the text the approver " +
    "reads: check it states everything the user asked for and nothing they did not. Pass " +
    "request (the user's own words) and each automation is also checked against it; findings " +
    "come back as warning issues (intent/…) and are shown to the approver. " +
    "dropHidden: true also queues a separate destructive item to drop data of fields removed " +
    `more than ${HIDDEN_RETENTION_DAYS} days ago.`,
  input: z.object({
    id: extensionId,
    message: z.string().trim().min(1).max(500).optional().describe("Commit message"),
    dropHidden: z.boolean().default(false),
    request: intentRequestInput,
  }),
  output: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("pending_approval"),
      actionId: z.string(),
      changeSetId: z.string(),
      commit: z.string(),
      version: z.string(),
      impact: impactSchema,
      check: checkSummarySchema,
      aiSummary: z.string().nullable(),
      dropActionId: z.string().nullable(),
      expiresAt: z.string(),
      message: z.string(),
    }),
    z.object({
      status: z.literal("check_failed"),
      commit: z.string(),
      issues: checkSummarySchema.shape.issues,
      message: z.string(),
    }),
    z.object({ status: z.literal("unchanged"), commit: z.string(), message: z.string() }),
  ]),
  permission: "extensions:manage",
  risk: "extension",
  // The pending action it queues (extension.apply) is what gets reviewed; propose itself is not.
  bookkeeping: true,
  mcp: { curated: true, title: "Propose an extension change", requireReason: true },
  async handler(input, ctx) {
    const host = requireHost(ctx);
    const wc = await host.workingCopy(input.id, { status: false });
    if (!wc.exists || !Object.keys(wc.files).length) {
      throw new NotFoundError("extension in the workspace (write its files first)", input.id);
    }
    const refusal = await shippedRefusal(ctx, host, input.id, wc);
    if (refusal) throw new ForbiddenError(refusal, { id: input.id });
    const { commit } = await host.commitWorkingCopy({
      id: input.id,
      message: input.message ?? ctx.reason ?? `Update ${input.id}`,
      author: { name: ctx.user.name, email: ctx.user.email },
    });
    const check = await checkExtension(ctx, { id: input.id, commit });
    const issues = check.issues.map(({ span: _span, ...issue }) => issue);
    if (!check.ok || !check.manifest || !check.plan) {
      return {
        status: "check_failed" as const,
        commit,
        issues,
        message:
          "The check failed, so nothing was queued. Fix the issues with extension.write and " +
          "call extension.propose again.",
      };
    }
    const row = await installedRow(ctx, input.id);
    if (row?.commit_oid === commit && row.status === "active" && !check.plan.changes.length) {
      return {
        status: "unchanged" as const,
        commit,
        message: `Commit ${commit} is already the installed version of ${input.id}.`,
      };
    }
    const eject = row?.source === "shipped" && wc.ejected;
    const previous = row ? (JSON.parse(row.manifest) as ExtensionManifest) : null;
    const [before, after] = await Promise.all([
      row ? host.files(input.id, row.commit_oid) : Promise.resolve(null),
      host.files(input.id, commit),
    ]);
    // Bounded (total LCS work) and capped (stored size) at write time (ADR 0043).
    const diff = capDiff(diffFiles(before, after));
    const impact = computeImpact({
      manifest: check.manifest,
      previous,
      changes: check.plan.changes,
      diff,
      eject,
    });
    // authoring.intent (ADR 0230): asked again here and stored with the proposal row, in the
    // batch that already writes it. Warnings only; off or unavailable never blocks a proposal.
    const intent = await authoringIntent(ctx, {
      manifest: check.manifest,
      request: input.request,
      previous,
    });
    let ai: { text: string; model: string } | null = null;
    try {
      ai = await host.describeChange({
        id: input.id,
        commit,
        base: row?.commit_oid ?? null,
        prompt: summaryPrompt(impact, diff),
      });
    } catch {
      ai = null;
    }

    const nested = {
      actor: ctx.actor,
      user: ctx.user,
      origin: ctx.origin,
      grantedPermissions: ctx.grantedPermissions,
      reason: ctx.reason ?? input.message,
    };
    const queue = async (name: string, nestedInput: unknown) => {
      try {
        await ctx.pipeline.invoke(name, nestedInput, nested);
      } catch (error) {
        if (error instanceof PendingApprovalError) return error.pending;
        throw error;
      }
      throw new OperationError("internal", `${name} applied without review`);
    };
    const pending = await queue("extension.apply", {
      id: input.id,
      commit,
      version: check.manifest.version,
      baseCommit: row?.commit_oid ?? null,
      eject,
    });
    let dropActionId: string | null = null;
    if (input.dropHidden) {
      dropActionId = (await queue("extension.dropHidden", { id: input.id })).actionId;
    }
    const checkResult: CheckResult = { ...check, manifest: check.manifest };
    ctx.write(
      ctx.db.insertInto("core_extension_proposals").values({
        action_id: pending.actionId,
        extension_id: input.id,
        commit_oid: commit,
        base_commit: row?.commit_oid ?? null,
        source: "runtime",
        version: check.manifest.version,
        message: input.message ?? ctx.reason ?? `Update ${input.id}`,
        // Capped so the row stays far below D1's 2 MB limit (ADR 0090).
        diff: JSON.stringify(capFileDiffs(diff)),
        impact: JSON.stringify(impact),
        check_result: JSON.stringify({ ok: checkResult.ok, issues, plan: checkResult.plan }),
        ai_summary: ai?.text ?? null,
        ai_model: ai?.model ?? null,
        intent_check: intent.check ? JSON.stringify(intent.check) : null,
        created_by: ctx.user.id,
        created_at: ctx.now,
      }),
    );
    // The judge's spend (ADR 0234), counted in the batch that writes the proposal.
    if (intent.check?.usage?.calls) {
      ctx.write(judgeUsageStatement(ctx.db, "authoring.intent", intent.check.usage, ctx.now));
    }
    return {
      status: "pending_approval" as const,
      actionId: pending.actionId,
      changeSetId: pending.changeSetId,
      commit,
      version: check.manifest.version,
      impact: impact as unknown as Record<string, unknown>,
      check: { ok: true, issues: [...issues, ...intent.issues] },
      aiSummary: ai?.text ?? null,
      dropActionId,
      expiresAt: pending.expiresAt,
      message:
        `Queued for approval, NOT installed yet: ${input.id} ${check.manifest.version} is ` +
        `pending action ${pending.actionId} in change set ${pending.changeSetId}. A person must ` +
        "approve it in the CRM's Approvals inbox. Tell the user it is waiting for approval.",
    };
  },
});

// --- The proposal, for reviewers ---------------------------------------------------------------

export const extensionProposal = defineOperation({
  name: "extension.proposal",
  description:
    "The review detail of an extension proposal (a pending action of extension.apply): the " +
    "per-file diff from the installed version, the host-computed impact, the check result and " +
    "the AI-written summary (null when no AI is configured). Read-only.",
  input: z.object({ actionId }),
  output: z.object({
    actionId: z.string(),
    extensionId: z.string(),
    commit: z.string(),
    baseCommit: z.string().nullable(),
    version: z.string(),
    message: z.string(),
    status: z.string(),
    diff: z.array(z.unknown()),
    impact: impactSchema,
    check: z.record(z.string(), z.unknown()),
    aiSummary: z.object({ text: z.string(), model: z.string().nullable() }).nullable(),
    /**
     * The authoring.intent check (ADR 0230): each automation against the request, with findings
     * code wrote from the manifest; null when none ran. Stored at propose, never asked here.
     */
    intentCheck: z
      .object({
        status: z.enum(["checked", "unchecked"]),
        requestSource: z.enum(["person", "client"]),
        request: z.string(),
        reason: z.string().optional(),
        automations: z.array(
          z.object({
            id: z.string(),
            findings: z.array(
              z.object({ question: z.string(), code: z.string(), message: z.string() }),
            ),
            faults: z.record(z.string(), z.number()).nullable(),
          }),
        ),
        model: z.string().optional(),
        checkedAt: z.string(),
      })
      .nullable(),
    createdBy: z.string(),
    createdAt: z.string(),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const row = await ctx.db
      .selectFrom("core_extension_proposals as p")
      .innerJoin("core_pending_action as a", "a.id", "p.action_id")
      .selectAll("p")
      .select(["a.status", "a.user_id"])
      .where("p.action_id", "=", input.actionId)
      .executeTakeFirst();
    if (!row) throw new NotFoundError("extension proposal", input.actionId);
    if (ctx.actor !== "human" && row.user_id !== ctx.user.id) {
      throw new ForbiddenError("That proposal belongs to another user");
    }
    return {
      actionId: row.action_id,
      extensionId: row.extension_id,
      commit: row.commit_oid,
      baseCommit: row.base_commit,
      version: row.version,
      message: row.message,
      status: row.status,
      diff: JSON.parse(row.diff) as FileDiff[],
      impact: JSON.parse(row.impact) as ExtensionImpact as unknown as Record<string, unknown>,
      check: JSON.parse(row.check_result) as Record<string, unknown>,
      aiSummary: row.ai_summary ? { text: row.ai_summary, model: row.ai_model } : null,
      intentCheck: parseIntentCheck(row.intent_check),
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
  },
});

// --- Deciding (people only) --------------------------------------------------------------------

const EXTENSION_ACTIONS = ["extension.apply", "extension.dropHidden"];

async function extensionAction(ctx: HandlerContext, id: string) {
  const row = await ctx.db
    .selectFrom("core_pending_action")
    .select(["id", "operation", "status"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row || !EXTENSION_ACTIONS.includes(row.operation)) {
    throw new NotFoundError("extension proposal", id);
  }
  return row;
}

const decisionOutput = z.object({
  actionId: z.string(),
  status: z.string(),
  statusReason: z.string().nullable(),
  error: z.unknown().nullable(),
});

type DecisionResult = {
  results: { actionId: string; status: string; statusReason: string | null; error: unknown }[];
};

function decisionFor(id: string, result: unknown) {
  const item = (result as DecisionResult).results.find((r) => r.actionId === id);
  if (!item) throw new OperationError("internal", `No decision recorded for ${id}`);
  return {
    actionId: item.actionId,
    status: item.status,
    statusReason: item.statusReason,
    error: item.error ?? null,
  };
}

export const extensionApprove = defineOperation({
  name: "extension.approve",
  description:
    "Approve an extension proposal (or its separate drop-hidden-data item) from the approval " +
    "queue: installs the proposed commit (schema reconcile, new version live) in the same " +
    "transaction as the approval and its audit row. The same as approving the action in the " +
    "Approvals inbox. Admin, human only.",
  input: z.object({ actionId, note: z.string().trim().max(1000).optional() }),
  output: decisionOutput,
  permission: "extensions:manage",
  risk: "extension",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    await extensionAction(ctx, input.actionId);
    const result = await ctx.pipeline.invoke(
      "approval.approve",
      { actionIds: [input.actionId], ...(input.note ? { note: input.note } : {}) },
      { actor: ctx.actor, user: ctx.user, origin: ctx.origin },
    );
    return decisionFor(input.actionId, result);
  },
});

export const extensionReject = defineOperation({
  name: "extension.reject",
  description:
    "Reject an extension proposal: nothing is installed (the commit stays in the workspace's " +
    "history). The same as rejecting it in the Approvals inbox. Admin, human only.",
  input: z.object({ actionId, note: z.string().trim().max(1000).optional() }),
  output: decisionOutput,
  permission: "extensions:manage",
  risk: "extension",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    await extensionAction(ctx, input.actionId);
    const result = await ctx.pipeline.invoke(
      "approval.reject",
      { actionIds: [input.actionId], ...(input.note ? { note: input.note } : {}) },
      { actor: ctx.actor, user: ctx.user, origin: ctx.origin },
    );
    return decisionFor(input.actionId, result);
  },
});

export const extensionAuthoringOperations = [
  extensionRead,
  extensionWrite,
  extensionEject,
  extensionApply,
  extensionPropose,
  extensionProposal,
  extensionApprove,
  extensionReject,
] as const;

export { shippedIssue, shippedRefusal };
