// Bundle budget for crm-runner (ADR 0043): the main module must stay small and must not carry the
// TypeScript compiler, which lives in the checker's Dynamic Worker (a Text module, never parsed by
// crm-runner itself). Builds with `wrangler deploy --dry-run` into a temporary directory.
//
// Before ADR 0043 the main module was 10,348 KiB (the compiler, its declarations and the SDK
// bundle all inside it).
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAIN_BUDGET_KIB = 4_096;

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const out = await mkdtemp(join(tmpdir(), "crm-runner-bundle-"));
try {
  execFileSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", out], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const main = join(out, "index.js");
  const kib = (await stat(main)).size / 1024;
  const code = await readFile(main, "utf8");
  const files = await readdir(out);
  const failures = [];
  if (kib > MAIN_BUDGET_KIB) {
    failures.push(`main module is ${kib.toFixed(0)} KiB, over the ${MAIN_BUDGET_KIB} KiB budget`);
  }
  // Markers of the compiler's own code (not of the checker's id or comments).
  for (const marker of ["createProgram", "getSemanticDiagnostics", "createSourceFile("]) {
    if (code.includes(marker))
      failures.push(`main module contains the TypeScript compiler (${marker})`);
  }
  if (!files.some((f) => f.endsWith("checker.txt"))) failures.push("no checker.txt Text module");
  if (!files.some((f) => f.endsWith("sdk-bundle.txt")))
    failures.push("no sdk-bundle.txt Text module");
  if (failures.length) {
    console.error(`bundle budget failed:\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
  console.log(
    `bundle budget ok: main module ${kib.toFixed(0)} KiB (budget ${MAIN_BUDGET_KIB} KiB), compiler only in the checker worker's Text module`,
  );
} finally {
  await rm(out, { recursive: true, force: true });
}
