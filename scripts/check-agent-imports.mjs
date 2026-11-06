#!/usr/bin/env node
// The import boundary of the assistant packages (ADR 0350, stage 17 acceptance 13).
//
// `packages/agent-*` are MIT licensed and reusable outside the CRM, so they may depend only on each
// other, `zod`, `ai`, `agents` and React (as a peer). This check, run by `pnpm lint`, fails when:
// - a package.json lists any other runtime or peer dependency (dev dependencies may hold test
//   tooling, but never another @relationship-os package except the shared config);
// - a source file imports anything else (static, dynamic, `export … from` and `require`);
// - a relative import leaves the package directory, or any import points into packages/core or
//   apps/.
// Biome's `noRestrictedImports` (biome.json) catches the common case in the editor; this is the
// complete check.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ALLOWED = [
  /^@relationship-os\/agent-[a-z0-9-]+(\/.*)?$/,
  /^zod(\/.*)?$/,
  /^ai(\/.*)?$/,
  /^agents(\/.*)?$/,
  /^react(-dom)?(\/.*)?$/,
];
/** Test files may also use test tooling the package declares as a dev dependency. */
const TEST_FILE = /(^|\/)(test|__tests__)\/|\.test\.tsx?$/;
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", ".wrangler", ".turbo"]);

const SPECIFIERS = [
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

function allowedRuntime(specifier) {
  return ALLOWED.some((re) => re.test(specifier));
}

function* files(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (SOURCE.test(name)) yield path;
  }
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Problems with the agent packages under `root`, as "path: message" strings. */
export function checkAgentImports(root) {
  const problems = [];
  const packagesDir = join(root, "packages");
  let names = [];
  try {
    names = readdirSync(packagesDir).filter((n) => n.startsWith("agent-"));
  } catch {
    return problems;
  }
  for (const name of names) {
    const dir = join(packagesDir, name);
    if (!statSync(dir).isDirectory()) continue;
    const pkgPath = join(dir, "package.json");
    let pkg = {};
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      problems.push(`${relative(root, pkgPath)}: missing or unreadable`);
      continue;
    }
    if (pkg.license !== "MIT") problems.push(`${relative(root, pkgPath)}: license must be "MIT"`);
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const dep of Object.keys(pkg[field] ?? {})) {
        if (!allowedRuntime(dep)) {
          problems.push(`${relative(root, pkgPath)}: ${field} may not include "${dep}" (ADR 0350)`);
        }
      }
    }
    const devDeps = Object.keys(pkg.devDependencies ?? {});
    for (const dep of devDeps) {
      if (
        dep.startsWith("@relationship-os/") &&
        !allowedRuntime(dep) &&
        dep !== "@relationship-os/config"
      ) {
        problems.push(
          `${relative(root, pkgPath)}: devDependencies may not include "${dep}" (ADR 0350)`,
        );
      }
    }
    for (const file of files(dir)) {
      const rel = relative(root, file);
      const inTests =
        TEST_FILE.test(relative(dir, file).split(sep).join("/")) || /vitest\.config\./.test(file);
      const text = stripComments(readFileSync(file, "utf8"));
      for (const re of SPECIFIERS) {
        re.lastIndex = 0;
        for (const match of text.matchAll(re)) {
          const specifier = match[1];
          if (!specifier) continue;
          if (specifier.startsWith(".") || specifier.startsWith("/")) {
            const target = resolve(dirname(file), specifier);
            const inside = target === dir || target.startsWith(dir + sep);
            if (!inside)
              problems.push(`${rel}: "${specifier}" leaves ${relative(root, dir)} (ADR 0350)`);
            continue;
          }
          if (/(^|\/)(packages\/core|apps)\//.test(specifier)) {
            problems.push(`${rel}: "${specifier}" points into CRM code (ADR 0350)`);
            continue;
          }
          if (allowedRuntime(specifier)) continue;
          const pkgOf = packageName(specifier);
          if (
            inTests &&
            (pkgOf === "vitest" ||
              (devDeps.includes(pkgOf) && !pkgOf.startsWith("@relationship-os/")) ||
              pkgOf === "@relationship-os/config")
          ) {
            continue;
          }
          problems.push(
            `${rel}: imports "${specifier}", which agent-* packages may not use (ADR 0350)`,
          );
        }
      }
    }
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const problems = checkAgentImports(root);
  if (problems.length) {
    console.error("Assistant package import boundary (ADR 0350):");
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log("agent-* import boundary: ok");
}
