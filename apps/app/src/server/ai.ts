// In-app AI for crm-app (ADRs 0150-0155): the model role registry, the vector store, Settings →
// AI's Cloudflare API access, and the post-commit hook that drains the embedding queue.
//
// Every binding is optional. Without `AI` (and no other provider configured) there is no model
// runner and AI features say "AI is not configured"; without `VECTORIZE` semantic search falls
// back to full-text. AI_FAKE_MODEL=true (local dev and e2e only) answers every role with
// deterministic stand-ins and keeps vectors in memory, since neither Workers AI nor Vectorize runs
// locally.
import { waitUntil } from "cloudflare:workers";
import {
  type AiAdmin,
  type AiEnv,
  backfillEmbeddingQueue,
  type CommitEvent,
  cloudflareAiAdmin,
  drainAllEmbeddings,
  fakeModels,
  loadAiSettings,
  type ModelRunner,
  memoryVectorStore,
  modelRunnerFromEnv,
  type VectorStore,
  type VectorizeLike,
  vectorizeStore,
} from "@crm/core";
import type { CrmDb } from "@crm/db";

export interface AiAppEnv extends AiEnv {
  /** Vectorize index for record embeddings (optional; docs/deploying.md). */
  VECTORIZE?: unknown;
  /** Secret: Cloudflare API token for Settings → AI (keys, usage). */
  CLOUDFLARE_API_TOKEN?: string;
  /** Worker scripts that get provider key secrets. Default crm-app,crm-runner. */
  AI_SECRET_SCRIPTS?: string;
}

let devVectors: VectorStore | undefined;

/** The vector store: Vectorize, or (local dev / e2e with AI_FAKE_MODEL) one in memory. */
export function vectorStoreFor(env: AiAppEnv): VectorStore | undefined {
  const index = env.VECTORIZE as VectorizeLike | undefined;
  if (index && typeof index.query === "function") return vectorizeStore(index);
  if (env.AI_FAKE_MODEL === "true" && !env.AI) {
    devVectors ??= memoryVectorStore();
    return devVectors;
  }
  return undefined;
}

/** The registry-backed model runner, reading admin overrides from D1 once per runner. */
export function modelsFor(env: AiAppEnv, db: CrmDb): ModelRunner | undefined {
  return modelRunnerFromEnv(env, {
    loadSettings: () => loadAiSettings(db.query),
    fakes: fakeModels(),
  });
}

export function aiAdminFor(env: AiAppEnv): AiAdmin {
  return cloudflareAiAdmin(env);
}

/** What operations see of the AI environment: which keys exist, never their values. */
export function aiEnvView(env: AiAppEnv): AiEnv {
  const view: AiEnv = {
    ...(env.AI ? { AI: true } : {}),
    ...(env.AI_GATEWAY_ID ? { AI_GATEWAY_ID: env.AI_GATEWAY_ID } : {}),
    ...(env.CLOUDFLARE_ACCOUNT_ID ? { CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID } : {}),
    ...(env.AI_MODEL_ROLES ? { AI_MODEL_ROLES: env.AI_MODEL_ROLES } : {}),
    ...(env.AI_PROVIDERS ? { AI_PROVIDERS: env.AI_PROVIDERS } : {}),
    ...(env.VECTORIZE_DIMENSIONS ? { VECTORIZE_DIMENSIONS: env.VECTORIZE_DIMENSIONS } : {}),
    ...(env.AI_FAKE_MODEL ? { AI_FAKE_MODEL: env.AI_FAKE_MODEL } : {}),
  };
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("AI_KEY_") && value) (view as Record<string, unknown>)[key] = "set";
  }
  return view;
}

let draining: Promise<void> | null = null;
let again = false;

/**
 * The post-commit hook (ADR 0154): when a write queued records for embedding, drain the queue in
 * the background after the response. One drain at a time per isolate; writes during a drain
 * schedule one more round. The cron catches up whatever this misses.
 */
export function embeddingHook(
  db: CrmDb,
  models: ModelRunner | undefined,
  vectors: VectorStore | undefined,
): ((event: CommitEvent) => void) | undefined {
  if (!models?.embed || !vectors) return undefined;
  return (event) => {
    if (!event.embeddingsQueued) return;
    if (draining) {
      again = true;
      return;
    }
    const run = async () => {
      do {
        again = false;
        await drainAllEmbeddings({ db, models, vectors }, 5);
      } while (again);
    };
    draining = run()
      .catch((error: unknown) => console.error("embedding drain failed", error))
      .finally(() => {
        draining = null;
      });
    try {
      waitUntil(draining);
    } catch {
      // Outside a request (tests): the promise still runs.
    }
  };
}

/**
 * The cron catch-up (every 10 minutes): the one-time backfill of records that existed before
 * semantic search, then whatever the post-commit drains missed or failed.
 */
export async function runEmbeddingCatchUp(env: AiAppEnv, db: CrmDb, now = new Date()) {
  const models = modelsFor(env, db);
  const vectors = vectorStoreFor(env);
  if (!models?.embed || !vectors) return null;
  const backfill = await backfillEmbeddingQueue(db, now.toISOString());
  const drained = await drainAllEmbeddings({ db, models, vectors }, 20);
  return { backfill, drained };
}

/** The AI part of an InvocationContext. */
export function aiContextFor(env: AiAppEnv, db: CrmDb) {
  const models = modelsFor(env, db);
  const vectors = vectorStoreFor(env);
  const onCommitted = embeddingHook(db, models, vectors);
  return {
    ...(models ? { models } : {}),
    ...(vectors ? { vectors } : {}),
    ...(onCommitted ? { onCommitted } : {}),
    aiAdmin: aiAdminFor(env),
    aiEnv: aiEnvView(env),
  };
}
