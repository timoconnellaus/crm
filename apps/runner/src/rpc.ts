// The RPC surface crm-app calls over the RUNNER service binding. Kept free of the Worker's Env so
// crm-app can import the types without type-checking runner source against its own Env.
import type { ExtensionHost, IntegrationRuntime, ShippedInstallResult } from "@crm/core";
import type { HelloOutput } from "./hello-workflow.ts";

export type { HelloOutput } from "./hello-workflow.ts";

export interface PingResult {
  ok: true;
  worker: "crm-runner";
  time: string;
}

export interface WorkflowRunStatus {
  id: string;
  status:
    | "queued"
    | "running"
    | "paused"
    | "errored"
    | "terminated"
    | "complete"
    | "waiting"
    | "waitingForPause"
    | "rollingBack"
    | "unknown";
  output: HelloOutput | null;
  error: string | null;
}

/**
 * crm-runner's RPC: liveness, the stage 0 Workflow smoke test, and the extension host (ADR 0025),
 * which forwards to the extension workspace Durable Object.
 */
export interface RunnerRpc extends ExtensionHost {
  /** Liveness check, shown on crm-app's /api/health. */
  ping(): Promise<PingResult>;
  /** Starts the hello-world Workflow (stage 0 smoke test). */
  startHelloWorkflow(name: string): Promise<{ id: string }>;
  helloWorkflowStatus(id: string): Promise<WorkflowRunStatus>;
  /** Installs or upgrades the shipped extensions bundled with this release, via extension.install. */
  installShipped(): Promise<ShippedInstallResult[]>;
  /** The IntegrationRuntime port (stage 6a, ADR 0110), one method at a time. */
  integration<K extends keyof IntegrationRuntime>(
    method: K,
    input: Parameters<IntegrationRuntime[K]>[0],
  ): ReturnType<IntegrationRuntime[K]>;
  /** Proxies a public /gatekeeper/<vendor>/* request to that gatekeeper. */
  gatekeeperFetch(vendor: string, request: Request): Promise<Response>;
}
