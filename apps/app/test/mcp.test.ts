// /mcp end to end in workerd (stage 2 AC2): OAuth discovery, and MCP tools generated from the
// registry, read with the MCP TypeScript client. mcp-flows.test.ts covers AC3-7 and 9.
import { coreRegistry } from "@crm/core";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { toolInputSchema } from "../src/server/mcp/tools.ts";
import {
  appFor,
  call,
  connect,
  mcpClient,
  ORIGIN,
  setPreset,
  signUp,
  type TestUser,
  testEnv,
  unique,
} from "./mcp-helpers.ts";

const mcpEnv = testEnv();
const fetchApp = appFor(mcpEnv);

let member: TestUser;

beforeAll(async () => {
  member = await signUp(mcpEnv, "member");
});

beforeEach(async () => {
  await setPreset("balanced");
});

describe("OAuth discovery", () => {
  it("challenges unauthenticated /mcp requests and publishes metadata", async () => {
    const response = await fetchApp("/mcp", { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/resource_metadata/);
    const as = await fetchApp("/.well-known/oauth-authorization-server");
    expect(await as.json()).toMatchObject({
      authorization_endpoint: `${ORIGIN}/oauth/consent`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
    });
  });
});

describe("tools from the registry (AC2)", () => {
  it("converts each operation's input schema once, not on every request", () => {
    const op = coreRegistry.list().find((o) => o.mcp?.curated && o.risk !== "read");
    if (!op) throw new Error("no curated write operation");
    const first = toolInputSchema(op);
    expect(toolInputSchema(op)).toBe(first);
    expect((first.required as string[]).includes("reason")).toBe(true);
  });

  it("lists curated tools with descriptions and hides non-MCP operations", async () => {
    const tokens = await connect(fetchApp, member);
    const client = await mcpClient(fetchApp, tokens.access_token);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    const curated = coreRegistry.list().filter((op) => op.mcp?.curated);
    for (const op of curated) {
      const tool = tools.find((t) => t.name === op.name.replace(/\./g, "_"));
      expect(tool, op.name).toBeDefined();
      expect(tool?.description?.length ?? 0).toBeGreaterThan(60);
      const schema = (tool?.inputSchema ?? {}) as Record<string, unknown>;
      // Plain objects at the top level: the Claude API refuses top-level anyOf/oneOf.
      expect(schema.type, op.name).toBe("object");
      expect(schema.anyOf, op.name).toBeUndefined();
      expect(schema.oneOf, op.name).toBeUndefined();
      if (op.risk !== "read" && !op.bookkeeping) {
        expect((schema.required as string[]) ?? [], op.name).toContain("reason");
      }
    }
    const log = tools.find((t) => t.name === "activity_log")?.inputSchema as {
      properties: Record<string, { enum?: string[] }>;
    };
    expect(log.properties.type?.enum).toEqual(["note", "email", "call", "meeting"]);
    expect(names).toContain("describe_operations");
    expect(names).toContain("call_operation");
    for (const hidden of coreRegistry.list().filter((op) => op.mcp?.expose === false)) {
      expect(names).not.toContain(hidden.name.replace(/\./g, "_"));
    }

    const described = await call(client, "describe_operations", { includeSchemas: false });
    const listed = (described.data.operations as { name: string }[]).map((o) => o.name);
    expect(listed).toContain("person.merge");
    for (const hidden of ["person.erase", "user.updateRole", "trash.purge", "policy.update"]) {
      expect(listed).not.toContain(hidden);
      const attempt = await call(client, "call_operation", {
        name: hidden,
        input: {},
        reason: "test",
      });
      expect(attempt.isError).toBe(true);
      expect(attempt.data).toMatchObject({ error: { code: "unknown_operation" } });
    }

    const schema = await client.readResource({ uri: "crm://schema" });
    const doc = JSON.parse((schema.contents[0] as { text: string }).text);
    expect(doc.objects.map((o: { name: string }) => o.name)).toContain("person");
    expect(
      doc.operations.find((o: { name: string }) => o.name === "person.updateMany"),
    ).toMatchObject({
      risk: "bulk-write",
    });
    expect(client.getInstructions()).toMatch(/Search before you create/);
  });

  it("requires a reason for reviewable tools", async () => {
    const tokens = await connect(fetchApp, member);
    const client = await mcpClient(fetchApp, tokens.access_token);
    const result = await call(client, "person_create", { displayName: unique("NoReason") });
    expect(result.isError).toBe(true);
    expect(result.data).toMatchObject({ error: { code: "invalid_input" } });
  });
});
