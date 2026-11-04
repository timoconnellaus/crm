// crm-runner entrypoint. crm-app calls it over the RUNNER service binding using RPC.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { HelloOutput } from "./hello-workflow.ts";
import type { PingResult, RunnerRpc, WorkflowRunStatus } from "./rpc.ts";
import { handleSpikeRoute } from "./spike/routes.ts";

export { HelloWorkflow } from "./hello-workflow.ts";
export type { PingResult, RunnerRpc, WorkflowRunStatus } from "./rpc.ts";
export { SpikeWorkspace } from "./spike/workspace.ts";

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

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/dev/") && this.env.DEV_ROUTES === "true") {
      return handleSpikeRoute(request, this.env);
    }
    return new Response("crm-runner is reached over RPC", { status: 404 });
  }
}
