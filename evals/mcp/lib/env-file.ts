// Loads eval model credentials from a gitignored `.env.evals` in the main checkout, so every
// worktree shares one copy. Variables already in the environment win; the file only fills gaps.
//
// Lookup: $EVAL_ENV_FILE if set, else `<main checkout>/.env.evals`, where the main checkout is
// the parent of git's common dir (the same for every worktree of the repo).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Parses KEY=VALUE lines; blank lines and `#` comments are skipped, surrounding quotes dropped. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match as unknown as [string, string, string];
    out[key] = rawValue.replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

/** Where `.env.evals` lives for the checkout containing `cwd`, or undefined outside a git repo. */
export function evalEnvFilePath(
  cwd: string,
  env: Record<string, string | undefined>,
): string | undefined {
  if (env.EVAL_ENV_FILE?.trim()) return env.EVAL_ENV_FILE.trim();
  try {
    const commonDir = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    return join(dirname(commonDir), ".env.evals");
  } catch {
    return undefined;
  }
}

/** Fills missing variables in `env` from the eval env file. Returns the file used, if any. */
export function loadEvalEnvFile(
  env: Record<string, string | undefined>,
  cwd: string = process.cwd(),
): string | undefined {
  const path = evalEnvFilePath(cwd, env);
  if (!path || !existsSync(path)) return undefined;
  for (const [key, value] of Object.entries(parseEnvFile(readFileSync(path, "utf8")))) {
    if (!env[key]?.trim()) env[key] = value;
  }
  return path;
}
