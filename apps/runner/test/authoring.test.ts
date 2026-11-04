// Stage 3b authoring over the approval queue (ADR 0041): the working copy, check, propose (one
// pending action with the diff and host-computed impact), approve/reject through the approval
// queue, widening permissions as a review (AC3), shipped extensions extended but not modified,
// and eject.
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  installShippedExtensions,
  invokeByName,
  newId,
  PERMISSIONS,
} from "@crm/core";
import { beforeAll, describe, expect, it } from "vitest";
import { call, context, createAdmin, db, extensionRow, host, source, unique } from "./helpers.ts";

let admin: ActingUser;

async function setPreset(preset: "cautious" | "balanced" | "autonomous") {
  await env.DB.prepare("UPDATE core_settings SET value = ? WHERE key = 'approval_policy'")
    .bind(JSON.stringify({ preset }))
    .run();
}

async function createMember(): Promise<ActingUser> {
  const id = newId("user");
  const email = `${unique("member")}@example.com`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at, role) VALUES (?, 'Member', ?, 1, ?, ?, 'member')",
  )
    .bind(id, email, now, now)
    .run();
  return { id, email, name: "Member", role: "member" };
}

/** An MCP session for `user` (connected app `sessionId`). */
function mcp<T = unknown>(user: ActingUser, sessionId: string, name: string, input: unknown) {
  return invokeByName(
    name,
    input,
    context(user, {
      actor: "mcp",
      origin: { surface: "mcp", clientId: "test", clientName: "Test client", sessionId },
      grantedPermissions: PERMISSIONS,
      reason: "Testing extension authoring",
    }),
  ) as Promise<T>;
}

interface Proposed {
  status: string;
  actionId: string;
  changeSetId: string;
  commit: string;
  impact: {
    kind: string;
    risks: string[];
    schema: { newObjects: string[]; newFields: string[] };
    permissions: { widens: boolean; widened: { write: string[]; operations: string[] } };
    modules: string[];
    tools: { name: string; change: string }[];
  };
  check: { ok: boolean };
  aiSummary: string | null;
  issues?: { stage: string; code: string; message: string }[];
}

const projects = (id: string, version = "1.0.0", more = "") =>
  source(
    id,
    `label: "Projects",
  permissions: { read: ["organisation"], modules: ["crm", "log"] },
  objects: {
    project: {
      label: "Project", plural: "Projects", icon: "folder-kanban", titleField: "name",
      fields: {
        name: { type: "text", label: "Name", required: true },
        organisation: { type: "relation", label: "Organisation", to: "organisation" },
        budget: { type: "currency", label: "Budget", currency: "EUR" },${more}
      },
    },
  },`,
    version,
  );

beforeAll(async () => {
  admin = await createAdmin();
  await setPreset("balanced");
  await installShippedExtensions({ db, host });
});

describe("the working copy", () => {
  it("writes, reads and checks files without committing or installing", async () => {
    const id = unique("wc").slice(0, 20);
    // extension.write returns paths, not contents, and a dirty flag rather than git status.
    const written = await call<{
      paths: string[];
      written: string[];
      deleted: string[];
      changed: boolean;
      head: null;
    }>(admin, "extension.write", { id, files: projects(id) });
    expect(written).toMatchObject({
      paths: ["index.ts"],
      written: ["index.ts"],
      deleted: [],
      changed: true,
      head: null,
    });

    // Add a helper, delete it again, and read one file back.
    await call(admin, "extension.write", { id, files: { "lib/util.ts": "export const x = 1;\n" } });
    let read = await call<{ files: Record<string, string> }>(admin, "extension.read", { id });
    expect(Object.keys(read.files).sort()).toEqual(["index.ts", "lib/util.ts"]);
    await call(admin, "extension.write", { id, files: { "lib/util.ts": null } });
    read = await call(admin, "extension.read", { id, path: "index.ts" });
    expect(Object.keys(read.files)).toEqual(["index.ts"]);
    expect(read.files["index.ts"]).toContain("defineExtension");
    const whole = await call<{ changed: string[] }>(admin, "extension.read", { id });
    expect(whole.changed).toEqual(["index.ts"]);

    const check = await call<{ ok: boolean; plan: { changes: { kind: string }[] } }>(
      admin,
      "extension.check",
      { id },
    );
    expect(check.ok).toBe(true);
    expect(check.plan.changes.map((c) => c.kind)).toContain("create_object");
    expect(await host.versions(id)).toEqual([]);
    expect(
      await db.query.selectFrom("core_extensions").select("id").where("id", "=", id).execute(),
    ).toEqual([]);

    const listed = await call<{
      workspace: { id: string; changed: boolean; installed: boolean }[];
    }>(admin, "extension.list", {});
    expect(listed.workspace.find((w) => w.id === id)).toMatchObject({
      changed: true,
      installed: false,
    });
  });

  it("reports type and contract errors from check, with the stage", async () => {
    const id = unique("bad").slice(0, 20);
    await call(admin, "extension.write", {
      id,
      files: source(
        id,
        `objects: { thing: { label: "Thing", plural: "Things", titleField: "nope", fields: { name: { type: "text", label: "Name" } } } },`,
      ),
    });
    const check = await call<{ ok: boolean; issues: { stage: string; path: string }[] }>(
      admin,
      "extension.check",
      { id },
    );
    expect(check.ok).toBe(false);
    expect(check.issues).toContainEqual(
      expect.objectContaining({ stage: "contract", path: "objects.thing.titleField" }),
    );
  });

  it("rejects paths outside the extension", async () => {
    await expect(
      call(admin, "extension.write", { id: "pathy", files: { "../escape.ts": "x" } }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("propose, approve and reject", () => {
  it("proposes one pending action with the diff and impact, and approval installs it", async () => {
    const id = unique("prj").slice(0, 20);
    const session = `cap_${unique()}`;
    await mcp(admin, session, "extension.write", { id, files: projects(id) });
    const proposed = await mcp<Proposed>(admin, session, "extension.propose", {
      id,
      message: "Add projects",
    });
    expect(proposed.status).toBe("pending_approval");
    expect(proposed.impact).toMatchObject({
      kind: "install",
      risks: ["extension", "schema"],
      schema: { newObjects: [`${id}.project`] },
      modules: ["crm", "log"],
    });
    expect(proposed.check.ok).toBe(true);
    // No AI binding in tests: no summary, and the screen says so.
    expect(proposed.aiSummary).toBeNull();

    const action = await env.DB.prepare(
      "SELECT operation, risk, actor, status, change_set_id FROM core_pending_action WHERE id = ?",
    )
      .bind(proposed.actionId)
      .first();
    expect(action).toEqual({
      operation: "extension.apply",
      risk: "extension",
      actor: "mcp",
      status: "pending",
      change_set_id: proposed.changeSetId,
    });
    const set = await env.DB.prepare("SELECT session_id FROM core_change_set WHERE id = ?")
      .bind(proposed.changeSetId)
      .first<{ session_id: string }>();
    expect(set?.session_id).toBe(session);

    const detail = await call<{
      diff: { path: string; status: string; additions: number }[];
      check: { ok: boolean };
      aiSummary: null;
    }>(admin, "extension.proposal", { actionId: proposed.actionId });
    expect(detail.diff).toEqual([
      expect.objectContaining({ path: "index.ts", status: "added", additions: 19 }),
    ]);
    expect(detail.check.ok).toBe(true);
    expect(detail.aiSummary).toBeNull();
    // Nothing installed yet.
    expect(
      await db.query.selectFrom("core_extensions").select("id").where("id", "=", id).execute(),
    ).toEqual([]);

    const approved = await call<{ status: string }>(admin, "extension.approve", {
      actionId: proposed.actionId,
    });
    expect(approved.status).toBe("applied");
    const row = await extensionRow(id);
    expect(row).toMatchObject({ source: "runtime", status: "active", commit_oid: proposed.commit });
    // The approval, the install and the audit row committed together.
    const audit = await env.DB.prepare(
      "SELECT actor, gate_decision, outcome FROM core_audit WHERE operation = 'extension.apply' AND pending_action_id = ? AND outcome = 'ok'",
    )
      .bind(proposed.actionId)
      .first();
    expect(audit).toEqual({ actor: "mcp", gate_decision: "review", outcome: "ok" });
    const created = await call<{ id: string }>(admin, "record.create", {
      object: `${id}.project`,
      values: { name: "Alpha", budget: 1000 },
    });
    expect(created.id).toBeTruthy();
  });

  it("returns check_failed and queues nothing when the check fails", async () => {
    const id = unique("cf").slice(0, 20);
    const session = `cap_${unique()}`;
    await mcp(admin, session, "extension.write", {
      id,
      files: source(id, `permissions: { read: ["nonsense"], modules: ["crm"] },`),
    });
    const proposed = await mcp<Proposed>(admin, session, "extension.propose", { id });
    expect(proposed.status).toBe("check_failed");
    expect(proposed.issues?.[0]).toMatchObject({ stage: "contract" });
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_pending_action WHERE input LIKE ?",
    )
      .bind(`%"id":"${id}"%`)
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("a rejected proposal installs nothing; a member cannot approve one", async () => {
    const id = unique("rej").slice(0, 20);
    const session = `cap_${unique()}`;
    await mcp(admin, session, "extension.write", { id, files: projects(id) });
    const proposed = await mcp<Proposed>(admin, session, "extension.propose", { id });
    const member = await createMember();
    await expect(
      call(member, "approval.approve", { actionIds: [proposed.actionId] }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      mcp(admin, session, "extension.approve", { actionId: proposed.actionId }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const rejected = await call<{ status: string }>(admin, "extension.reject", {
      actionId: proposed.actionId,
      note: "Not now",
    });
    expect(rejected.status).toBe("rejected");
    expect(
      await db.query.selectFrom("core_extensions").select("id").where("id", "=", id).execute(),
    ).toEqual([]);
  });

  it("fails cleanly when the installed version changed after the proposal", async () => {
    const id = unique("cnf").slice(0, 20);
    const session = `cap_${unique()}`;
    await call(admin, "extension.install", { id, files: projects(id) });
    await mcp(admin, session, "extension.write", {
      id,
      files: projects(id, "1.1.0", `\n        notes: { type: "longText", label: "Notes" },`),
    });
    const proposed = await mcp<Proposed>(admin, session, "extension.propose", { id });
    // Someone installs another version meanwhile.
    await call(admin, "extension.install", {
      id,
      files: projects(id, "1.0.1", `\n        code: { type: "text", label: "Code" },`),
    });
    const result = await call<{ status: string; statusReason: string }>(
      admin,
      "extension.approve",
      { actionId: proposed.actionId },
    );
    expect(result.status).toBe("failed");
    expect(result.statusReason).toMatch(/changed after this was proposed/);
    expect((await extensionRow(id)).version).toBe("1.0.1");
  });
});

describe("widening permissions is a reviewable change (AC3)", () => {
  it("shows the widening, and never auto-applies even for a person on Autonomous", async () => {
    const id = unique("wid").slice(0, 20);
    await call(admin, "extension.install", { id, files: projects(id) });
    await setPreset("autonomous");
    try {
      await call(admin, "extension.write", {
        id,
        files: source(
          id,
          `label: "Projects",
  permissions: { read: ["organisation"], write: ["person"], operations: ["task.create"], modules: ["crm", "log"] },
  objects: {
    project: {
      label: "Project", plural: "Projects", icon: "folder-kanban", titleField: "name",
      fields: {
        name: { type: "text", label: "Name", required: true },
        organisation: { type: "relation", label: "Organisation", to: "organisation" },
        budget: { type: "currency", label: "Budget", currency: "EUR" },
      },
    },
  },`,
          "1.1.0",
        ),
      });
      // A human proposing still gets a pending action, not an install.
      const proposed = await call<Proposed>(admin, "extension.propose", { id });
      expect(proposed.status).toBe("pending_approval");
      expect(proposed.impact.permissions.widens).toBe(true);
      expect(proposed.impact.permissions.widened.write).toEqual(["person"]);
      expect(proposed.impact.permissions.widened.operations).toEqual(["task.create"]);
      expect(proposed.impact.risks).toEqual(["extension"]);
      expect((await extensionRow(id)).version).toBe("1.0.0");
      // extension.apply cannot be called around the queue either.
      await expect(
        call(admin, "extension.apply", {
          id,
          commit: proposed.commit,
          version: "1.1.0",
          baseCommit: (await extensionRow(id)).commit_oid,
        }),
      ).rejects.toMatchObject({ code: "pending_approval" });
      await call(admin, "extension.approve", { actionId: proposed.actionId });
      const row = await extensionRow(id);
      expect(row.version).toBe("1.1.0");
      expect(JSON.parse(row.manifest).permissions.write).toEqual(["person"]);
    } finally {
      await setPreset("balanced");
    }
  });
});

describe("shipped extensions: extend, don't modify; eject", () => {
  it("refuses to write a shipped extension in place, and check says why", async () => {
    await expect(
      call(admin, "extension.write", { id: "deals", files: { "index.ts": "// edit" } }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const check = await call<{ ok: boolean; issues: { code: string }[] }>(
      admin,
      "extension.check",
      { id: "deals" },
    );
    expect(check.ok).toBe(false);
    expect(check.issues[0]?.code).toBe("shipped");
  });

  it("lets a runtime extension extend a shipped object with fields and a view", async () => {
    const id = unique("ext").slice(0, 20);
    await call(admin, "extension.write", {
      id,
      files: source(
        id,
        `fields: { "deals.pipeline": { risk: { type: "select", label: "Risk", options: ["low", "high"] } } },
  views: { risky: { label: "Risky pipelines", object: "deals.pipeline", filter: { field: "${id}.risk", op: "eq", value: "high" } } },`,
      ),
    });
    const check = await call<{ ok: boolean; issues: unknown[] }>(admin, "extension.check", { id });
    expect(check.issues).toEqual([]);
    const proposed = await call<Proposed>(admin, "extension.propose", { id });
    await call(admin, "extension.approve", { actionId: proposed.actionId });
    const project = await call<{ id: string }>(admin, "record.create", {
      object: "deals.pipeline",
      values: { name: "Bridge", [`${id}.risk`]: "high" },
    });
    const got = await call<{ values: Record<string, unknown> }>(admin, "record.get", {
      object: "deals.pipeline",
      id: project.id,
    });
    expect(got.values[`${id}.risk`]).toBe("high");
  });

  it("ejects: the working copy becomes editable, approval makes it a runtime extension", async () => {
    const ejected = await call<{
      paths: string[];
      ejected: boolean;
      changed: boolean;
      warning: string;
    }>(admin, "extension.eject", { id: "deals" });
    expect(ejected).toMatchObject({ ejected: true, changed: true });
    expect(ejected.paths).toContain("index.ts");
    expect(ejected.warning).toMatch(/upstream updates/);
    const read = await call<{ files: Record<string, string> }>(admin, "extension.read", {
      id: "deals",
      path: "index.ts",
    });
    const index = read.files["index.ts"] as string;
    await call(admin, "extension.write", {
      id: "deals",
      files: { "index.ts": index.replace('version: "1.0.0"', 'version: "1.1.0"') },
    });
    const proposed = await call<Proposed>(admin, "extension.propose", { id: "deals" });
    expect(proposed.status).toBe("pending_approval");
    expect(proposed.impact.kind).toBe("eject");
    await call(admin, "extension.approve", { actionId: proposed.actionId });
    expect(await extensionRow("deals")).toMatchObject({ source: "runtime", version: "1.1.0" });
    // New releases leave it alone.
    expect(await installShippedExtensions({ db, host })).toEqual([
      { id: "deals", outcome: "ejected" },
    ]);
  });
});
