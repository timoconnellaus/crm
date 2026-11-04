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
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
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
      const started = await step.do("start", BOOKKEEPING, () => startRun(env, params));
      if ("stopped" in started) return { status: started.stopped };
      const runEvent = started.event as AutomationEvent;
      const journal: AutomationJournalEntry[] = [...(params.journal ?? [])];

      for (let i = 0; i < MAX_ADVANCES; i++) {
        const outcome = await step.do(`advance:${i}`, ADVANCE_RETRIES, async () => {
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
          await step.do("finish", BOOKKEEPING, () => finishRun(env, params.runId, "completed"));
          return { status: "completed" };
        }

        if (advance.kind === "do") {
          journal.push({ name: advance.name, kind: "do", value: advance.value ?? null });
          // Review pause: each action the step queued waits for a person's decision.
          for (const [k, pending] of outcome.pending.entries()) {
            await step.do(`review:${i}:${k}`, BOOKKEEPING, () =>
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
              await step.do(`expired:${i}`, BOOKKEEPING, () =>
                finishRun(env, params.runId, "expired", {
                  reason: "The change it queued was not approved before it expired",
                }),
              );
              return { status: "expired" };
            }
            if (decision === "failed") {
              await step.do(`failed:${i}`, BOOKKEEPING, () =>
                finishRun(env, params.runId, "failed", {
                  error: { code: "apply_failed", message: "The approved change failed to apply" },
                }),
              );
              return { status: "failed" };
            }
            if (decision === "rejected") {
              const spec = await step.do(`rejected:${i}:${k}`, BOOKKEEPING, () =>
                loadRunSpec(env, params.automationId),
              );
              const rule = spec?.onRejected ?? "stop";
              if (rule !== "continue") {
                if (typeof rule === "object" && spec) {
                  await step.do(`notify:${i}:${k}`, BOOKKEEPING, () =>
                    notifyRejected(env, params, { spec }, pending.actionId),
                  );
                }
                await step.do(`cancel:${i}`, BOOKKEEPING, () =>
                  finishRun(env, params.runId, "cancelled", {
                    reason: "A change it queued was rejected",
                  }),
                );
                return { status: "cancelled" };
              }
            }
            await step.do(`resume:${i}:${k}`, BOOKKEEPING, () => markRunning(env, params.runId));
          }
          continue;
        }

        if (advance.kind === "sleep") {
          await step.do(`sleeping:${i}`, BOOKKEEPING, () =>
            markWaiting(env, params.runId, {
              status: "waiting",
              step: { name: advance.name, kind: "sleep" },
              until: new Date(Date.now() + advance.ms).toISOString(),
            }),
          );
          await step.sleep(`sleep:${i}`, advance.ms);
          await step.do(`woke:${i}`, BOOKKEEPING, () => markRunning(env, params.runId));
          journal.push({ name: advance.name, kind: "sleep", value: null });
          continue;
        }

        // waitForEvent: the declared event, or null on timeout.
        await step.do(`waiting:${i}`, BOOKKEEPING, () =>
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
        await step.do(`woke:${i}`, BOOKKEEPING, () => markRunning(env, params.runId));
        journal.push({ name: advance.name, kind: "waitForEvent", value });
      }
      await step.do("too-long", BOOKKEEPING, () =>
        finishRun(env, params.runId, "failed", {
          error: { code: "too_many_steps", message: `More than ${MAX_ADVANCES} steps` },
        }),
      );
      return { status: "failed" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = /^([a-z_]+): /.exec(message)?.[1] ?? "step_failed";
      await step.do("fail", BOOKKEEPING, () =>
        finishRun(env, params.runId, "failed", { error: { code, message } }),
      );
      return { status: "failed", error: message };
    }
  }
}
