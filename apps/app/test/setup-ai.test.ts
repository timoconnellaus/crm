// The setup wizard's AI step (ADR 0167, amended 2026-11-06): it states what the deployment's
// model roles really resolve to, from ai.settings, on the shipped defaults and on the
// `deepseek-flash` preset set through AI_MODEL_ROLES, with readiness problems in plain words.
import { env } from "cloudflare:workers";
import type { Principal } from "@relationship-os/auth";
import type { CoreOutput } from "@relationship-os/core";
import { modelRolesVar } from "@relationship-os/core/ai-roles";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AiSetupSummaryView, describeAiSetup } from "../src/components/setup/ai-summary.tsx";
import { runOperation } from "../src/server/operations.ts";

const admin: Principal = {
  userId: "usr_01JC00000000000000000000S1",
  email: "setup-ai-admin@example.com",
  name: "Setup AI Admin",
  roles: [],
};

async function ensureAdmin() {
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO core_user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
  )
    .bind(admin.userId, admin.name, admin.email, now, now)
    .run();
  await env.DB.prepare("UPDATE core_user SET role = 'admin' WHERE id = ?").bind(admin.userId).run();
}

async function aiSettings(e: typeof env): Promise<CoreOutput<"ai.settings">> {
  await ensureAdmin();
  const result = await runOperation(e, admin, { name: "ai.settings", input: {} });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.data as CoreOutput<"ai.settings">;
}

const html = (settings: CoreOutput<"ai.settings">) =>
  renderToStaticMarkup(createElement(AiSetupSummaryView, { settings }));

// The local stand-ins make Workers AI ready without a binding.
const shipped = { ...env, AI_FAKE_MODEL: "true", AI_MODEL_ROLES: "" };
const deepseek = { ...shipped, AI_MODEL_ROLES: modelRolesVar("deepseek-flash") };

describe("the setup wizard's AI step", () => {
  it("states the shipped defaults: Workers AI on every role, ready", async () => {
    const summary = describeAiSetup(await aiSettings(shipped));
    expect(summary.sentences).toEqual([
      "This deployment is set up for Workers AI in your Cloudflare account on every role, from the shipped defaults.",
    ]);
    expect(summary.problems).toEqual([]);
    expect(html(await aiSettings(shipped))).toContain("Every role is ready.");
  });

  it("states the deepseek-flash preset from AI_MODEL_ROLES, and the missing key", async () => {
    const settings = await aiSettings(deepseek);
    const summary = describeAiSetup(settings);
    expect(summary.sentences).toEqual([
      "This deployment is set up for DeepSeek V4.1 Flash on every role except search, from its deploy configuration.",
      "The search role uses Workers AI in your Cloudflare account, from the shipped defaults.",
    ]);
    expect(summary.problems).toEqual([
      {
        provider: "deepseek",
        label: "DeepSeek",
        reason: expect.stringMatching(/^No key/),
        roles: ["build", "assistant", "summarise", "extract", "classify", "vision", "review"],
      },
    ]);
    const markup = html(settings);
    expect(markup).toContain("DeepSeek V4.1 Flash on every role except search");
    expect(markup).toContain("DeepSeek: No key");
    expect(markup).not.toContain("Every role is ready.");
  });

  it("is ready once the DeepSeek key is set", async () => {
    // An optional secret: not in the generated Env (docs/deploying.md "Local development").
    const withKey = { ...deepseek, AI_KEY_DEEPSEEK: "sk-test" } as typeof env;
    const summary = describeAiSetup(await aiSettings(withKey));
    expect(summary.problems).toEqual([]);
  });

  it("says plainly when AI is not configured at all", async () => {
    const settings = await aiSettings({ ...env, AI_FAKE_MODEL: "", AI_MODEL_ROLES: "" });
    expect(settings.configured).toBe(false);
    expect(describeAiSetup(settings).problems[0]).toMatchObject({ provider: "workers-ai" });
    expect(html(settings)).toContain("AI is not configured for this deployment yet");
  });
});
