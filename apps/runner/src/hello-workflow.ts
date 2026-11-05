// The stage 0 hello-world Workflow. It proves Workflows deploy and run from ros-app's smoke test;
// real automations replace it in stage 5.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

export interface HelloParams {
  name: string;
}

export interface HelloOutput {
  greeting: string;
  steps: number;
}

export class HelloWorkflow extends WorkflowEntrypoint<Env, HelloParams> {
  override async run(event: WorkflowEvent<HelloParams>, step: WorkflowStep): Promise<HelloOutput> {
    const name = await step.do("normalise name", async () => event.payload.name.trim() || "world");
    const greeting = await step.do("greet", async () => `Hello, ${name}!`);
    return { greeting, steps: 2 };
  }
}
