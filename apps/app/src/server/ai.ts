// In-app AI for ros-app (ADRs 0150-0155): the model role registry, the vector store, Settings →
// AI's Cloudflare API access, and the post-commit hook that drains the embedding queue.
//
// Every binding is optional. Without `AI` (and no other provider configured) there is no model
// runner and AI features say "AI is not configured"; without `VECTORIZE` semantic search falls
// back to full-text. AI_FAKE_MODEL=true (local dev and e2e only) answers every role with
// deterministic stand-ins and keeps vectors in memory, since neither Workers AI nor Vectorize runs
// locally.
import { waitUntil } from "cloudflare:workers";
import {
  type AdjudicatorDeps,
  type AiAdmin,
  type AiEnv,
  adjudicatePendingAction,
  backfillEmbeddingQueue,
  type CommitEvent,
  cloudflareAiAdmin,
  customerGateway,
  devJudge,
  drainAllEmbeddings,
  fakeModels,
  type HostedAiAdminEnv,
  hostedAiAdmin,
  hostedModelOptions,
  type InvocationContext,
  isHosted,
  type Judge,
  judgeFor,
  judgeHasKey,
  judgeRoute,
  loadAiSettings,
  loadJudgeSettings,
  type ModelRunner,
  memoryVectorStore,
  modelRunnerFromEnv,
  platformAiAllowed,
  type QueuedEvent,
  type VectorizeLike,
  type VectorStore,
  vectorizeStore,
} from "@relationship-os/core";
import { type CrmDb, createCrmDb } from "@relationship-os/db";
import { voiceContextFor } from "./assistant/voice.ts";

export interface AiAppEnv extends AiEnv, HostedAiAdminEnv {
  /** "true": stand-in speech providers (local dev and e2e only), like AI_FAKE_MODEL. */
  AI_FAKE_VOICE?: string;
  /** Vectorize index for record embeddings (optional; docs/deploying.md). */
  VECTORIZE?: unknown;
  /** Secret: Cloudflare API token for Settings → AI (keys, usage). */
  CLOUDFLARE_API_TOKEN?: string;
  /** Worker scripts that get provider key secrets. Default ros-app,ros-runner. */
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
    // Hosted plans (ADR 0211): platform AI only while the plan's allowance lasts; BYOK always.
    platformAi: () => platformAiAllowed(db.query),
    // Hosted (ADR 0213 amendment): the plan for the tenant tag, and usage counted in D1.
    ...hostedModelOptions(env, db.query, schedule),
  });
}

/**
 * The judge (ADR 0230): Jev when a key is reachable (BYOK in AI Gateway, or TYPESAFE_API_KEY),
 * otherwise off with no network call. The placement switches are read from D1 at most once, and
 * only when a placement first asks: building it costs nothing.
 */
export function judgeOf(env: AiAppEnv, db: CrmDb): Judge {
  // Local dev and e2e only, as fakeModels: a keyword stand-in for authoring.intent, so the
  // approval screen's intent check works without TypeSafe. Never with a real key or AI binding.
  if (env.AI_FAKE_MODEL === "true" && !env.AI && !judgeRoute(env).ready) return devJudge;
  return judgeFor(env, { loadSettings: () => loadJudgeSettings(db.query) });
}

/** waitUntil when inside a request; outside one (tests, crons) the promise just runs. */
function schedule(work: Promise<unknown>) {
  try {
    waitUntil(work);
  } catch {
    // Outside a request: the promise still runs.
  }
}

/**
 * Settings → AI's reach: the Cloudflare API (self-hosted), or the control plane over the signed
 * deployment channel (hosted, ADR 0250).
 */
export function aiAdminFor(env: AiAppEnv, db?: CrmDb): AiAdmin {
  if (isHosted(env)) return hostedAiAdmin(env, db ? { db: db.query } : {});
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
    ...(env.AI_GATEWAY_BYOK ? { AI_GATEWAY_BYOK: env.AI_GATEWAY_BYOK } : {}),
    ...(env.AI_GATEWAY_REST ? { AI_GATEWAY_REST: env.AI_GATEWAY_REST } : {}),
    ...(env.VECTORIZE_DIMENSIONS ? { VECTORIZE_DIMENSIONS: env.VECTORIZE_DIMENSIONS } : {}),
    ...(env.AI_FAKE_MODEL ? { AI_FAKE_MODEL: env.AI_FAKE_MODEL } : {}),
    // The judge's key, as "set" only (ADR 0230, ADR 0151).
    ...(env.TYPESAFE_API_KEY ? { TYPESAFE_API_KEY: "set" } : {}),
    ...(env.JUDGE_BYOK ? { JUDGE_BYOK: env.JUDGE_BYOK } : {}),
    ...(env.JUDGE_PLACEMENTS ? { JUDGE_PLACEMENTS: env.JUDGE_PLACEMENTS } : {}),
    // Hosted placement (ADR 0213 amendment): ids only; the platform token and the customer's
    // gateway token are shown as "set" (their values never reach an operation).
    ...(env.AI_PLATFORM_GATEWAY_ID ? { AI_PLATFORM_GATEWAY_ID: env.AI_PLATFORM_GATEWAY_ID } : {}),
    ...(env.AI_PLATFORM_ACCOUNT_ID ? { AI_PLATFORM_ACCOUNT_ID: env.AI_PLATFORM_ACCOUNT_ID } : {}),
    ...(env.AI_PLATFORM_TOKEN ? { AI_PLATFORM_TOKEN: "set" } : {}),
    ...(env.ROS_TENANT_ID ? { ROS_TENANT_ID: env.ROS_TENANT_ID } : {}),
    ...(customerGatewayView(env) ? { AI_CUSTOMER_GATEWAY: customerGatewayView(env) } : {}),
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

/** The 10-minute cron's entry: the catch-up over this Worker's D1. Never throws. */
export async function runEmbeddingCron(env: AiAppEnv & { DB: D1Database }) {
  try {
    const result = await runEmbeddingCatchUp(env, createCrmDb(env.DB));
    if (result?.drained.taken || result?.backfill.queued) {
      console.log(
        `embeddings: backfill queued ${result.backfill.queued}, embedded ${result.drained.embedded}, ` +
          `deleted ${result.drained.deleted}, unchanged ${result.drained.unchanged}`,
      );
    }
    return result;
  } catch (error) {
    console.error("embedding catch-up failed", error);
    return null;
  }
}

/**
 * The post-queue hook (ADR 0204): when the review path queued a pending action, the policy
 * adjudicator judges it in the background after the response, with the caller's context minus the
 * caller. With the adjudicator off that is one settings read and nothing else. The 10-minute
 * cron's sweep catches up whatever this misses.
 */
export function adjudicationHook(): (event: QueuedEvent, ctx: InvocationContext) => void {
  return (event, ctx) => {
    const {
      actor: _actor,
      user: _user,
      origin: _origin,
      approval: _approval,
      reason: _reason,
      grantedPermissions: _granted,
      extension: _extension,
      simulate: _simulate,
      onQueued: _onQueued,
      ...deps
    } = ctx;
    const run = adjudicatePendingAction(deps satisfies AdjudicatorDeps, event.actionId);
    try {
      waitUntil(run);
    } catch {
      // Outside a request (tests): the promise still runs.
    }
  };
}

/** The AI part of an InvocationContext. */
export function aiContextFor(env: AiAppEnv, db: CrmDb) {
  const models = modelsFor(env, db);
  const vectors = vectorStoreFor(env);
  const onCommitted = embeddingHook(db, models, vectors);
  // With a real Vectorize binding, ros-runner's events consumer embeds committed changes (it has
  // the same bindings, ADR 0154 amendment); the in-memory dev store is filled here instead.
  const index = env.VECTORIZE as VectorizeLike | undefined;
  const viaEvents = Boolean(index && typeof index.query === "function" && models?.embed);
  const judge = judgeOf(env, db);
  return {
    ...(models ? { models } : {}),
    judge,
    ...(vectors ? { vectors } : {}),
    ...(viaEvents ? { embedViaEvents: true } : {}),
    ...(onCommitted ? { onCommitted } : {}),
    // The adjudicator can review with the `review` role or with Jev (ADR 0233).
    ...(models || judgeHasKey(judge) ? { onQueued: adjudicationHook() } : {}),
    aiAdmin: aiAdminFor(env, db),
    aiEnv: aiEnvView(env),
    ...voiceContextFor(env, db),
  };
}

/** The customer's own gateway for operations: ids, and the token only as "set". */
function customerGatewayView(env: AiAppEnv): string | undefined {
  const own = customerGateway(env);
  if (!own) return undefined;
  return JSON.stringify({
    accountId: own.accountId,
    gatewayId: own.gatewayId,
    ...(own.token ? { token: "set" } : {}),
  });
}
