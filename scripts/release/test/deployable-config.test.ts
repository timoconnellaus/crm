// What a first deploy needs from the real wrangler configs, which no test account has ever proved
// (docs/first-deploy.md): Durable Object migrations a new account can apply, and no local stand-in
// switched on in anything that ships.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type DeployablePackage, readDeployablePackages } from "../manifest-lib.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const packages = readDeployablePackages(ROOT);
const worker = (dir: string) => packages.find((p) => p.dir === dir) as DeployablePackage;
const app = worker("apps/app");
const runner = worker("apps/runner");

describe.each([
  ["ros-app", app, "apps/app/src/server.ts"],
  ["ros-runner", runner, "apps/runner/src/index.ts"],
])("%s Durable Object migrations", (_name, pkg, entry) => {
  const migrations: Record<string, string[] | undefined>[] = pkg.config.migrations;

  it("only create classes, so they apply to an account that never had the old ones", () => {
    for (const migration of migrations) {
      expect(Object.keys(migration).sort()).toEqual(["new_sqlite_classes", "tag"]);
    }
  });

  it("create only classes the Worker exports, and every class it binds", () => {
    const source = readFileSync(join(ROOT, entry), "utf8");
    const created = migrations.flatMap((m) => m.new_sqlite_classes ?? []);
    for (const name of created) expect(source).toMatch(new RegExp(`\\b${name}\\b`));
    for (const binding of pkg.config.durable_objects.bindings) {
      expect(created).toContain(binding.class_name);
    }
  });
});

describe("production config", () => {
  it("keeps local stand-ins off and sign-up to the first user", () => {
    expect(app.config.vars.AUTH_ALLOW_SIGNUP).toBe("false");
    expect(app.config.vars.AI_FAKE_MODEL).toBe("");
    expect(app.config.vars.AI_FAKE_VOICE ?? "").toBe("");
    expect(runner.config.vars.INTEGRATIONS_FAKE_PROVIDER).toBe("false");
  });

  it("does not bind ros-runner to itself, a target that does not exist on a first deploy", () => {
    expect(runner.config.services ?? []).toEqual([]);
  });
});
