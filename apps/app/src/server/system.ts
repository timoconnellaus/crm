// Server functions behind sign-in: system status for the shell and the stage 0 smoke test.
import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { getHealth } from "./health.ts";
import { runner } from "./runner.ts";

export const getSystemHealth = createServerFn({ method: "GET" }).handler(async () =>
  getHealth(env),
);

/** Starts crm-runner's hello-world Workflow through the RUNNER service binding. */
export const startHelloWorkflow = createServerFn({ method: "POST" })
  .validator((input: { name: string }) => ({ name: String(input.name).slice(0, 100) }))
  .handler(async ({ data }) => runner(env).startHelloWorkflow(data.name));

export const getHelloWorkflowStatus = createServerFn({ method: "GET" })
  .validator((input: { id: string }) => ({ id: String(input.id) }))
  .handler(async ({ data }) => runner(env).helloWorkflowStatus(data.id));
