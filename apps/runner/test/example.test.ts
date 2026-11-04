// AC5: the shipped example extension is bundled, installed through extension.install at boot,
// runs in the sandbox, and its schema, formula and tools work end to end.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { installShippedExtensions } from "@crm/core";
import { beforeAll, describe, expect, it } from "vitest";
import type { ExtensionWorkspace } from "../src/extensions/workspace.ts";
import { extensionWorkspace } from "../src/index.ts";
import { auditFor, call, createAdmin, db, extensionRow, host, unique } from "./helpers.ts";

let admin: Awaited<ReturnType<typeof createAdmin>>;
let orgId: string;

beforeAll(async () => {
  admin = await createAdmin();
  const results = await installShippedExtensions({ db, host });
  expect(results).toEqual([{ id: "example", outcome: "installed" }]);
  const org = await call<{ id: string }>(admin, "organisation.create", { name: unique("Acme") });
  orgId = org.id;
});

describe("shipped example extension", () => {
  it("is bundled and installed as a shipped extension, as its own principal", async () => {
    expect(await host.shipped()).toEqual([{ id: "example", version: "1.0.0" }]);
    const row = await extensionRow("example");
    expect(row).toMatchObject({
      source: "shipped",
      status: "active",
      version: "1.0.0",
      user_id: "extension:example",
    });
    const versions = await host.versions("example");
    expect(versions[0]?.commit).toBe(row.commit_oid);
    // The install itself was audited, as a system call.
    const install = await env.DB.prepare(
      "SELECT outcome, risk FROM core_audit WHERE operation = 'extension.install' AND user_id = 'system'",
    ).first<{ outcome: string; risk: string }>();
    expect(install).toEqual({ outcome: "ok", risk: "extension" });
  });

  it("installing again at boot changes nothing", async () => {
    expect(await installShippedExtensions({ db, host })).toEqual([
      { id: "example", outcome: "unchanged" },
    ]);
  });

  it("re-committing unchanged shipped source skips the workspace once it is recorded", async () => {
    const { commit } = await host.commitShipped("example");
    const stub = extensionWorkspace(env);
    await runInDurableObject(stub, async (instance: ExtensionWorkspace, state) => {
      const known = await state.storage.get<{ hash: string; commit: string }>("shipped:example");
      expect(known?.commit).toBe(commit);
      // Proof it short-circuits: a stale hash would force a rewrite, a matching one must not.
      const writes: string[] = [];
      const original = instance.workspace.fs.writeFile.bind(instance.workspace.fs);
      instance.workspace.fs.writeFile = (async (path: string, ...rest: unknown[]) => {
        writes.push(path);
        // biome-ignore lint/suspicious/noExplicitAny: forwarding to the original signature
        return (original as any)(path, ...rest);
      }) as typeof instance.workspace.fs.writeFile;
      try {
        expect(await instance.commitShipped("example")).toEqual({ commit, changed: false });
        expect(writes).toEqual([]);
      } finally {
        instance.workspace.fs.writeFile = original;
      }
    });
  });

  it("creates projects with a computed formula and lists them by it", async () => {
    const project = await call<{ id: string; values: Record<string, unknown> }>(
      admin,
      "record.create",
      {
        object: "example.project",
        values: {
          name: "Website",
          organisation: orgId,
          budget: 5000,
          spent: 1200,
          status: "active",
        },
      },
    );
    expect(project.values).toMatchObject({ remaining: 3800, organisation: orgId });
    await call(admin, "record.create", {
      object: "example.project",
      values: { name: "Audit", organisation: orgId, budget: 1000, spent: 1500 },
    });
    const overBudget = await call<{ items: { title: string }[] }>(admin, "record.list", {
      object: "example.project",
      filter: { field: "remaining", op: "lt", value: 0 },
    });
    expect(overBudget.items.map((i) => i.title)).toEqual(["Audit"]);
    // A relation must point at a live record.
    await expect(
      call(admin, "record.create", {
        object: "example.project",
        values: { name: "Ghost", organisation: "org_missing" },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("adds a tier and a formula to organisations", async () => {
    const before = await call<{ values: Record<string, unknown> }>(admin, "record.get", {
      object: "organisation",
      id: orgId,
    });
    expect(before.values["example.tierLabel"]).toMatch(/\(untiered\)$/);
  });

  it("runs its tools in the sandbox as extension:example, through the gate", async () => {
    const set = await call(admin, "x.example.setTier", { organisationId: orgId, tier: "gold" });
    expect(set).toEqual({ organisationId: orgId, tier: "gold" });
    const summary = await call(admin, "x.example.summariseOrganisation", { organisationId: orgId });
    expect(summary).toEqual({
      organisationId: orgId,
      tier: "gold",
      projects: 2,
      totalBudget: 6000,
      totalRemaining: 3300,
    });
    // The nested write was audited as actor `extension`, as the extension's principal.
    const audits = await auditFor("record.update", "extension:example");
    expect(audits.at(-1)).toMatchObject({ actor: "extension", outcome: "ok" });
    expect(JSON.parse(audits.at(-1)?.origin ?? "{}")).toEqual({
      surface: "extension",
      extensionId: "example",
    });
    // The tool call itself was audited for the human who made it.
    const outer = await auditFor("x.example.setTier", admin.id);
    expect(outer.at(-1)).toMatchObject({ actor: "human", outcome: "ok" });
    // The tier change is timeline-tracked.
    const timeline = await env.DB.prepare(
      "SELECT a.subject FROM core_activity a JOIN core_activity_links l ON l.activity_id = a.id WHERE l.record_id = ? AND a.type = 'system'",
    )
      .bind(orgId)
      .all<{ subject: string }>();
    expect(timeline.results.map((r) => r.subject)).toContain("Tier changed");
  });

  it("records run history with logs and the operations called", async () => {
    const detail = await call<{
      runs: {
        kind: string;
        name: string | null;
        outcome: string;
        logs: { message: string }[];
        operations: { operation: string }[];
      }[];
      lastGoodCommit: string | null;
      commit: string;
    }>(admin, "extension.get", { id: "example" });
    const run = detail.runs.find((r) => r.name === "summariseOrganisation");
    expect(run).toMatchObject({ kind: "tool", outcome: "ok" });
    expect(run?.logs.map((l) => l.message)).toEqual(["summarised organisation"]);
    expect(run?.operations.map((o) => o.operation)).toEqual(["record.get", "record.list"]);
    expect(detail.lastGoodCommit).toBe(detail.commit);
    const stored = await env.DB.prepare(
      "SELECT value FROM core_extension_kv WHERE extension_id = 'example' AND key = ?",
    )
      .bind(`summary:${orgId}`)
      .first<{ value: string }>();
    expect(JSON.parse(stored?.value ?? "null")).toMatchObject({ projects: 2 });
  });

  it("lists its tools as operations and its objects in the registry", async () => {
    const { objects } = await call<{ objects: { name: string }[] }>(admin, "schema.objects", {});
    expect(objects.map((o) => o.name)).toContain("example.project");
    const { items } = await call<{ items: { id: string; tools: string[] }[] }>(
      admin,
      "extension.list",
      {},
    );
    expect(items.find((i) => i.id === "example")?.tools).toEqual([
      "x.example.summariseOrganisation",
      "x.example.setTier",
    ]);
  });
});
