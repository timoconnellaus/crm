// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixture is extension source text; its template literals run in the sandbox.
// Stage 7b: test mode for a proposed (not yet installed) automation (ADR 0133 amendment). The
// extension is written and proposed (committed, an extension.apply pending action), never
// installed; automation.test with `proposal` runs its automation at the proposed commit.
import { env } from "cloudflare:workers";
import type { ActingUser, AutomationTestReport } from "@relationship-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import { automationHost } from "../src/automations/host.ts";
import { toolWorkerId } from "../src/executor/worker-code.ts";
import { count, setPreset } from "./automation-fixture.ts";
import { call, createAdmin, db, unique } from "./helpers.ts";

let admin: ActingUser;
let extensionId: string;
let actionId: string;
let commit: string;
let personId: string;

const files = (id: string): Record<string, string> => ({
  "index.ts": `import { defineAutomation, defineExtension } from "@relationship-os/sdk";

export default defineExtension({
  id: "${id}",
  version: "1.0.0",
  contractVersion: 1,
  label: "Draft automations",
  permissions: {
    read: ["person", "task"],
    write: ["task"],
    operations: [],
    modules: ["crm", "log"],
  },
  automations: {
    welcome: defineAutomation({
      label: "Welcome task",
      description: "A button on people that makes a welcome task.",
      trigger: { type: "manual", object: "person", label: "Welcome" },
      steps: [{ name: "makeTask", writes: [{ object: "task" }] }],
      async run(event, step, ctx) {
        return step.do("makeTask", () =>
          ctx.crm.call("task.create", {
            title: \`Welcome \${String(event.record?.title ?? "")}\`,
            links: event.record ? [{ object: "person", id: event.record.id }] : [],
          }),
        );
      },
    }),
  },
});
`,
});

beforeAll(async () => {
  admin = await createAdmin();
  await setPreset("balanced");
  extensionId = unique("drf").slice(0, 20);
  await call(admin, "extension.write", { id: extensionId, files: files(extensionId) });
  const proposed = await call<{ status: string; actionId: string; commit: string }>(
    admin,
    "extension.propose",
    { id: extensionId },
  );
  expect(proposed.status).toBe("pending_approval");
  actionId = proposed.actionId;
  commit = proposed.commit;
  const person = await call<{ id: string }>(admin, "person.create", {
    givenName: "Dana",
    familyName: unique("Draft"),
  });
  personId = person.id;
});

describe("automation.test on a proposed automation", () => {
  it("runs the proposed commit in test mode, writes nothing and stores no run", async () => {
    const before = {
      tasks: await count("core_task"),
      pending: await count("core_pending_action"),
      audit: await count("core_audit"),
    };
    const { report } = await call<{ report: AutomationTestReport }>(admin, "automation.test", {
      proposal: { actionId, key: "welcome" },
      record: { object: "person", id: personId },
    });
    expect(report).toMatchObject({
      automationId: `${extensionId}.welcome`,
      ok: true,
      matched: true,
      stored: false,
      draft: { extensionId, commit, key: "welcome" },
    });
    expect(report.steps.map((s) => s.name)).toEqual(["makeTask"]);
    expect(report.writes).toEqual([expect.objectContaining({ object: "task", action: "create" })]);
    expect(report.writes[0]?.title).toMatch(/^Welcome Dana/);
    // It runs as the extension's principal, as the installed automation would.
    expect(report.writes[0]?.for).toBe("Draft automations");
    // Not installed, nothing written (beyond the principal user row install would create), no
    // test run row for an automation page that doesn't exist.
    const installed = await db.query
      .selectFrom("core_extensions")
      .select("id")
      .where("id", "=", extensionId)
      .executeTakeFirst();
    expect(installed).toBeUndefined();
    const runs = await db.query
      .selectFrom("core_automation_runs")
      .select("id")
      .where("extension_id", "=", extensionId)
      .execute();
    expect(runs).toEqual([]);
    expect({
      tasks: await count("core_task"),
      pending: await count("core_pending_action"),
      audit: await count("core_audit"),
    }).toEqual(before);
  });

  it("runs by commit through LOADER.get with the stable tool worker id", async () => {
    const gets: string[] = [];
    let loads = 0;
    const loader = {
      get: (id: string, code: Parameters<WorkerLoader["get"]>[1]) => {
        gets.push(id);
        return env.LOADER.get(id, code);
      },
      load: (code: Parameters<WorkerLoader["load"]>[0]) => {
        loads += 1;
        return env.LOADER.load(code);
      },
    } as WorkerLoader;
    const report = await automationHost(env, { loader }).testAutomation({
      draft: { extensionId, commit, key: "welcome" },
      record: { object: "person", id: personId },
      userId: admin.id,
    });
    expect(report.ok).toBe(true);
    const id = await toolWorkerId({ extensionId, commit, modules: ["crm", "log"] });
    expect(gets).toContain(id);
    expect(loads).toBe(0);
  });

  it("an unknown key is a typed error naming the automations it does declare", async () => {
    await expect(
      call(admin, "automation.test", { proposal: { actionId, key: "nope" } }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringMatching(/no automation "nope" \(its automations: welcome\)/),
      details: { code: "unknown_automation" },
    });
  });

  it("a commit that does not evaluate reports evaluate_failed (automation.test throws on it)", async () => {
    const report = await automationHost(env).testAutomation({
      draft: { extensionId, commit: "0".repeat(40), key: "welcome" },
      userId: admin.id,
    });
    expect(report).toMatchObject({
      ok: false,
      stored: false,
      steps: [],
      error: { code: "evaluate_failed" },
    });
  });

  it("a rejected proposal can no longer be tested", async () => {
    await call(admin, "approval.reject", { actionIds: [actionId] });
    await expect(
      call(admin, "automation.test", { proposal: { actionId, key: "welcome" } }),
    ).rejects.toMatchObject({ code: "invalid_input", details: { status: "rejected" } });
  });
});
