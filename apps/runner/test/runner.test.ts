import { introspectWorkflowInstance } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { applyMigrations, getMigrationLevel } from "@relationship-os/db";
import { describe, expect, it } from "vitest";

describe("ros-runner RPC", () => {
  it("answers ping", async () => {
    const result = await exports.default.ping();
    expect(result).toMatchObject({ ok: true, worker: "ros-runner" });
    expect(Date.parse(result.time)).not.toBeNaN();
  });

  it("runs the hello Workflow to completion", async () => {
    const id = "hello-test";
    await using instance = await introspectWorkflowInstance(env.HELLO_WORKFLOW, id);
    await env.HELLO_WORKFLOW.create({ id, params: { name: " Ada " } });
    await expect(instance.waitForStatus("complete")).resolves.not.toThrow();
    expect(await instance.getOutput()).toEqual({ greeting: "Hello, Ada!", steps: 2 });
  });

  it("starts the hello Workflow over RPC and reports its status", async () => {
    const { id } = await exports.default.startHelloWorkflow("Grace");
    let status = await exports.default.helloWorkflowStatus(id);
    for (let i = 0; i < 50 && status.status !== "complete"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      status = await exports.default.helloWorkflowStatus(id);
    }
    expect(status).toMatchObject({ status: "complete", output: { greeting: "Hello, Grace!" } });
  });

  it("has the D1 binding and the shared core migrations", async () => {
    await applyMigrations(env.DB, env.TEST_MIGRATIONS);
    expect((await getMigrationLevel(env.DB)).upToDate).toBe(true);
  });

  it("serves nothing over HTTP (it is reached over RPC)", async () => {
    const response = await exports.default.fetch("http://runner/anything");
    expect(response.status).toBe(404);
  });
});
