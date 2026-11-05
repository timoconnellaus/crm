// update.* operations: Settings → Updates (ADR 0054, ADR 0164).
//
// - update.status      installed version, channel, whether in-app updates are possible, history
// - update.releases    published releases on the channel (public GitHub Releases, cached an hour)
// - update.setChannel  stable or beta (human admins)
// - update.preflight   what an update would do and what blocks it
// - update.apply       the update itself: human admins only, never from MCP, audited
// - update.rollback    redeploy the previous release and restore its bookmark
//
// Everything that leaves the Worker goes through ctx.updater (src/server/updater.ts in crm-app).
// No telemetry: the only outbound reads are public GitHub release pages (ADR 0166).
import {
  CHANNELS,
  type Channel,
  compareVersions,
  type DeploymentState,
  isVersion,
  newRunId,
  type PreflightResult,
  preflight,
  type ReleaseInfo,
  type RunRecord,
} from "@crm/release";
import { z } from "zod";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { automationControlFor, type UpdaterRuntime } from "../updates.ts";

export const UPDATE_CHANNEL_SETTING = "update_channel";
/** How long the cached release list is used before GitHub is asked again. */
export const RELEASE_CACHE_MS = 60 * 60 * 1000;

const channelSchema = z.enum(CHANNELS as unknown as [Channel, ...Channel[]]);
const versionSchema = z.string().refine(isVersion, "Expected X.Y.Z or X.Y.Z-beta.N");

const runSchema = z.object({
  id: z.string(),
  kind: z.enum(["update", "rollback"]),
  fromVersion: z.string().nullable(),
  toVersion: z.string(),
  status: z.enum(["running", "succeeded", "rolled_back", "failed"]),
  step: z.string().nullable(),
  error: z.string().nullable(),
  surface: z.enum(["ui", "cli"]),
  startedBy: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  canRollBack: z.boolean(),
});

function runOut(row: RunRecord, latestFinished: string | null) {
  return {
    id: row.id,
    kind: row.kind,
    fromVersion: row.from_version,
    toVersion: row.to_version,
    status: row.status,
    step: row.step,
    error: row.error,
    surface: row.surface,
    startedBy: row.started_by,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    canRollBack:
      row.id === latestFinished &&
      row.kind === "update" &&
      row.status === "succeeded" &&
      Boolean(row.bookmark && row.from_version),
  };
}

export async function loadDeploymentState(
  ctx: Pick<HandlerContext, "db">,
): Promise<DeploymentState | null> {
  const row = await ctx.db
    .selectFrom("core_install")
    .select("value")
    .where("key", "=", "deployment")
    .executeTakeFirst();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as DeploymentState;
  } catch {
    return null;
  }
}

async function loadChannel(ctx: Pick<HandlerContext, "db">, state: DeploymentState | null) {
  const row = await ctx.db
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", UPDATE_CHANNEL_SETTING)
    .executeTakeFirst();
  try {
    const value = row ? (JSON.parse(row.value) as unknown) : null;
    if (value === "stable" || value === "beta") return value;
  } catch {}
  return state?.channel ?? "stable";
}

async function loadRuns(ctx: Pick<HandlerContext, "db">, limit = 20) {
  return (await ctx.db
    .selectFrom("core_update_runs")
    .selectAll()
    .orderBy("started_at", "desc")
    .limit(limit)
    .execute()) as RunRecord[];
}

function requireUpdater(ctx: HandlerContext): UpdaterRuntime {
  if (!ctx.updater) throw new ValidationError("Updates are not available in this context");
  return ctx.updater;
}

function cliCommand(version?: string) {
  return `npx create-crm upgrade${version ? ` --version ${version}` : ""}`;
}

const statusOutput = z.object({
  currentVersion: z.string().nullable().describe("Installed release; null for a source deploy"),
  channel: channelSchema,
  repository: z.string(),
  canUpdateInApp: z.boolean().describe("A scoped update token is stored, so Update works here"),
  installedFromRelease: z.boolean(),
  hostname: z.string().nullable(),
  cliCommand: z.string().describe("The command an operator runs to update without a token"),
  running: runSchema.nullable(),
  runs: z.array(runSchema),
});

export const updateStatus = defineOperation({
  name: "update.status",
  description:
    "The deployment's installed release, update channel, whether it can update itself (a scoped " +
    "token is stored) and its update history. Admins only. Read-only.",
  input: z.object({}),
  output: statusOutput,
  permission: "settings:manage",
  risk: "read",
  mcp: { expose: false },
  async handler(_input, ctx) {
    const state = await loadDeploymentState(ctx);
    const runs = await loadRuns(ctx);
    const latestFinished = runs.find((r) => r.status !== "running")?.id ?? null;
    const running = runs.find((r) => r.status === "running") ?? null;
    return {
      currentVersion: ctx.updater?.currentVersion ?? state?.version ?? null,
      channel: await loadChannel(ctx, state),
      repository: ctx.updater?.repository ?? "timoconnellaus/crm",
      canUpdateInApp: Boolean(ctx.updater?.canUpdate && state),
      installedFromRelease: Boolean(state),
      hostname: state?.hostname ?? null,
      cliCommand: cliCommand(),
      running: running ? runOut(running, latestFinished) : null,
      runs: runs.map((r) => runOut(r, latestFinished)),
    };
  },
});

const releaseSchema = z.object({
  version: z.string(),
  channel: channelSchema,
  name: z.string(),
  notes: z.string().describe("The changelog: the release's notes, generated from PR titles"),
  publishedAt: z.string().nullable(),
  url: z.string(),
  newer: z.boolean(),
});

export const updateReleases = defineOperation({
  name: "update.releases",
  description:
    "Releases published on the deployment's channel (public GitHub Releases, cached for an " +
    "hour), newest first, with their changelogs and whether each is newer than what is " +
    "installed. Admins only.",
  input: z.object({ refresh: z.boolean().optional().describe("Ask GitHub now, not the cache") }),
  output: z.object({
    channel: channelSchema,
    fetchedAt: z.string().nullable(),
    releases: z.array(releaseSchema),
    error: z.string().nullable(),
  }),
  permission: "settings:manage",
  risk: "read",
  mcp: { expose: false },
  async handler(input, ctx) {
    const state = await loadDeploymentState(ctx);
    const channel = await loadChannel(ctx, state);
    const current = ctx.updater?.currentVersion ?? state?.version ?? null;
    const cached = await ctx.db
      .selectFrom("core_release_cache")
      .selectAll()
      .where("channel", "=", channel)
      .executeTakeFirst();
    let releases: ReleaseInfo[] = cached ? (JSON.parse(cached.releases) as ReleaseInfo[]) : [];
    let fetchedAt = cached?.fetched_at ?? null;
    let error: string | null = null;
    const stale = !fetchedAt || Date.parse(ctx.now) - Date.parse(fetchedAt) > RELEASE_CACHE_MS;
    if ((stale || input.refresh) && ctx.updater) {
      try {
        releases = await ctx.updater.listReleases(channel);
        fetchedAt = ctx.now;
        const value = JSON.stringify(releases);
        // A cache of public data, not a change: written directly rather than queued, so this
        // stays a read.
        await ctx.db
          .insertInto("core_release_cache")
          .values({ channel, releases: value, fetched_at: ctx.now })
          .onConflict((oc) =>
            oc.column("channel").doUpdateSet({ releases: value, fetched_at: ctx.now }),
          )
          .execute();
      } catch (e) {
        error = `Could not reach GitHub Releases: ${(e as Error).message}`;
      }
    }
    return {
      channel,
      fetchedAt,
      error,
      releases: releases.map((r) => ({
        version: r.version,
        channel: r.channel,
        name: r.name,
        notes: r.notes,
        publishedAt: r.publishedAt,
        url: r.url,
        newer: current && isVersion(current) ? compareVersions(r.version, current) > 0 : false,
      })),
    };
  },
});

export const updateSetChannel = defineOperation({
  name: "update.setChannel",
  description:
    "Choose the update channel: stable (releases only) or beta (betas too). Human admins only.",
  input: z.object({ channel: channelSchema }),
  output: z.object({ channel: channelSchema }),
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const state = await loadDeploymentState(ctx);
    const before = await loadChannel(ctx, state);
    const value = JSON.stringify(input.channel);
    ctx.write(
      ctx.db
        .insertInto("core_settings")
        .values({
          key: UPDATE_CHANNEL_SETTING,
          value,
          updated_at: ctx.now,
          updated_by: ctx.user.id,
        })
        .onConflict((oc) =>
          oc.column("key").doUpdateSet({ value, updated_at: ctx.now, updated_by: ctx.user.id }),
        ),
    );
    if (state) {
      const next = JSON.stringify({ ...state, channel: input.channel });
      ctx.write(
        ctx.db
          .updateTable("core_install")
          .set({ value: next, updated_at: ctx.now })
          .where("key", "=", "deployment"),
      );
    }
    ctx.recordChange({
      object: "deployment",
      id: "release",
      action: "update",
      before: { channel: before },
      after: { channel: input.channel },
    });
    return { channel: input.channel };
  },
});

const preflightSchema = z.object({
  ok: z.boolean(),
  from: z.string().nullable(),
  to: z.string(),
  blockers: z.array(z.object({ code: z.string(), message: z.string() })),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
  migrations: z.array(z.string()),
  extensions: z.array(
    z.object({
      id: z.string(),
      contractVersion: z.number(),
      compatible: z.boolean(),
      status: z.string(),
    }),
  ),
  gatekeepers: z.object({
    added: z.array(z.string()),
    removed: z.array(z.string()),
    changed: z.array(z.string()),
  }),
  secrets: z.array(
    z.object({
      worker: z.string(),
      name: z.string(),
      required: z.boolean(),
      set: z.boolean().nullable(),
    }),
  ),
  inputs: z.array(z.string()),
  cliCommand: z.string(),
});

async function runPreflight(
  ctx: HandlerContext,
  version: string,
  state: DeploymentState | null,
): Promise<PreflightResult> {
  const updater = requireUpdater(ctx);
  const target = await updater.manifest(version);
  if (!target) throw new NotFoundError("release", version);
  const currentVersion = updater.currentVersion ?? state?.version ?? null;
  const current =
    currentVersion && isVersion(currentVersion) ? await updater.manifest(currentVersion) : null;
  const applied = await ctx.db.selectFrom("core_migrations").select("name").orderBy("id").execute();
  const extensions = await ctx.db
    .selectFrom("core_extensions")
    .select(["id", "source", "status", "manifest"])
    .execute();
  return preflight({
    currentVersion,
    current,
    target,
    appliedMigrations: applied.map((m) => m.name as string),
    extensions: extensions.map((e) => {
      let contractVersion = 0;
      try {
        contractVersion = Number(
          (JSON.parse(e.manifest) as { contractVersion?: number }).contractVersion ?? 0,
        );
      } catch {}
      return { id: e.id, source: e.source, status: e.status, contractVersion };
    }),
    installedGatekeepers: state?.gatekeepers ?? [],
    ...(state ? { secretsSet: await updater.secretsSet(state) } : {}),
  });
}

export const updatePreflight = defineOperation({
  name: "update.preflight",
  description:
    "Check an update before running it: runtime extensions against the new extension contract, " +
    "pending core migrations, gatekeeper changes and new secrets or inputs. `ok` false means " +
    "Update is refused; `blockers` say why and what to do. Admins only. Read-only.",
  input: z.object({ version: versionSchema }),
  output: preflightSchema,
  permission: "settings:manage",
  risk: "read",
  mcp: { expose: false },
  async handler(input, ctx) {
    const state = await loadDeploymentState(ctx);
    return {
      ...(await runPreflight(ctx, input.version, state)),
      cliCommand: cliCommand(input.version),
    };
  },
});

/**
 * Writes a run row immediately, outside the operation's batch: an update's progress must be
 * visible while it runs, and the row must be written again after a Time Travel restore (which
 * rewinds the whole database). The operation's own audit row commits after the handler, so it
 * survives a restore.
 */
function runRecorder(ctx: HandlerContext) {
  return async (run: RunRecord) => {
    await ctx.db
      .insertInto("core_update_runs")
      .values(run)
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          status: run.status,
          step: run.step,
          bookmark: run.bookmark,
          error: run.error,
          finished_at: run.finished_at,
        }),
      )
      .execute();
  };
}

export const updateApply = defineOperation({
  name: "update.apply",
  description:
    "Update this deployment to a release: pause automations, take a D1 Time Travel bookmark, run " +
    "core migrations, switch all Workers together, smoke-check, resume. A failure rolls back to " +
    "the installed release and restores the bookmark. Refused when preflight finds a blocker. " +
    "Human admins only, never from AI or MCP; audited.",
  input: z.object({ version: versionSchema }),
  output: z.object({
    runId: z.string(),
    status: z.enum(["succeeded", "rolled_back", "failed"]),
    from: z.string(),
    to: z.string(),
    migrations: z.array(z.string()),
    error: z.string().nullable(),
  }),
  permission: "settings:manage",
  risk: "destructive",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const updater = requireUpdater(ctx);
    const state = await loadDeploymentState(ctx);
    if (!state || !updater.canUpdate) {
      throw new ValidationError(
        `This deployment has no stored update token, so it cannot update itself. Run \`${cliCommand(input.version)}\` from a machine with a Cloudflare API token.`,
        { cliCommand: cliCommand(input.version) },
      );
    }
    const runs = await loadRuns(ctx, 5);
    if (runs.some((r) => r.status === "running")) {
      throw new ConflictError("Another update is running");
    }
    const check = await runPreflight(ctx, input.version, state);
    if (!check.ok) {
      throw new ConflictError(
        `Preflight blocked the update: ${check.blockers.map((b) => b.message).join(" ")}`,
        { blockers: check.blockers },
      );
    }
    const run: RunRecord = {
      id: newRunId(),
      kind: "update",
      from_version: updater.currentVersion ?? state.version,
      to_version: input.version,
      status: "running",
      step: null,
      bookmark: null,
      bundle_digest: null,
      preflight: JSON.stringify(check),
      error: null,
      started_by: ctx.user.id,
      surface: "ui",
      started_at: ctx.now,
      finished_at: null,
    };
    const record = runRecorder(ctx);
    await record(run);
    const outcome = await updater.apply({
      version: input.version,
      state,
      run,
      record,
      automations: automationControlFor(ctx.db),
    });
    ctx.recordChange({
      object: "deployment",
      id: "release",
      action: "update",
      before: { version: outcome.from },
      after: {
        version: outcome.status === "succeeded" ? outcome.to : outcome.from,
        update: outcome.status,
        ...(outcome.bookmark ? { bookmark: outcome.bookmark } : {}),
      },
    });
    return {
      runId: run.id,
      status: outcome.status,
      from: outcome.from,
      to: outcome.to,
      migrations: outcome.migrations,
      error: outcome.rollbackError
        ? `${outcome.error}; rollback failed: ${outcome.rollbackError}`
        : (outcome.error ?? null),
    };
  },
});

export const updateRollback = defineOperation({
  name: "update.rollback",
  description:
    "Undo the last update: redeploy the release it replaced and restore the database to the " +
    "bookmark taken before it (changes since then are lost). Human admins only; audited.",
  input: z.object({ runId: z.string() }),
  output: z.object({ version: z.string() }),
  permission: "settings:manage",
  risk: "destructive",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const updater = requireUpdater(ctx);
    const state = await loadDeploymentState(ctx);
    if (!state || !updater.canUpdate) {
      throw new ValidationError("This deployment has no stored update token. Run `crm rollback`.");
    }
    const runs = await loadRuns(ctx, 50);
    const latest = runs.find((r) => r.status !== "running");
    const run = runs.find((r) => r.id === input.runId);
    if (!run) throw new NotFoundError("update run", input.runId);
    if (
      run !== latest ||
      run.kind !== "update" ||
      run.status !== "succeeded" ||
      !run.from_version
    ) {
      throw new ConflictError("Only the most recent successful update can be rolled back");
    }
    await updater.rollback({ run, state, automations: automationControlFor(ctx.db) });
    // The restore rewound core_update_runs: record the update as rolled back, and this rollback.
    const record = runRecorder(ctx);
    await record({ ...run, status: "rolled_back" });
    await record({
      id: newRunId(),
      kind: "rollback",
      from_version: run.to_version,
      to_version: run.from_version,
      status: "succeeded",
      step: "done",
      bookmark: run.bookmark,
      bundle_digest: null,
      preflight: null,
      error: null,
      started_by: ctx.user.id,
      surface: "ui",
      started_at: ctx.now,
      finished_at: new Date().toISOString(),
    });
    ctx.recordChange({
      object: "deployment",
      id: "release",
      action: "update",
      before: { version: run.to_version },
      after: { version: run.from_version, rollback: true },
    });
    return { version: run.from_version };
  },
});

export const updateOperations = [
  updateStatus,
  updateReleases,
  updateSetChannel,
  updatePreflight,
  updateApply,
  updateRollback,
] as const;
