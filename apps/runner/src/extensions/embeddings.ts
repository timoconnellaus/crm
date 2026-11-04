// Semantic search's half of the automation events consumer (ADR 0154 amendment): committed record
// changes arrive here as stage 5 record events, and the records whose text changed are embedded
// straight away (hash-checked, batched), with no queue row on the write path. Only with a real
// Vectorize binding and a model: without them (local dev, tests) crm-app's queue path does it.
import {
  type AutomationQueueMessage,
  embedRecordEvents,
  type VectorizeLike,
  vectorizeStore,
} from "@crm/core";
import { createCrmDb } from "@crm/db";
import { runnerModels } from "./ai.ts";

interface EmbedEnv {
  DB: D1Database;
  VECTORIZE?: unknown;
}

/** Does this Worker embed from events (a Vectorize binding and a model that can embed)? */
export function embedsFromEvents(env: object): boolean {
  const index = (env as EmbedEnv).VECTORIZE as VectorizeLike | undefined;
  return Boolean(index && typeof index.query === "function" && runnerModels(env)?.embed);
}

/** Embeds the records a batch of events changed. Never throws (failures are queued for the cron). */
export async function embedFromEvents(
  env: EmbedEnv,
  messages: readonly AutomationQueueMessage[],
): Promise<void> {
  if (!embedsFromEvents(env)) return;
  const changes = messages.flatMap((m) => (m.kind === "record" ? m.changes : []));
  if (!changes.length) return;
  const models = runnerModels(env);
  if (!models) return;
  try {
    await embedRecordEvents(
      {
        db: createCrmDb(env.DB),
        models,
        vectors: vectorizeStore(env.VECTORIZE as VectorizeLike),
      },
      changes,
    );
  } catch (error) {
    console.error("embedding from events failed", error);
  }
}
