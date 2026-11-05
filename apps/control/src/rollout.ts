// Staged rollouts (ADR 0215): a new release reaches customer deployments in waves,
//
//   canary (deployments in the canary cohort: ours) → 10% → all
//
// each deployment updated with Stage 8's update procedure (runUpdate: pause automations, D1 Time
// Travel bookmark, migrations, switch, smoke check through its public hostname, resume), which
// rolls a failing deployment back by itself. More failures in a wave than `max_failures` pause the
// rollout. A paused rollout can be resumed, or rolled back: every deployment it updated gets the
// previous release redeployed and its bookmark restored (Stage 8's runRollback). That rewinds the
// database to just before the update, so writes made since then are lost; the console says so.
//
// Work happens in queue jobs of a few deployments each, so no invocation runs long, and nothing
// stays awake between waves (a delayed message carries the soak time).
import {
  apiKillSwitchStore,
  d1ApiMigrations,
  healthSmoke,
  killSwitchControl,
  readDeploymentState,
  runRollback,
  runUpdate,
} from "@relationship-os/release";
import { audit } from "./audit.ts";
import { type InstanceRow, instanceById, instanceState, updateInstance } from "./db.ts";
import { intVar } from "./env.ts";
import { cronsOf, publishRoute } from "./instances.ts";
import type { Services } from "./services.ts";
import { newId, sha256Hex } from "./util.ts";

export interface Wave {
  name: string;
  /** Share of the general cohort covered once this wave is done (canary: 0). */
  percent: number;
}

export const DEFAULT_WAVES: Wave[] = [
  { name: "canary", percent: 0 },
  { name: "10%", percent: 10 },
  { name: "all", percent: 100 },
];

/** Deployments updated per job. */
const BATCH = 5;

export interface RolloutRow {
  id: string;
  version: string;
  status: "running" | "paused" | "completed" | "rolled_back" | "cancelled";
  waves: string;
  current_wave: number;
  max_failures: number;
  note: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface TargetRow {
  rollout_id: string;
  instance_id: string;
  wave: number;
  status: "pending" | "succeeded" | "rolled_back" | "failed" | "reverted" | "skipped";
  from_version: string | null;
  bookmark: string | null;
  error: string | null;
  finished_at: string | null;
}

/** Assigns deployments to waves: canaries first, then a stable hash order of the rest. */
export async function assignWaves(instances: InstanceRow[], waves: Wave[]) {
  const canary = instances.filter((i) => i.cohort === "canary");
  const general = await Promise.all(
    instances
      .filter((i) => i.cohort !== "canary")
      .map(async (i) => ({ i, h: await sha256Hex(i.id) })),
  );
  general.sort((a, b) => a.h.localeCompare(b.h));
  const out: { instance: InstanceRow; wave: number }[] = canary.map((instance) => ({
    instance,
    wave: 0,
  }));
  let taken = 0;
  waves.forEach((wave, index) => {
    if (index === 0 && wave.percent === 0) return;
    const upTo = Math.ceil((general.length * wave.percent) / 100);
    for (; taken < upTo; taken++) {
      out.push({ instance: (general[taken] as { i: InstanceRow }).i, wave: index });
    }
  });
  return out;
}

export async function startRollout(
  s: Services,
  input: { version: string; staff: string; maxFailures?: number; note?: string; waves?: Wave[] },
): Promise<string> {
  await s.releases.load(input.version); // verified before anything changes
  const running = await s.db
    .prepare("SELECT id FROM cp_rollouts WHERE status IN ('running', 'paused') LIMIT 1")
    .first<{ id: string }>();
  if (running) throw new Error(`rollout ${running.id} is still in progress`);
  const { results } = await s.db
    .prepare(
      "SELECT * FROM cp_instances WHERE status IN ('active', 'paused', 'suspended') AND placement IN ('namespace', 'account') ORDER BY id",
    )
    .all<InstanceRow>();
  const targets = results.filter((i) => i.version !== input.version);
  const waves = input.waves ?? DEFAULT_WAVES;
  const assigned = await assignWaves(targets, waves);
  const id = newId("rol");
  const now = s.now().toISOString();
  const firstWave = assigned.length ? Math.min(...assigned.map((a) => a.wave)) : 0;
  await s.db.batch([
    s.db
      .prepare(
        "INSERT INTO cp_rollouts (id, version, status, waves, current_wave, max_failures, note, created_by, created_at, updated_at) VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        id,
        input.version,
        JSON.stringify(waves),
        firstWave,
        input.maxFailures ?? 0,
        input.note ?? null,
        input.staff,
        now,
        now,
      ),
    ...assigned.map((a) =>
      s.db
        .prepare(
          "INSERT INTO cp_rollout_targets (rollout_id, instance_id, wave, status, from_version) VALUES (?, ?, ?, 'pending', ?)",
        )
        .bind(id, a.instance.id, a.wave, a.instance.version),
    ),
  ]);
  await audit(
    s.db,
    {
      actorKind: "staff",
      actor: input.staff,
      action: "rollout.started",
      detail: { rollout: id, version: input.version, targets: assigned.length },
    },
    s.now(),
  );
  await s.enqueue({ kind: "rollout.step", rolloutId: id });
  return id;
}

async function rollout(s: Services, id: string) {
  return s.db.prepare("SELECT * FROM cp_rollouts WHERE id = ?").bind(id).first<RolloutRow>();
}

async function setRollout(s: Services, id: string, fields: Partial<RolloutRow>) {
  const entries = Object.entries({ ...fields, updated_at: s.now().toISOString() });
  await s.db
    .prepare(`UPDATE cp_rollouts SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .bind(...entries.map(([, v]) => v), id)
    .run();
}

async function setTarget(
  s: Services,
  rolloutId: string,
  instanceId: string,
  fields: Partial<TargetRow>,
) {
  const entries = Object.entries(fields);
  await s.db
    .prepare(
      `UPDATE cp_rollout_targets SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE rollout_id = ? AND instance_id = ?`,
    )
    .bind(...entries.map(([, v]) => v ?? null), rolloutId, instanceId)
    .run();
}

/** Updates one deployment with Stage 8's procedure. */
async function updateOne(s: Services, r: RolloutRow, target: TargetRow) {
  const instance = await instanceById(s.db, target.instance_id);
  const state = instance ? instanceState(instance) : null;
  if (!instance || !state || !instance.database_id || instance.status === "deleted") {
    await setTarget(s, r.id, target.instance_id, {
      status: "skipped",
      finished_at: s.now().toISOString(),
    });
    return "skipped" as const;
  }
  const databaseId = instance.database_id;
  const target_ = await s.releases.load(r.version);
  const outcome = await runUpdate({
    api: s.cf,
    state,
    databaseId,
    target: target_.bundle,
    targetDigest: target_.digest,
    previous: async () => (state.version ? (await s.releases.load(state.version)).bundle : null),
    migrations: d1ApiMigrations(s.cf, s.accountId, databaseId),
    automations: killSwitchControl(apiKillSwitchStore(s.cf, s.accountId, databaseId)),
    smoke: (hostname, version) =>
      healthSmoke(hostname, version, {
        fetch: s.healthFetch,
        attempts: s.fake ? 1 : 10,
        delayMs: s.fake ? 0 : 3000,
      }),
  });
  const now = s.now().toISOString();
  if (outcome.status === "succeeded") {
    const next = (await readDeploymentState(s.cf, s.accountId, databaseId)) ?? state;
    await updateInstance(
      s.db,
      instance.id,
      {
        version: r.version,
        state: JSON.stringify(next),
        crons: JSON.stringify(cronsOf(target_.bundle.manifest, next)),
      },
      s.now(),
    );
    const updated = await instanceById(s.db, instance.id);
    if (updated?.status === "active") await publishRoute(s, updated, "active");
  }
  const status =
    outcome.status === "succeeded"
      ? "succeeded"
      : outcome.status === "rolled_back"
        ? "rolled_back"
        : "failed";
  await setTarget(s, r.id, instance.id, {
    status,
    bookmark: outcome.bookmark,
    error: outcome.error ?? outcome.rollbackError ?? null,
    finished_at: now,
  });
  await audit(
    s.db,
    {
      actorKind: "system",
      actor: `rollout:${r.id}`,
      action: `instance.update.${status}`,
      accountId: instance.account_id,
      instanceId: instance.id,
      detail: { from: outcome.from, to: outcome.to, error: outcome.error ?? null },
    },
    s.now(),
  );
  return status;
}

/** One job: updates up to BATCH pending deployments of the current wave, then decides what next. */
export async function rolloutStep(s: Services, rolloutId: string): Promise<void> {
  const r = await rollout(s, rolloutId);
  if (r?.status !== "running") return;
  const waves = JSON.parse(r.waves) as Wave[];
  const { results: pending } = await s.db
    .prepare(
      "SELECT * FROM cp_rollout_targets WHERE rollout_id = ? AND wave = ? AND status = 'pending' ORDER BY instance_id LIMIT ?",
    )
    .bind(rolloutId, r.current_wave, BATCH)
    .all<TargetRow>();
  for (const target of pending) await updateOne(s, r, target);

  const failures = await s.db
    .prepare(
      "SELECT COUNT(*) AS n FROM cp_rollout_targets WHERE rollout_id = ? AND wave = ? AND status IN ('rolled_back', 'failed')",
    )
    .bind(rolloutId, r.current_wave)
    .first<{ n: number }>();
  if ((failures?.n ?? 0) > r.max_failures) {
    await setRollout(s, rolloutId, { status: "paused" });
    await audit(
      s.db,
      {
        actorKind: "system",
        actor: `rollout:${rolloutId}`,
        action: "rollout.paused",
        detail: { wave: waves[r.current_wave]?.name, failures: failures?.n },
      },
      s.now(),
    );
    return;
  }
  const left = await s.db
    .prepare(
      "SELECT COUNT(*) AS n FROM cp_rollout_targets WHERE rollout_id = ? AND wave = ? AND status = 'pending'",
    )
    .bind(rolloutId, r.current_wave)
    .first<{ n: number }>();
  if ((left?.n ?? 0) > 0) {
    await s.enqueue({ kind: "rollout.step", rolloutId });
    return;
  }
  const next = await s.db
    .prepare(
      "SELECT MIN(wave) AS wave FROM cp_rollout_targets WHERE rollout_id = ? AND wave > ? AND status = 'pending'",
    )
    .bind(rolloutId, r.current_wave)
    .first<{ wave: number | null }>();
  if (next?.wave == null) {
    await setRollout(s, rolloutId, { status: "completed", current_wave: waves.length - 1 });
    await audit(
      s.db,
      { actorKind: "system", actor: `rollout:${rolloutId}`, action: "rollout.completed" },
      s.now(),
    );
    return;
  }
  await setRollout(s, rolloutId, { current_wave: next.wave });
  // Soak before the next wave; a delayed queue message, so nothing waits.
  await s.enqueue(
    { kind: "rollout.step", rolloutId },
    { delaySeconds: intVar(s.env.ROLLOUT_SOAK_SECONDS, 3600) },
  );
}

export async function resumeRollout(s: Services, rolloutId: string, staff: string) {
  const r = await rollout(s, rolloutId);
  if (r?.status !== "paused") throw new Error("only a paused rollout can be resumed");
  // Resuming accepts this wave's failures: those deployments stay on their previous release
  // (marked skipped, their error kept) and the rollout carries on.
  await s.db
    .prepare(
      "UPDATE cp_rollout_targets SET status = 'skipped' WHERE rollout_id = ? AND wave = ? AND status IN ('rolled_back', 'failed')",
    )
    .bind(rolloutId, r.current_wave)
    .run();
  await setRollout(s, rolloutId, { status: "running" });
  await audit(
    s.db,
    { actorKind: "staff", actor: staff, action: "rollout.resumed", detail: { rollout: rolloutId } },
    s.now(),
  );
  await s.enqueue({ kind: "rollout.step", rolloutId });
}

/** Reverts every deployment the rollout updated: previous release + its bookmark (Stage 8). */
export async function rollBackRollout(s: Services, rolloutId: string, staff: string) {
  const r = await rollout(s, rolloutId);
  if (!r || !["paused", "running", "completed"].includes(r.status)) {
    throw new Error("nothing to roll back");
  }
  await setRollout(s, rolloutId, { status: "cancelled" });
  const { results } = await s.db
    .prepare(
      "SELECT * FROM cp_rollout_targets WHERE rollout_id = ? AND status = 'succeeded' ORDER BY wave DESC, instance_id",
    )
    .bind(rolloutId)
    .all<TargetRow>();
  for (const target of results) {
    const instance = await instanceById(s.db, target.instance_id);
    const state = instance ? instanceState(instance) : null;
    if (!instance?.database_id || !state || !target.from_version) continue;
    const previous = await s.releases.load(target.from_version);
    const restored = await runRollback({
      api: s.cf,
      state,
      databaseId: instance.database_id,
      previous: previous.bundle,
      previousDigest: previous.digest,
      bookmark: target.bookmark,
      automations: killSwitchControl(apiKillSwitchStore(s.cf, s.accountId, instance.database_id)),
    });
    const next = (await readDeploymentState(s.cf, s.accountId, instance.database_id)) ?? state;
    await updateInstance(
      s.db,
      instance.id,
      {
        version: restored.version,
        state: JSON.stringify(next),
        crons: JSON.stringify(cronsOf(previous.bundle.manifest, next)),
      },
      s.now(),
    );
    await setTarget(s, rolloutId, instance.id, { status: "reverted" });
    await audit(
      s.db,
      {
        actorKind: "staff",
        actor: staff,
        action: "instance.rolled_back",
        accountId: instance.account_id,
        instanceId: instance.id,
        detail: { rollout: rolloutId, to: restored.version, bookmark: target.bookmark },
      },
      s.now(),
    );
  }
  await setRollout(s, rolloutId, { status: "rolled_back" });
  await audit(
    s.db,
    {
      actorKind: "staff",
      actor: staff,
      action: "rollout.rolled_back",
      detail: { rollout: rolloutId },
    },
    s.now(),
  );
}
