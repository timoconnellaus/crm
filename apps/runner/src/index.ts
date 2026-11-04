// crm-runner entrypoint. crm-app calls it over the RUNNER service binding using RPC: liveness, the
// stage 0 Workflow, and the extension host, which forwards to the extension workspace DO.
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  type EvaluateResult,
  type ExtensionHost,
  type ExtensionVersion,
  installShippedExtensions,
  parseFloor,
  type RunToolInput,
  type RunToolResult,
  type ShippedExtension,
  type ShippedInstallResult,
} from "@crm/core";
import { createCrmDb } from "@crm/db";
import type { HelloOutput } from "./hello-workflow.ts";
import type { PingResult, RunnerRpc, WorkflowRunStatus } from "./rpc.ts";

export { ExtensionWorkspace } from "./extensions/workspace.ts";
export { HelloWorkflow } from "./hello-workflow.ts";
export type { PingResult, RunnerRpc, WorkflowRunStatus } from "./rpc.ts";

/** The deployment's one extension workspace. */
export function extensionWorkspace(
  env: Env,
): DurableObjectStub<import("./extensions/workspace.ts").ExtensionWorkspace> {
  return env.EXTENSION_WORKSPACE.getByName("workspace");
}

/** The extension host as plain async functions over the workspace stub. */
export function extensionHost(env: Env): ExtensionHost {
  const ws = () => extensionWorkspace(env);
  return {
    commit: (input) => ws().commit(input),
    shipped: () => ws().shipped(),
    commitShipped: (id) => ws().commitShipped(id),
    evaluate: (input) => ws().evaluate(input) as Promise<EvaluateResult>,
    runTool: (input) => ws().runTool(input) as Promise<RunToolResult>,
    versions: (id) => ws().versions(id),
    files: (id, commit) => ws().files(id, commit),
  };
}

export default class Runner extends WorkerEntrypoint<Env> implements RunnerRpc {
  async ping(): Promise<PingResult> {
    return { ok: true, worker: "crm-runner", time: new Date().toISOString() };
  }

  async startHelloWorkflow(name: string): Promise<{ id: string }> {
    const instance = await this.env.HELLO_WORKFLOW.create({ params: { name } });
    return { id: instance.id };
  }

  async helloWorkflowStatus(id: string): Promise<WorkflowRunStatus> {
    const instance = await this.env.HELLO_WORKFLOW.get(id);
    const status = await instance.status();
    return {
      id,
      status: status.status,
      output: (status.output as HelloOutput | undefined) ?? null,
      error: status.error ? `${status.error.name}: ${status.error.message}` : null,
    };
  }

  // ExtensionHost (ADR 0025), forwarded to the workspace DO.
  commit(input: Parameters<ExtensionHost["commit"]>[0]) {
    return extensionHost(this.env).commit(input);
  }
  shipped(): Promise<ShippedExtension[]> {
    return extensionHost(this.env).shipped();
  }
  commitShipped(id: string) {
    return extensionHost(this.env).commitShipped(id);
  }
  evaluate(input: Parameters<ExtensionHost["evaluate"]>[0]): Promise<EvaluateResult> {
    return extensionHost(this.env).evaluate(input);
  }
  runTool(input: RunToolInput): Promise<RunToolResult> {
    return extensionHost(this.env).runTool(input);
  }
  versions(id: string): Promise<ExtensionVersion[]> {
    return extensionHost(this.env).versions(id);
  }
  files(id: string, commit: string): Promise<Record<string, string>> {
    return extensionHost(this.env).files(id, commit);
  }

  /** Installs or upgrades the shipped extensions bundled with this release (boot / deploy). */
  async installShipped(): Promise<ShippedInstallResult[]> {
    return installShippedExtensions({
      db: createCrmDb(this.env.DB),
      host: extensionHost(this.env),
      floor: parseFloor(this.env.APPROVAL_FLOOR),
    });
  }

  override async fetch(_request: Request): Promise<Response> {
    return new Response("crm-runner is reached over RPC", { status: 404 });
  }
}
