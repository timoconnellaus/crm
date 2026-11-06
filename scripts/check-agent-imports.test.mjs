// Proves the agent-* import boundary check works (stage 17 acceptance 13): a planted forbidden
// import fails it, and the real repository passes. Run by `pnpm lint` with `node --test`.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkAgentImports } from "./check-agent-imports.mjs";

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "agent-imports-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const okPackage = JSON.stringify({
  name: "@relationship-os/agent-x",
  license: "MIT",
  dependencies: { zod: "4", ai: "7", "@relationship-os/agent-core": "workspace:*" },
  peerDependencies: { react: "19" },
  devDependencies: { vitest: "5", "@relationship-os/config": "workspace:*" },
});

test("the repository's agent packages pass", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  assert.deepEqual(checkAgentImports(root), []);
});

test("allowed imports pass", () => {
  const root = fixture({
    "packages/agent-x/package.json": okPackage,
    "packages/agent-x/src/index.ts": [
      'import { z } from "zod";',
      'import { streamText } from "ai";',
      'import type { Agent } from "agents";',
      'import { useState } from "react";',
      'export * from "@relationship-os/agent-core";',
      'export { thing } from "./thing.ts";',
    ].join("\n"),
    "packages/agent-x/test/x.test.ts": 'import { it } from "vitest";\nimport "../src/index.ts";',
  });
  try {
    assert.deepEqual(checkAgentImports(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a planted CRM import fails", () => {
  const root = fixture({
    "packages/agent-x/package.json": okPackage,
    "packages/agent-x/src/index.ts": 'import { invokeByName } from "@relationship-os/core";',
  });
  try {
    const problems = checkAgentImports(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /imports "@relationship-os\/core"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dynamic imports, require and relative escapes fail", () => {
  const root = fixture({
    "packages/agent-x/package.json": okPackage,
    "packages/agent-x/src/a.ts": 'const db = await import("@relationship-os/db");',
    "packages/agent-x/src/b.ts": 'const k = require("kysely");',
    "packages/agent-x/src/c.ts": 'import { x } from "../../core/src/index.ts";',
    "packages/agent-x/src/d.ts": 'export { y } from "../../../apps/app/src/server.ts";',
  });
  try {
    const problems = checkAgentImports(root).join("\n");
    assert.match(problems, /@relationship-os\/db/);
    assert.match(problems, /kysely/);
    assert.match(problems, /\.\.\/\.\.\/core\/src\/index\.ts" leaves/);
    assert.match(problems, /apps\/app\/src\/server\.ts" leaves/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a forbidden dependency in package.json fails", () => {
  const root = fixture({
    "packages/agent-x/package.json": JSON.stringify({
      name: "@relationship-os/agent-x",
      license: "MIT",
      dependencies: { "@relationship-os/core": "workspace:*" },
      devDependencies: { "@relationship-os/db": "workspace:*" },
    }),
  });
  try {
    const problems = checkAgentImports(root).join("\n");
    assert.match(problems, /dependencies may not include "@relationship-os\/core"/);
    assert.match(problems, /devDependencies may not include "@relationship-os\/db"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a package that is not MIT fails", () => {
  const root = fixture({
    "packages/agent-x/package.json": JSON.stringify({
      name: "@relationship-os/agent-x",
      license: "FSL-1.1-ALv2",
    }),
  });
  try {
    assert.match(checkAgentImports(root).join("\n"), /license must be "MIT"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
