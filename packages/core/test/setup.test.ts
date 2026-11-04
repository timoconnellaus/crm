// The setup wizard's state and sample data (ADR 0167).
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, invokeByName } from "../src/index.ts";
import { context, createUser } from "./helpers.ts";

let admin: ActingUser;
let member: ActingUser;

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
});

describe("setup wizard", () => {
  it("starts pending on a fresh install, is resumable, and closes", async () => {
    const first = await invokeByName("setup.status", {}, context(admin));
    expect(first).toMatchObject({ status: "pending", step: "admin", open: true, sampleRecords: 0 });
    await invokeByName("setup.save", { step: "ai", data: { aiMode: "workers-ai" } }, context(admin));
    const resumed = await invokeByName("setup.status", {}, context(member));
    expect(resumed).toMatchObject({ status: "in_progress", step: "ai", data: { aiMode: "workers-ai" }, open: true });
    await invokeByName("setup.finish", { outcome: "skipped" }, context(admin));
    expect(await invokeByName("setup.status", {}, context(admin))).toMatchObject({ status: "skipped", open: false });
    await invokeByName("setup.restart", {}, context(admin));
    expect(await invokeByName("setup.status", {}, context(admin))).toMatchObject({
      status: "in_progress",
      step: "admin",
      data: { aiMode: "workers-ai" },
    });
    await invokeByName("setup.finish", { outcome: "completed" }, context(admin));
    expect(await invokeByName("setup.status", {}, context(admin))).toMatchObject({ status: "completed" });
  });

  it("only admins change it, and only in the app", async () => {
    await expect(invokeByName("setup.save", { step: "ai" }, context(member))).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      invokeByName("setup.finish", { outcome: "completed" }, context(admin, { actor: "mcp" })),
    ).rejects.toBeTruthy();
  });

  it("stores the organisation profile and Workers AI mode through settings.update", async () => {
    const logo = "data:image/png;base64,iVBORw0KGgo=";
    await invokeByName(
      "settings.update",
      { orgName: "Acme Ltd", logo, timezone: "Europe/London", aiMode: "workers-ai", baseCurrency: "GBP" },
      context(admin),
    );
    expect(await invokeByName("settings.get", {}, context(member))).toEqual({
      orgName: "Acme Ltd",
      logo,
      timezone: "Europe/London",
      aiMode: "workers-ai",
      baseCurrency: "GBP",
    });
    await expect(
      invokeByName("settings.update", { timezone: "Mars/Olympus" }, context(admin)),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("sample data", () => {
  it("installs a small set of records and removes exactly those", async () => {
    const own = (await invokeByName("person.create", { givenName: "Mine" }, context(admin))) as { id: string };
    const installed = await invokeByName("sample.install", {}, context(admin));
    expect(installed).toEqual({ organisations: 3, people: 6, tasks: 3 });
    const count = async (table: string) =>
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE deleted_at IS NULL`).first<{ n: number }>())?.n;
    expect(await count("core_person")).toBe(7);
    expect(await invokeByName("setup.status", {}, context(admin))).toMatchObject({ sampleRecords: 12 });
    await expect(invokeByName("sample.install", {}, context(admin))).rejects.toMatchObject({ code: "conflict" });

    const removed = (await invokeByName("sample.remove", {}, context(admin))) as { removed: number };
    expect(removed.removed).toBe(12);
    expect(await count("core_person")).toBe(1);
    expect(await count("core_organisation")).toBe(0);
    expect(await count("core_task")).toBe(0);
    const mine = await env.DB.prepare("SELECT id FROM core_person WHERE id = ?").bind(own.id).first();
    expect(mine).toBeTruthy();
    expect(await invokeByName("setup.status", {}, context(admin))).toMatchObject({ sampleRecords: 0 });
  });
});
