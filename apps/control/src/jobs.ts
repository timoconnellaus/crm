// Background work, on the ros-control-jobs queue (inline when JOBS_INLINE=on: dev and tests).
// Each job is idempotent, so a queue retry after a partial failure converges.

import { provisionInstance } from "./instances.ts";
import { deleteAccount, runExport } from "./lifecycle.ts";
import { meterDay } from "./metering.ts";
import { rolloutStep } from "./rollout.ts";
import type { Services } from "./services.ts";

export type Job =
  | { kind: "provision"; instanceId: string }
  | { kind: "rollout.step"; rolloutId: string }
  | { kind: "meter"; instanceId: string; day: string }
  | { kind: "export"; exportId: string }
  | { kind: "delete"; accountId: string };

export async function runJob(s: Services, job: Job): Promise<void> {
  switch (job.kind) {
    case "provision":
      return provisionInstance(s, job.instanceId);
    case "rollout.step":
      return rolloutStep(s, job.rolloutId);
    case "meter":
      return meterDay(s, job.instanceId, job.day);
    case "export":
      return runExport(s, job.exportId);
    case "delete":
      return deleteAccount(s, job.accountId);
  }
}
