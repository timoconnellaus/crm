// crm-runner entrypoint. crm-app calls it over the RUNNER service binding using RPC: liveness, the
// stage 0 Workflow, and the extension host. Since ADR 0043 the host is split: code runs here, in
// the stateless entrypoint (the executor: tools, manifest evaluation, type checks, Code Mode), so
// runs proceed in parallel; git, working copies and the build cache stay in the workspace DO.
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  type AutomationQueueMessage,
  type AutomationTestReport,
  type CodeResult,
  type EvaluateResult,
  type ExtensionHost,
  type ExtensionVersion,
  type IntegrationRuntime,
  installShippedExtensions,
  parseFloor,
  type RunToolInput,
  type RunToolResult,
  retryOutbox,
  type ShippedExtension,
  type ShippedInstallResult,
  type StartRunInput,
  vendorBinding,
  type WorkingCopy,
  type WorkingCopyOptions,
  type WorkspaceEntry,
  type WorkspaceWrite,
} from "@crm/core";
import { createCrmDb } from "@crm/db";
import { dispatchAutomationMessages } from "./automations/dispatch.ts";
import { automationHost } from "./automations/host.ts";
import { pollIntegrationEvents } from "./automations/integration-events.ts";
import { runAutomationCron } from "./automations/schedule.ts";
import { Executor, type ExecutorOptions } from "./executor/executor.ts";
import type { HelloOutput } from "./hello-workflow.ts";
import { fakeProviderFetch } from "./integrations/fake.ts";
import { availableVendors, integrationRuntime } from "./integrations/runtime.ts";
import type { PingResult, RunnerRpc, WorkflowRunStatus } from "./rpc.ts";

export {
  type AutomationRunParams,
  type CandidateOrigin,
  chainKey,
  dispatchAutomationMessages,
  type StartResult,
  startRuns,
} from "./automations/dispatch.ts";
export { AutomationWorkflow } from "./automations/workflow.ts";
export { CodeModeGate } from "./executor/code-gate.ts";
export { ExtensionWorkspace } from "./extensions/workspace.ts";
export { HelloWorkflow } from "./hello-workflow.ts";
export { ConnectCallback, HostHookInitiator } from "./integrations/entrypoints.ts";
export {
  FakeAccount,
  FakeGatekeeper,
  FakeGatekeeperVendor,
  FakeHookController,
  FakeProvider,
  FakeUser,
  FakeVerifier,
} from "./integrations/fake.ts";
export { IntegrationHost } from "./integrations/host.ts";
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

  // Integrations (ADR 0050, ADR 0110): the IntegrationRuntime port for crm-app, one method.
  integration<K extends keyof IntegrationRuntime>(
    method: K,
    input: Parameters<IntegrationRuntime[K]>[0],
  ): ReturnType<IntegrationRuntime[K]> {
    const runtime = integrationRuntime(this.env);
    if (!Object.hasOwn(runtime, method)) throw new Error(`No integration method ${String(method)}`);
    return (runtime[method] as (i: typeof input) => ReturnType<IntegrationRuntime[K]>)(input);
  }

  /** crm-app proxies /gatekeeper/<vendor>/* here: OAuth redirects, connect pages, pushes. */
  async gatekeeperFetch(vendor: string, request: Request): Promise<Response> {
    if (vendor === "fake") {
      if (this.env.INTEGRATIONS_FAKE_PROVIDER !== "true")
        return new Response("Not found", { status: 404 });
      return fakeProviderFetch(this.env, request);
    }
    if (!availableVendors(this.env).includes(vendor)) {
      return new Response("Not found", { status: 404 });
    }
    const binding = (this.env as unknown as Record<string, Fetcher>)[vendorBinding(vendor)];
    return binding ? binding.fetch(request) : new Response("Not found", { status: 404 });
  }

  // AutomationHost (ADR 0130): automation.test, run, retry, replay and cancel from crm-app.
  testAutomation(input: {
    automationId: string;
    record?: { object: string; id: string };
    userId: string;
  }): Promise<AutomationTestReport> {
    return automationHost(this.env).testAutomation(input);
  }
  startManualRun(input: StartRunInput): Promise<{ runIds: string[]; skipped: number }> {
    return automationHost(this.env).startManualRun(input);
  }
  retryRun(runId: string): Promise<{ runId: string }> {
    return automationHost(this.env).retryRun(runId);
  }
  replayRun(runId: string): Promise<{ runId: string }> {
    return automationHost(this.env).replayRun(runId);
  }
  cancelRun(runId: string): Promise<{ runId: string }> {
    return automationHost(this.env).cancelRun(runId);
  }

  /**
   * The automation events consumer (ADR 0130): a batch at a time. A failed batch is retried
   * (and dead-lettered after max_retries); run creation is idempotent, so a retry never doubles.
   */
  override async queue(batch: MessageBatch<AutomationQueueMessage>): Promise<void> {
    try {
      await dispatchAutomationMessages(
        this.env,
        batch.messages.map((m) => m.body),
      );
      batch.ackAll();
    } catch (error) {
      console.error("automation events: batch failed, retrying", error);
      batch.retryAll({ delaySeconds: 10 });
    }
  }

  /**
   * `* * * * *`: schedules and the daily date-relative scan (ADR 0130), the automation events
   * outbox retry (ADR 0171) and integration events (webhooks, sync) as triggers (ADR 0173). Each
   * step is independent: one failing is logged and does not stop the others.
   */
  override async scheduled(controller: ScheduledController): Promise<void> {
    const at = new Date(controller.scheduledTime);
    await minuteStep("schedules", () => runAutomationCron(this.env, at));
    await minuteStep("outbox", () =>
      retryOutbox(
        createCrmDb(this.env.DB),
        async (messages) => {
          await dispatchAutomationMessages(this.env, messages, { now: at });
        },
        { now: at },
      ),
    );
    await minuteStep("integration events", () => pollIntegrationEvents(this.env, { now: at }));
  }

  override async fetch(_request: Request): Promise<Response> {
    return new Response("crm-runner is reached over RPC", { status: 404 });
  }
}

async function minuteStep(name: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.error(`minute cron: ${name} failed`, error);
  }
}
