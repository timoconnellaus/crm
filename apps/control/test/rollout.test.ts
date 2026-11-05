// Stage 10 AC3: a staged rollout updates N fake deployments in waves, pauses on injected failures,
// and rolls back with the Stage 8 bookmark mechanism.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { resetDispatchCaches } from "../src/dispatch/handler.ts";
import {
  assignWaves,
  DEFAULT_WAVES,
  resumeRollout,
  rollBackRollout,
  startRollout,
} from "../src/rollout.ts";
import { instanceFor, services, signUp, tenantFetch, tenantQuery } from "./helpers.ts";

const SLUGS = ["wave-a", "wave-b", "wave-c", "wave-d", "wave-e", "wave-f"];

async function fleet() {
  for (const slug of SLUGS) await signUp({ email: `o@${slug}.test`, slug, plan: "free" });
  // The first is ours: the canary cohort.
  await env.DB.prepare("UPDATE cp_instances SET cohort = 'canary' WHERE slug = ?")
    .bind(SLUGS[0])
    .run();
}

async function versions() {
  const out: Record<string, string | null> = {};
  for (const slug of SLUGS) out[slug] = (await instanceFor(slug))?.version ?? null;
  return out;
}

async function targets(rolloutId: string) {
  const { results } = await env.DB.prepare(
    "SELECT t.*, i.slug FROM cp_rollout_targets t JOIN cp_instances i ON i.id = t.instance_id WHERE rollout_id = ? ORDER BY wave, slug",
  )
    .bind(rolloutId)
    .all<{ slug: string; wave: number; status: string; bookmark: string | null }>();
  return results;
}

describe("staged rollouts", () => {
  it("assigns canaries, then 10%, then the rest", async () => {
    const make = (id: string, cohort: "canary" | "general") => ({ id, cohort }) as never;
    const assigned = await assignWaves(
      [make("c1", "canary"), ...Array.from({ length: 20 }, (_, i) => make(`g${i}`, "general"))],
      DEFAULT_WAVES,
    );
    const count = (wave: number) => assigned.filter((a) => a.wave === wave).length;
    expect([count(0), count(1), count(2)]).toEqual([1, 2, 18]);
  });

  it("updates every deployment in waves", async () => {
    const s = services();
    await fleet();
    s.fake.releases.publish("1.1.0");
    const id = await startRollout(s, { version: "1.1.0", staff: "staff@relationshiposcrm.com" });
    const rollout = await env.DB.prepare("SELECT status FROM cp_rollouts WHERE id = ?")
      .bind(id)
      .first<{ status: string }>();
    expect(rollout?.status).toBe("completed");
    expect(Object.values(await versions())).toEqual(SLUGS.map(() => "1.1.0"));
    const waves = (await targets(id)).map((t) => [t.slug, t.wave, t.status]);
    expect(waves[0]).toEqual(["wave-a", 0, "succeeded"]);
    expect(waves.filter((w) => w[1] === 1)).toHaveLength(1); // 10% of 5, rounded up
    resetDispatchCaches();
    const health = await tenantFetch(s, "https://wave-c.relationshiposcrm.com/api/health");
    expect(await health.json()).toMatchObject({ version: "1.1.0" });
    // Each deployment records its own update, as the self-updater would (core_install).
    const [state] = await tenantQuery<{ value: string }>(
      s,
      "wave-c",
      "SELECT value FROM core_install WHERE key = 'deployment'",
    );
    expect(JSON.parse(state?.value ?? "{}").version).toBe("1.1.0");
  });

  it("pauses on a failing wave (that deployment rolls itself back), then rolls the rest back", async () => {
    const s = services();
    s.fake.releases.publish("1.2.0");
    // Every general-cohort deployment fails its health check on the new release.
    for (const slug of SLUGS.slice(1)) s.fake.unhealthyHosts.add(`${slug}.relationshiposcrm.com`);
    const id = await startRollout(s, { version: "1.2.0", staff: "staff@relationshiposcrm.com" });

    const paused = await env.DB.prepare("SELECT status, current_wave FROM cp_rollouts WHERE id = ?")
      .bind(id)
      .first<{ status: string; current_wave: number }>();
    expect(paused).toMatchObject({ status: "paused", current_wave: 1 });
    const t = await targets(id);
    expect(t.filter((x) => x.wave === 0).map((x) => x.status)).toEqual(["succeeded"]);
    expect(t.filter((x) => x.wave === 1).map((x) => x.status)).toEqual(["rolled_back"]);
    expect(t.filter((x) => x.wave === 2).every((x) => x.status === "pending")).toBe(true);
    const v = await versions();
    expect(v["wave-a"]).toBe("1.2.0"); // the canary went through
    const failed = t.find((x) => x.wave === 1)?.slug as string;
    expect(v[failed]).toBe("1.1.0"); // runUpdate restored it
    resetDispatchCaches();

    // Something written on the canary after its update is undone by the rollback (bookmark).
    await tenantQuery(
      s,
      "wave-a",
      "INSERT INTO core_person (id, name) VALUES ('p1', 'After update')",
    );
    await rollBackRollout(s, id, "staff@relationshiposcrm.com");
    expect((await versions())["wave-a"]).toBe("1.1.0");
    expect(
      await tenantQuery(s, "wave-a", "SELECT id FROM core_person WHERE id = 'p1'"),
    ).toHaveLength(0);
    const after = await env.DB.prepare("SELECT status FROM cp_rollouts WHERE id = ?")
      .bind(id)
      .first<{ status: string }>();
    expect(after?.status).toBe("rolled_back");
    expect((await targets(id)).find((x) => x.slug === "wave-a")?.status).toBe("reverted");
    const health = await tenantFetch(s, "https://wave-a.relationshiposcrm.com/api/health");
    expect(await health.json()).toMatchObject({ version: "1.1.0" });
  });

  it("a paused rollout can resume, accepting the failed wave", async () => {
    const s = services();
    s.fake.unhealthyHosts.clear();
    s.fake.releases.publish("1.3.0");
    const bad = SLUGS[1] as string;
    // Fail whichever deployment lands in the 10% wave.
    for (const slug of SLUGS.slice(1)) s.fake.unhealthyHosts.add(`${slug}.relationshiposcrm.com`);
    const id = await startRollout(s, { version: "1.3.0", staff: "staff@relationshiposcrm.com" });
    s.fake.unhealthyHosts.clear();
    await resumeRollout(s, id, "staff@relationshiposcrm.com");
    const done = await env.DB.prepare("SELECT status FROM cp_rollouts WHERE id = ?")
      .bind(id)
      .first<{ status: string }>();
    expect(done?.status).toBe("completed");
    const t = await targets(id);
    expect(t.filter((x) => x.status === "skipped")).toHaveLength(1);
    expect(t.filter((x) => x.status === "succeeded")).toHaveLength(SLUGS.length - 1);
    expect(bad).toBeTruthy();
  });
});
