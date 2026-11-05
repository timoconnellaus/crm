// Local development's secrets (docs/deploying.md "Local development"). wrangler.jsonc declares
// `secrets.required: ["BETTER_AUTH_SECRET"]` so a deploy without it fails. Once `secrets` is
// declared, though, local dev (the Vite plugin and `wrangler dev`) loads only the declared names
// from .dev.vars and silently drops the rest: provider keys (AI_KEY_*), TYPESAFE_API_KEY,
// GOOGLE_CLIENT_*, CF_ACCESS_* and the other optional secrets. Wrangler has no list of optional
// secrets, and declaring them as required would make every deploy demand every provider's key.
// So `vite dev` (only) widens the declaration to every name .dev.vars sets, which is what local
// dev did before `secrets` existed. Deploys and `wrangler types` read wrangler.jsonc unchanged.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

/** The names a Worker's .dev.vars sets (none without the file). */
export function devVarNames(dir: string): string[] {
  const file = join(dir, ".dev.vars");
  if (!existsSync(file)) return [];
  return Object.keys(parseEnv(readFileSync(file, "utf8")));
}

/**
 * The `secrets` declaration for local dev: the required names plus every name in .dev.vars, so
 * optional secrets reach the Worker. Without a declaration there is nothing to widen (local dev
 * then loads all of .dev.vars already).
 */
export function devSecrets(
  secrets: { required?: string[] | undefined } | undefined,
  dir: string,
): { required: string[] } | undefined {
  if (!secrets) return undefined;
  return { required: [...new Set([...(secrets.required ?? []), ...devVarNames(dir)])] };
}
