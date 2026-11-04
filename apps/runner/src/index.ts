// crm-runner entrypoint. crm-app calls it over the RUNNER service binding using RPC: liveness, the
// stage 0 Workflow, and the extension host. Since ADR 0043 the host is split: code runs here, in
// the stateless entrypoint (the executor: tools, manifest evaluation, type checks, Code Mode), so
// runs proceed in parallel; git, working copies and the build cache stay in the workspace DO.
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  type CodeResult,
  type EvaluateResult,
  type ExtensionHost,
  type ExtensionVersion,
  installShippedExtensions,
  parseFloor,
  type RunToolInput,
  type RunToolResult,
  type ShippedExtension,
  type ShippedInstallResult,
  type WorkingCopy,
  type WorkingCopyOptions,
  type WorkspaceEntry,
  type WorkspaceWrite,
} from "@crm/core";
import { createCrmDb } from "@crm/db";
import { Executor, type ExecutorOptions } from "./executor/executor.ts";
import type { HelloOutput } from "./hello-workflow.ts";
import type { PingResult, RunnerRpc, WorkflowRunStatus } from "./rpc.ts";

export { CodeModeGate } from "./executor/code-gate.ts";
export { ExtensionWorkspace } from "./extensions/workspace.ts";
export { HelloWorkflow } from "./hello-workflow.ts";
export type { PingResult, RunnerRpc, WorkflowRunStatus } from "./rpc.ts";

/** The deployment's one extension workspace: git, working copies, the build cache. */
export function extensionWorkspace(
  env: Env,
): DurableObjectStub<import("./extensions/workspace.ts").ExtensionWorkspace> {
  return env.EXTENSION_WORKSPACE.getByName("workspace");
}

/**
 * The extension host: execution in this isolate (the executor), storage in the workspace DO.
 * `options` is for tests (a counting loader, short timeouts).
 */
export function extensionHost(env: Env, options: ExecutorOptions = {}): ExtensionHost {
  const ws = () => extensionWorkspace(env);
  const executor = new Executor(env, options);
  return {
    commit: (input) => ws().commit(input),
    shipped: () => ws().shipped(),
    commitShipped: (id) => ws().commitShipped(id),
    evaluate: (input) => executor.evaluate(input),
    runTool: (input) => executor.runTool(input),
    versions: (id) => ws().versions(id),
    files: (id, commit) => ws().files(id, commit),
    listWorkspace: () => ws().listWorkspace(),
    workingCopy: (id, opts) => ws().workingCopy(id, opts),
    writeFiles: (input) => ws().writeFiles(input),
    commitWorkingCopy: (input) => ws().commitWorkingCopy(input),
    eject: (id) => ws().eject(id),
    runCode: (input) => executor.runCode(input),
    describeChange: (input) => executor.describeChange(input),
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

  // ExtensionHost (ADR 0025, ADR 0043).
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
  listWorkspace(): Promise<WorkspaceEntry[]> {
    return extensionHost(this.env).listWorkspace();
  }
  workingCopy(id: string, options?: WorkingCopyOptions): Promise<WorkingCopy> {
    return extensionHost(this.env).workingCopy(id, options);
  }
  writeFiles(input: Parameters<ExtensionHost["writeFiles"]>[0]): Promise<WorkspaceWrite> {
    return extensionHost(this.env).writeFiles(input);
  }
  commitWorkingCopy(input: Parameters<ExtensionHost["commitWorkingCopy"]>[0]) {
    return extensionHost(this.env).commitWorkingCopy(input);
  }
  eject(id: string): Promise<WorkspaceWrite> {
    return extensionHost(this.env).eject(id);
  }
  runCode(input: Parameters<ExtensionHost["runCode"]>[0]): Promise<CodeResult> {
    return extensionHost(this.env).runCode(input);
  }
  describeChange(input: Parameters<ExtensionHost["describeChange"]>[0]) {
    return extensionHost(this.env).describeChange(input);
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
