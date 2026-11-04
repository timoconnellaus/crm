// GET /api/health: version, commit, D1 migration level and a crm-runner ping.
import { identityProviderKind } from "@crm/auth";
import { getMigrationLevel, type MigrationLevel } from "@crm/db";
import { runner } from "./runner.ts";

export interface HealthEnv {
  DB: D1Database;
  /** The installed release (stage 8); empty for a source deploy. */
  CRM_RELEASE_VERSION?: string;
  IDENTITY_PROVIDER?: string;
  RUNNER: Fetcher;
}

export interface Health {
  status: "ok" | "degraded";
  version: string;
  commit: string;
  identityProvider: string;
  database: ({ ok: boolean } & MigrationLevel) | { ok: false; error: string };
  runner: { ok: true; worker: string; latencyMs: number } | { ok: false; error: string };
}

const VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";
const COMMIT = typeof __APP_COMMIT__ === "string" ? __APP_COMMIT__ : "unknown";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function getHealth(env: HealthEnv): Promise<Health> {
  const [database, runnerHealth] = await Promise.all([
    getMigrationLevel(env.DB).then(
      (level) => ({ ok: level.upToDate, ...level }),
      (error: unknown) => ({ ok: false as const, error: message(error) }),
    ),
    (async () => {
      const started = Date.now();
      try {
        const pong = await runner(env).ping();
        return { ok: true as const, worker: pong.worker, latencyMs: Date.now() - started };
      } catch (error) {
        return { ok: false as const, error: message(error) };
      }
    })(),
  ]);

  let identityProvider: string;
  try {
    identityProvider = identityProviderKind(env);
  } catch (error) {
    identityProvider = `invalid: ${message(error)}`;
  }

  return {
    status: database.ok && runnerHealth.ok ? "ok" : "degraded",
    // The release version when installed from a release, so smoke checks can see the switch.
    version: env.CRM_RELEASE_VERSION || VERSION,
    commit: COMMIT,
    identityProvider,
    database,
    runner: runnerHealth,
  };
}

export async function healthResponse(env: HealthEnv): Promise<Response> {
  const health = await getHealth(env);
  return Response.json(health, {
    status: health.status === "ok" ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
