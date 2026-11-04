// update.* operations (ADR 0164) with a fake UpdaterRuntime: preflight blocking an incompatible
// runtime extension (AC5), channels (AC7), human-admin-only apply and rollback with history and
// audit, the release cache, and the CLI fallback without a token. The real runtime (download,
// verification, Cloudflare API) is tested in crm-app and packages/release.
import { env } from "cloudflare:workers";
import type {
  Channel,
  DeploymentState,
  ReleaseManifest,
  RunRecord,
  UpdateOutcome,
} from "@crm/release";
import { buildFixtureRelease } from "@crm/release/testing";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type ActingUser, invokeByName, type UpdaterRuntime } from "../src/index.ts";
import { auditRows, context, createUser } from "./helpers.ts";

let admin: ActingUser;
let member: ActingUser;
const manifests = new Map<string, ReleaseManifest>();
const calls: string[] = [];

const STATE: DeploymentState = {
  version: "1.0.0",
  accountId: "acc",
  hostname: "crm.example.com",
  hostnameMode: "custom",
  identityProvider: "better-auth",
  channel: "stable",
  gatekeepers: [],
  workerNames: {},
  vars: {},
  resources: { "D1_ID(crm)": "db" },
};

function runtime(overrides: Partial<UpdaterRuntime> = {}): UpdaterRuntime {
  return {
    currentVersion: "1.0.0",
    repository: "timoconnellaus/crm",
    canUpdate: true,
    async listReleases(channel: Channel) {
      calls.push(`list:${channel}`);
      return [...manifests.values()]
        .filter((m) => channel === "beta" || m.channel === "stable")
        .map((m) => ({
          version: m.version,
          tag: `v${m.version}`,
          channel: m.channel,
          name: `v${m.version}`,
          notes: `## What's changed\n- things in ${m.version}`,
          publishedAt: "2026-11-01T00:00:00Z",
          url: `https://github.com/timoconnellaus/crm/releases/tag/v${m.version}`,
          assets: {},
        }))
        .reverse();
    },
    async manifest(version) {
      return manifests.get(version) ?? null;
    },
    async secretsSet() {
      return { "crm-app": ["BETTER_AUTH_SECRET"] };
    },
    async apply({ version, run, record }): Promise<UpdateOutcome> {
      calls.push(`apply:${version}`);
      await record({ ...run, step: "bookmark", bookmark: "bm-1" });
      await record({
        ...run,
        status: "succeeded",
        step: "done",
        bookmark: "bm-1",
        finished_at: new Date().toISOString(),
      });
      return { status: "succeeded", from: "1.0.0", to: version, bookmark: "bm-1", migrations: [] };
    },
    async rollback({ run }) {
      calls.push(`rollback:${run.from_version}`);
    },
    ...overrides,
  };
}

async function resetRuns() {
  await env.DB.prepare("DELETE FROM core_update_runs").run();
  await env.DB.prepare("DELETE FROM core_release_cache").run();
  await env.DB.prepare("DELETE FROM core_settings WHERE key = 'update_channel'").run();
}

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  const applied = await env.DB.prepare("SELECT name FROM core_migrations ORDER BY id").all<{
    name: string;
  }>();
  for (const [version, contract] of [
    ["1.0.0", { version: 1, supported: [1] }],
    ["1.1.0", { version: 1, supported: [1] }],
    ["1.2.0-beta.1", { version: 1, supported: [1] }],
    ["2.0.0", { version: 2, supported: [2] }],
  ] as const) {
    const { manifest } = await buildFixtureRelease({
      version,
      contract: { version: contract.version, supported: [...contract.supported] },
    });
    // This database's real migrations, so preflight sees nothing unknown.
    manifest.migrations = applied.results.map((m) => ({ name: m.name, sha256: "" }));
    manifests.set(version, manifest);
  }
  await env.DB.prepare(
    "INSERT INTO core_install (key, value, updated_at) VALUES ('deployment', ?, ?)",
  )
    .bind(JSON.stringify(STATE), new Date().toISOString())
    .run();
});

beforeEach(async () => {
  calls.length = 0;
  await resetRuns();
});

describe("update.status and channels", () => {
  it("is admin only", async () => {
    await expect(
      invokeByName("update.status", {}, context(member, { updater: runtime() })),
    ).rejects.toMatchObject({ code: "forbidden" });
    const status = await invokeByName("update.status", {}, context(admin, { updater: runtime() }));
    expect(status).toMatchObject({
      currentVersion: "1.0.0",
      channel: "stable",
      canUpdateInApp: true,
      installedFromRelease: true,
      cliCommand: "npx create-crm upgrade",
    });
  });

  it("a stable deployment sees stable releases only; switching to beta shows betas", async () => {
    const ctx = context(admin, { updater: runtime() });
    const stable = (await invokeByName("update.releases", {}, ctx)) as {
      releases: { version: string; newer: boolean }[];
    };
    expect(stable.releases.map((r) => r.version)).toEqual(["2.0.0", "1.1.0", "1.0.0"]);
    expect(stable.releases.find((r) => r.version === "1.0.0")?.newer).toBe(false);
    await invokeByName("update.setChannel", { channel: "beta" }, ctx);
    const beta = (await invokeByName("update.releases", {}, ctx)) as {
      channel: string;
      releases: { version: string }[];
    };
    expect(beta.channel).toBe("beta");
    expect(beta.releases.map((r) => r.version)).toContain("1.2.0-beta.1");
    const stored = await env.DB.prepare("SELECT value FROM core_install").first<{
      value: string;
    }>();
    expect(JSON.parse(stored?.value ?? "{}").channel).toBe("beta");
    await invokeByName("update.setChannel", { channel: "stable" }, ctx);
  });

  it("caches the release list for an hour", async () => {
    const ctx = context(admin, { updater: runtime() });
    await invokeByName("update.releases", {}, ctx);
    await invokeByName("update.releases", {}, ctx);
    expect(calls.filter((c) => c.startsWith("list:"))).toHaveLength(1);
    await invokeByName("update.releases", { refresh: true }, ctx);
    expect(calls.filter((c) => c.startsWith("list:"))).toHaveLength(2);
  });

  it("only a person can change the channel", async () => {
    await expect(
      invokeByName(
        "update.setChannel",
        { channel: "beta" },
        context(admin, { actor: "mcp", updater: runtime() }),
      ),
    ).rejects.toBeTruthy();
  });
});

describe("preflight and apply", () => {
  it("preflight blocks an update that would break a runtime extension, and says why (AC5)", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at)
       VALUES ('scoring', 'runtime', 'active', '1.0.0', 'c1', '{"contractVersion":1}', ?, ?, ?)`,
    )
      .bind(admin.id, now, now)
      .run();
    try {
      const ctx = context(admin, { updater: runtime() });
      const result = (await invokeByName("update.preflight", { version: "2.0.0" }, ctx)) as {
        ok: boolean;
        blockers: { code: string; message: string }[];
      };
      expect(result.ok).toBe(false);
      expect(result.blockers[0]?.message).toMatch(/Extension "scoring".*contract 1.*contracts 2/);
      await expect(invokeByName("update.apply", { version: "2.0.0" }, ctx)).rejects.toMatchObject({
        code: "conflict",
      });
      expect(calls).not.toContain("apply:2.0.0");
      // Compatible updates pass.
      const ok = (await invokeByName("update.preflight", { version: "1.1.0" }, ctx)) as {
        ok: boolean;
      };
      expect(ok.ok).toBe(true);
    } finally {
      await env.DB.prepare("DELETE FROM core_extensions WHERE id = 'scoring'").run();
    }
  });

  it("applies an update for a human admin, records the run and audits it", async () => {
    const ctx = context(admin, { updater: runtime() });
    const result = await invokeByName("update.apply", { version: "1.1.0" }, ctx);
    expect(result).toMatchObject({ status: "succeeded", from: "1.0.0", to: "1.1.0" });
    const run = await env.DB.prepare("SELECT * FROM core_update_runs").first<RunRecord>();
    expect(run).toMatchObject({
      status: "succeeded",
      surface: "ui",
      started_by: admin.id,
      bookmark: "bm-1",
    });
    const audits = await auditRows("update.apply", admin.id);
    expect(audits.at(-1)).toMatchObject({ outcome: "ok" });
  });

  it("refuses AI and MCP callers and members", async () => {
    for (const actor of ["mcp", "assistant", "automation"] as const) {
      await expect(
        invokeByName(
          "update.apply",
          { version: "1.1.0" },
          context(admin, { actor, updater: runtime() }),
        ),
      ).rejects.toBeTruthy();
    }
    await expect(
      invokeByName("update.apply", { version: "1.1.0" }, context(member, { updater: runtime() })),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(calls.some((c) => c.startsWith("apply:"))).toBe(false);
  });

  it("without a stored token, points at the CLI", async () => {
    const ctx = context(admin, { updater: runtime({ canUpdate: false }) });
    await expect(invokeByName("update.apply", { version: "1.1.0" }, ctx)).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("npx create-crm upgrade --version 1.1.0"),
    });
    const status = await invokeByName("update.status", {}, ctx);
    expect(status).toMatchObject({ canUpdateInApp: false });
  });

  it("rolls back only the latest successful update", async () => {
    const ctx = context(admin, { updater: runtime() });
    const { runId } = (await invokeByName("update.apply", { version: "1.1.0" }, ctx)) as {
      runId: string;
    };
    const status = (await invokeByName("update.status", {}, ctx)) as {
      runs: { id: string; canRollBack: boolean }[];
    };
    expect(status.runs.find((r) => r.id === runId)?.canRollBack).toBe(true);
    await invokeByName("update.rollback", { runId }, ctx);
    expect(calls).toContain("rollback:1.0.0");
    const runs = await env.DB.prepare(
      "SELECT kind, status FROM core_update_runs ORDER BY started_at, kind DESC",
    ).all();
    expect(runs.results).toEqual(
      expect.arrayContaining([
        { kind: "update", status: "rolled_back" },
        { kind: "rollback", status: "succeeded" },
      ]),
    );
    await expect(invokeByName("update.rollback", { runId }, ctx)).rejects.toMatchObject({
      code: "conflict",
    });
  });
});
