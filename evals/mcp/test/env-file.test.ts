import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEvalEnvFile, parseEnvFile } from "../lib/env-file.ts";

describe("eval env file", () => {
  it("parses KEY=VALUE lines, skipping comments and blanks", () => {
    expect(
      parseEnvFile(
        "# comment\n\nEVAL_BASE_URL=https://x/v1\nexport EVAL_MODEL='m'\nEVAL_API_KEY=\"k\"\nnot a line\n",
      ),
    ).toEqual({ EVAL_BASE_URL: "https://x/v1", EVAL_MODEL: "m", EVAL_API_KEY: "k" });
  });

  it("fills only variables the environment does not already set", () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-env-"));
    const file = join(dir, ".env.evals");
    writeFileSync(file, "EVAL_API_KEY=from-file\nEVAL_MODEL=file-model\n");
    const env: Record<string, string | undefined> = {
      EVAL_ENV_FILE: file,
      EVAL_MODEL: "shell-model",
    };
    expect(loadEvalEnvFile(env, dir)).toBe(file);
    expect(env.EVAL_API_KEY).toBe("from-file");
    expect(env.EVAL_MODEL).toBe("shell-model");
  });

  it("does nothing when the file is missing", () => {
    const env: Record<string, string | undefined> = { EVAL_ENV_FILE: "/nonexistent/.env.evals" };
    expect(loadEvalEnvFile(env)).toBeUndefined();
    expect(env.EVAL_API_KEY).toBeUndefined();
  });
});
