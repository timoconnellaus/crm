// AutomationWorkflow (ADR 0130): one Cloudflare Workflow instance per automation run. It replays
// the automation's `run` one step at a time:
//
//   start ─► advance:0 ─► (do: journal it; review pause per queued action)
//                      ─► (sleep: step.sleep)  (waitForEvent: step.waitForEvent)  ─► advance:1 …
//                      ─► (done: finish)
//
// Each advance is a Workflow `step.do`, so a finished advance is never repeated (its result,
// including the extension step's value, is stored by Workflows) and a restart or redeploy resumes
// at the next one. Sleeps and waits are Workflow sleeps and waits: durable and free while waiting.
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { AutomationEvent, AutomationJournalEntry } from "@crm/sdk";
import { Executor } from "../executor/executor.ts";
import { type AutomationRunParams, reviewEventType } from "./dispatch.ts";
import {
  advanceRun,
  finishRun,
  loadRunSpec,
  markRunning,
  markWaiting,
  notifyRejected,
  PermanentStepError,
  startRun,
} from "./run.ts";

/** A run takes at most this many steps (Workflows allows 10,000 per instance). */
export const MAX_ADVANCES = 200;

/** Retries for an advance: a transient failure (a D1 hiccup, an isolate restart) is retried. */
export const ADVANCE_RETRIES = {
  retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} as const;

const BOOKKEEPING = { retries: { limit: 5, delay: "1 second", backoff: "exponential" } } as const;

type Decision = "approved" | "rejected" | "failed" | "expired";

export class AutomationWorkflow extends WorkflowEntrypoint<Env, AutomationRunParams> {
  override async run(event: WorkflowEvent<AutomationRunParams>, step: WorkflowStep) {
    const params = event.payload;
    const env = this.env;
    try {
      if (params.delaySeconds) {
        // Debounce: later updates in the window land on this same instance id (coalesced).
        await step.sleep("debounce", params.delaySeconds * 1000);
      }
      const started = await durable(step, "start", BOOKKEEPING, () => startRun(env, params));
      if ("stopped" in started) return { status: started.stopped };
      const runEvent = started.event as AutomationEvent;
      const journal: AutomationJournalEntry[] = [...(params.journal ?? [])];

      for (let i = 0; i < MAX_ADVANCES; i++) {
        const outcome = await durable(step, `advance:${i}`, ADVANCE_RETRIES, async () => {
          try {
            return await advanceRun(env, new Executor(env), params, runEvent, journal);
          } catch (error) {
            if (error instanceof PermanentStepError) {
              throw new NonRetryableError(`${error.code}: ${error.message}`);
            }
            throw error;
          }
        });
        if (outcome.stopped || !outcome.advance) return { status: outcome.stopped ?? "stopped" };
        const advance = outcome.advance;

        if (advance.kind === "done") {
          await durable(step, "finish", BOOKKEEPING, () => finishRun(env, params.runId, "completed"));
          return { status: "completed" };
        }

        if (advance.kind === "do") {
          journal.push({ name: advance.name, kind: "do", value: advance.value ?? null });
          // Review pause: each action the step queued waits for a person's decision.
          for (const [k, pending] of outcome.pending.entries()) {
            await durable(step, `review:${i}:${k}`, BOOKKEEPING, () =>
              markWaiting(env, params.runId, {
                status: "review",
                until: pending.expiresAt,
                changeSetId: pending.changeSetId,
              }),
            );
            let decision: Decision;
            try {
              const decided = await step.waitForEvent<{ decision?: Decision }>(
                `decision:${i}:${k}`,
                { type: reviewEventType(pending.actionId), timeout: pending.timeoutMs },
              );
              decision = decided.payload?.decision ?? "approved";
            } catch {
              decision = "expired";
            }
            if (decision === "expired") {
              await durable(step, `expired:${i}`, BOOKKEEPING, () =>
                finishRun(env, params.runId, "expired", {
                  reason: "The change it queued was not approved before it expired",
                }),
              );
              return { status: "expired" };
            }
            if (decision === "failed") {
              await durable(step, `failed:${i}`, BOOKKEEPING, () =>
                finishRun(env, params.runId, "failed", {
                  error: { code: "apply_failed", message: "The approved change failed to apply" },
                }),
              );
              return { status: "failed" };
            }
            if (decision === "rejected") {
              const spec = await durable(step, `rejected:${i}:${k}`, BOOKKEEPING, () =>
                loadRunSpec(env, params.automationId),
              );
              const rule = spec?.onRejected ?? "stop";
              if (rule !== "continue") {
                if (typeof rule === "object" && spec) {
                  await durable(step, `notify:${i}:${k}`, BOOKKEEPING, () =>
                    notifyRejected(env, params, { spec }, pending.actionId),
                  );
                }
                await durable(step, `cancel:${i}`, BOOKKEEPING, () =>
                  finishRun(env, params.runId, "cancelled", {
                    reason: "A change it queued was rejected",
                  }),
                );
                return { status: "cancelled" };
              }
            }
            await durable(step, `resume:${i}:${k}`, BOOKKEEPING, () => markRunning(env, params.runId));
          }
          continue;
        }

        if (advance.kind === "sleep") {
          await durable(step, `sleeping:${i}`, BOOKKEEPING, () =>
            markWaiting(env, params.runId, {
              status: "waiting",
              step: { name: advance.name, kind: "sleep" },
              until: new Date(Date.now() + advance.ms).toISOString(),
            }),
          );
          await step.sleep(`sleep:${i}`, advance.ms);
          await durable(step, `woke:${i}`, BOOKKEEPING, () => markRunning(env, params.runId));
          journal.push({ name: advance.name, kind: "sleep", value: null });
          continue;
        }

        // waitForEvent: the declared event, or null on timeout.
        await durable(step, `waiting:${i}`, BOOKKEEPING, () =>
          markWaiting(env, params.runId, {
            status: "waiting",
            step: { name: advance.name, kind: "waitForEvent" },
            until: new Date(Date.now() + advance.timeoutMs).toISOString(),
          }),
        );
        let value: unknown = null;
        try {
          const received = await step.waitForEvent(`wait:${i}`, {
            type: advance.event,
            timeout: advance.timeoutMs,
          });
          value = received.payload ?? null;
        } catch {
          value = null;
        }
        await durable(step, `woke:${i}`, BOOKKEEPING, () => markRunning(env, params.runId));
        journal.push({ name: advance.name, kind: "waitForEvent", value });
      }
      await durable(step, "too-long", BOOKKEEPING, () =>
        finishRun(env, params.runId, "failed", {
          error: { code: "too_many_steps", message: `More than ${MAX_ADVANCES} steps` },
        }),
      );
      return { status: "failed" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = /^([a-z_]+): /.exec(message)?.[1] ?? "step_failed";
      await durable(step, "fail", BOOKKEEPING, () =>
        finishRun(env, params.runId, "failed", { error: { code, message } }),
      );
      return { status: "failed", error: message };
    }
  }
}

/**
 * `step.do` for plain-JSON results. Its `Serializable<T>` typing rejects `unknown` JSON values
 * (journaled step results), so results are typed by the callback instead.
 */
function durable<T>(
  step: WorkflowStep,
  name: string,
  config: WorkflowStepConfig,
  fn: () => Promise<T>,
): Promise<T> {
  // biome-ignore lint/suspicious/noExplicitAny: see above; every value here is plain JSON.
  return (step.do as any)(name, config, fn) as Promise<T>;
}
