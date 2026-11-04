// Checking and installing extensions (ADR 0025). `checkExtension` is `extension.check`;
// `installExtension` is the one path that makes a version live, used by extension.install,
// extension.rollback and (stage 3b) extension.approve. Both run inside an operation handler: the
// install's DDL, state rows and audit commit in the operation's single D1 batch.
import type { CoreDatabase } from "@crm/db";
import { type ExtensionManifest, type ManifestIssue, validateManifest } from "@crm/sdk";
import type { Kysely } from "kysely";
import { automationSyncStatements } from "../automations/registry.ts";
import { dashboardSpecSchema } from "../dashboards/spec.ts";
import { ConfigError, ValidationError } from "../errors.ts";
import { listObjects } from "../fields/index.ts";
import type { HandlerContext } from "../operation.ts";
import type { ExtensionHost, SourceIssue } from "./host.ts";
import { CORE_TARGETS, isCoreTarget } from "./naming.ts";
import {
  planReconcile,
  type ReconcileIssue,
  type ReconcilePlan,
  type SchemaChange,
} from "./reconciler.ts";
import { coreFormulaFields } from "./schema.ts";

/** One problem `extension.check` found, in a shape a model can act on. */
export interface CheckIssue {
  /** Which check found it. */
  stage: "typecheck" | "contract" | "formula" | "reconcile";
  code: string;
  /** Where: a file path for source issues, a manifest path otherwise. */
  path: string;
  message: string;
  suggestion?: string;
  span?: { start: number; end: number };
}

export interface CheckResult {
  ok: boolean;
  issues: CheckIssue[];
  manifest: ExtensionManifest | null;
  /** The dry-run reconcile: DDL in order and the schema changes it makes. */
  plan: { ddl: string[]; changes: SchemaChange[] } | null;
}

export function requireHost(ctx: HandlerContext): ExtensionHost {
  if (!ctx.extensionHost) {
    throw new ConfigError("The extension runtime is not available to this caller");
  }
  return ctx.extensionHost;
}

function fromSource(issue: SourceIssue): CheckIssue {
  return { stage: "typecheck", code: issue.code, path: issue.path, message: issue.message };
}

function fromManifest(issue: ManifestIssue): CheckIssue {
  return {
    stage: issue.code === "contract" ? "contract" : "formula",
    code: issue.code,
    path: issue.path,
    message: issue.message,
    ...(issue.span ? { span: issue.span } : {}),
  };
}

function fromReconcile(issue: ReconcileIssue): CheckIssue {
  return {
    stage: issue.code === "formula" ? "formula" : "reconcile",
    code: issue.code,
    path: issue.path,
    message: issue.message,
    ...(issue.suggestion ? { suggestion: issue.suggestion } : {}),
  };
}

/**
 * Validates an evaluated manifest for extension `id` and dry-runs its reconcile. Pure apart from
 * reading state.
 */
export async function checkManifest(
  db: Kysely<CoreDatabase>,
  id: string,
  rawManifest: unknown,
  now: string,
): Promise<{
  issues: CheckIssue[];
  manifest: ExtensionManifest | null;
  plan: ReconcilePlan | null;
}> {
  const knownObjects = listObjects()
    .map((o) => o.name)
    .filter((name) => name.includes(".") && !name.startsWith(`${id}.`));
  const { manifest, issues } = validateManifest(rawManifest, {
    knownObjects,
    baseFields: (object) => (isCoreTarget(object) ? coreFormulaFields(object) : {}),
  });
  const all = issues.map(fromManifest);
  // Shipped dashboards (ADR 0103) must be valid dashboard specs; their SQL runs through the
  // query.sql guards when shown (the views it reads may not exist until this install).
  for (const [name, dashboard] of Object.entries(manifest?.dashboards ?? {})) {
    const parsed = dashboardSpecSchema.safeParse(dashboard);
    if (!parsed.success) {
      for (const issue of parsed.error.issues.slice(0, 10)) {
        all.push({
          stage: "contract",
          code: "contract",
          path: `dashboards.${name}.${issue.path.join(".")}`,
          message: issue.message,
        });
      }
    }
  }
  if (manifest && manifest.id !== id) {
    all.push({
      stage: "contract",
      code: "contract",
      path: "id",
      message: `The extension declares id "${manifest.id}" but is installed as "${id}"`,
    });
  }
  if (!manifest || all.length) return { issues: all, manifest, plan: null };
  const plan = await planReconcile(db, manifest, { now });
  return { issues: plan.issues.map(fromReconcile), manifest, plan };
}

/** `extension.check`: typecheck (transpile + imports), contract, formulas, dry-run reconcile. */
export async function checkExtension(
  ctx: HandlerContext,
  input: { id: string; commit: string } | { id: string; files: Record<string, string> },
): Promise<CheckResult> {
  const host = requireHost(ctx);
  const evaluated = await host.evaluate(input);
  if (!evaluated.ok) {
    return { ok: false, issues: evaluated.issues.map(fromSource), manifest: null, plan: null };
  }
  const { issues, manifest, plan } = await checkManifest(
    ctx.db,
    input.id,
    evaluated.manifest,
    ctx.now,
  );
  return {
    ok: issues.length === 0,
    issues,
    manifest,
    plan: plan ? { ddl: plan.ddl, changes: plan.changes } : null,
  };
}

export interface InstallResult {
  id: string;
  version: string;
  commit: string;
  source: "shipped" | "runtime";
  changes: SchemaChange[];
  /** False when this exact commit was already the installed version (nothing changed). */
  changed: boolean;
}

function firstIssue(issues: CheckIssue[]): string {
  const first = issues[0];
  if (!first) return "";
  const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : "";
  return `: ${first.path}: ${first.message}${more}`;
}

/** The core_user id of an extension's principal (ADR 0025). */
export function extensionPrincipalId(id: string): string {
  return `extension:${id}`;
}

/**
 * Makes `commit` of extension `id` the live version: evaluates it in the sandbox, checks it,
 * and queues the reconcile DDL, the state rows and the principal on `ctx`'s batch. Throws
 * ValidationError (details.issues: CheckIssue[]) when the check fails. Stage 3b's
 * `extension.approve` calls this with the approved commit.
 */
export async function installExtension(
  ctx: HandlerContext,
  input: {
    id: string;
    commit: string;
    source: "shipped" | "runtime";
    /** Allow a shipped extension to become a runtime one (an approved eject, ADR 0041). */
    eject?: boolean;
  },
): Promise<InstallResult> {
  const host = requireHost(ctx);
  const existing = await ctx.db
    .selectFrom("core_extensions")
    .selectAll()
    .where("id", "=", input.id)
    .executeTakeFirst();
  const ejecting = input.eject && existing?.source === "shipped" && input.source === "runtime";
  if (existing && existing.source !== input.source && !ejecting) {
    throw new ValidationError(
      `${input.id} is already installed as a ${existing.source} extension`,
      { id: input.id },
    );
  }
  const evaluated = await host.evaluate({ id: input.id, commit: input.commit });
  if (!evaluated.ok) {
    const issues = evaluated.issues.map(fromSource);
    throw new ValidationError(`${input.id} failed its check${firstIssue(issues)}`, { issues });
  }
  const { issues, manifest, plan } = await checkManifest(
    ctx.db,
    input.id,
    evaluated.manifest,
    ctx.now,
  );
  if (issues.length || !manifest || !plan) {
    throw new ValidationError(`${input.id} failed its check${firstIssue(issues)}`, { issues });
  }
  const unchanged =
    existing?.commit_oid === input.commit &&
    existing.status === "active" &&
    plan.changes.length === 0;
  if (unchanged) {
    return {
      id: input.id,
      version: manifest.version,
      commit: input.commit,
      source: input.source,
      changes: [],
      changed: false,
    };
  }

  const principal = extensionPrincipalId(input.id);
  const user = await ctx.db
    .selectFrom("core_user")
    .select("id")
    .where("id", "=", principal)
    .executeTakeFirst();
  if (!user) {
    ctx.write(
      ctx.db.insertInto("core_user").values({
        id: principal,
        name: manifest.label ?? input.id,
        email: `${input.id}@extensions.crm.invalid`,
        email_verified: 0,
        image: null,
        created_at: ctx.now,
        updated_at: ctx.now,
        role: "member",
        kind: "extension",
      }),
    );
  }
  ctx.write(...plan.statements);
  const installedBy = ctx.user.id === "system" ? null : ctx.user.id;
  const manifestJson = JSON.stringify(manifest);
  ctx.write(
    ctx.db
      .insertInto("core_extensions")
      .values({
        id: input.id,
        source: input.source,
        status: "active",
        status_reason: null,
        version: manifest.version,
        commit_oid: input.commit,
        last_good_commit: existing?.last_good_commit ?? null,
        manifest: manifestJson,
        failure_count: 0,
        user_id: principal,
        installed_at: ctx.now,
        installed_by: installedBy,
        updated_at: ctx.now,
      })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          source: input.source,
          status: "active",
          status_reason: null,
          version: manifest.version,
          commit_oid: input.commit,
          manifest: manifestJson,
          failure_count: 0,
          updated_at: ctx.now,
        }),
      ),
    ctx.db
      .insertInto("core_extension_versions")
      .values({
        extension_id: input.id,
        commit_oid: input.commit,
        version: manifest.version,
        manifest: manifestJson,
        installed_at: ctx.now,
        installed_by: installedBy,
      })
      .onConflict((oc) =>
        oc.columns(["extension_id", "commit_oid"]).doUpdateSet({ installed_at: ctx.now }),
      ),
  );
  // The extension's automations join the registry (ADR 0130); enabled flags and pauses persist.
  ctx.write(
    ...automationSyncStatements(ctx.db, {
      extensionId: input.id,
      commit: input.commit,
      automations: manifest.automations ?? {},
      now: ctx.now,
    }),
  );
  return {
    id: input.id,
    version: manifest.version,
    commit: input.commit,
    source: input.source,
    changes: plan.changes,
    changed: true,
  };
}

export { CORE_TARGETS };
