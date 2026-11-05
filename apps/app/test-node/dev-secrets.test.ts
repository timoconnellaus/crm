// Local dev passes optional secrets from .dev.vars through to ros-app while deploys still require
// BETTER_AUTH_SECRET (dev-secrets.ts, docs/deploying.md "Local development"). Runs in Node against
// wrangler's own loader for local dev variables, the one the Vite plugin calls.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { unstable_getVarsForDev, unstable_readConfig } from "wrangler";
import { devSecrets, devVarNames } from "../dev-secrets.ts";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "ros-dev-secrets-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

writeFileSync(
  join(dir, ".dev.vars"),
  [
    "BETTER_AUTH_SECRET=local-secret-local-secret-local-secret",
    "AI_KEY_DEEPSEEK=sk-deepseek",
    "TYPESAFE_API_KEY=ts-key",
    "GOOGLE_CLIENT_ID=",
    "# AI_KEY_OPENAI=commented out",
  ].join("\n"),
);

/** What local dev hands the Worker for a `secrets` declaration. */
function loaded(secrets: { required?: string[] } | undefined): Record<string, unknown> {
  const vars = unstable_getVarsForDev(
    join(dir, "wrangler.jsonc"),
    undefined,
    {},
    undefined,
    true,
    secrets,
  );
  return Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, v.value]));
}

describe("local dev secrets", () => {
  const committed = unstable_readConfig({ config: join(appDir, "wrangler.jsonc") });

  it("deploys require BETTER_AUTH_SECRET and nothing optional", () => {
    expect(committed.secrets?.required).toEqual(["BETTER_AUTH_SECRET"]);
  });

  it("wrangler alone drops undeclared secrets from .dev.vars", () => {
    // Why dev-secrets.ts exists. If wrangler starts passing them through, it can go.
    const vars = loaded(committed.secrets);
    expect(vars.BETTER_AUTH_SECRET).toBeDefined();
    expect(vars.AI_KEY_DEEPSEEK).toBeUndefined();
  });

  it("the dev declaration passes every name .dev.vars sets", () => {
    expect(devVarNames(dir).sort()).toEqual([
      "AI_KEY_DEEPSEEK",
      "BETTER_AUTH_SECRET",
      "GOOGLE_CLIENT_ID",
      "TYPESAFE_API_KEY",
    ]);
    const vars = loaded(devSecrets(committed.secrets, dir));
    expect(vars).toMatchObject({
      BETTER_AUTH_SECRET: "local-secret-local-secret-local-secret",
      AI_KEY_DEEPSEEK: "sk-deepseek",
      TYPESAFE_API_KEY: "ts-key",
      GOOGLE_CLIENT_ID: "",
    });
    expect(vars.AI_KEY_OPENAI).toBeUndefined();
  });

  it("keeps the required names without a .dev.vars, and leaves no declaration alone", () => {
    const empty = mkdtempSync(join(tmpdir(), "ros-dev-secrets-empty-"));
    try {
      expect(devSecrets(committed.secrets, empty)).toEqual({ required: ["BETTER_AUTH_SECRET"] });
      expect(devSecrets(undefined, dir)).toBeUndefined();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
