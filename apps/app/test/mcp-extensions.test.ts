// Extension tools over MCP: installed `x.<ext>.<tool>` operations appear in describe_operations
// and crm://schema, run through call_operation (here against a stub runtime; the real one is
// tested in apps/runner), and a write tool goes through the approval queue like any operation.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  appFor,
  call,
  connect,
  mcpClient,
  setPreset,
  signUp,
  type TestUser,
  testEnv,
} from "./mcp-helpers.ts";

const mcpEnv = testEnv();
const fetchApp = appFor(mcpEnv);
let member: TestUser;

const manifest = {
  id: "stubby",
  version: "1.0.0",
  contractVersion: 1,
  permissions: { read: [], write: [], operations: [], modules: [] },
  objects: {},
  fields: {},
  views: {},
  automations: {},
  tools: {
    echo: {
      description: "Echo the input back, to test extension tools over MCP. Read-only.",
      risk: "read",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      outputSchema: {},
    },
    poke: {
      description: "Pretend to change something, to test review of extension tools.",
      risk: "write",
      inputSchema: { type: "object", properties: {} },
      outputSchema: {},
    },
  },
};

beforeAll(async () => {
  member = await signUp(mcpEnv, "member");
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at, kind) VALUES ('extension:stubby', 'Stubby', 'stubby@extensions.crm.invalid', 0, ?, ?, 'extension')",
    ).bind(now, now),
    env.DB.prepare(
      "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES ('stubby', 'runtime', 'active', '1.0.0', 'abc123', ?, 'extension:stubby', ?, ?)",
    ).bind(JSON.stringify(manifest), now, now),
  ]);
});

describe("extension tools over MCP", () => {
  it("lists them in describe_operations and the schema resource", async () => {
    const tokens = await connect(fetchApp, member);
    const client = await mcpClient(fetchApp, tokens.access_token);
    const described = await call(client, "describe_operations", { query: "echo" });
    const ops = described.data.operations as { name: string; risk: string; inputSchema: unknown }[];
    expect(ops.map((o) => o.name)).toEqual(["x.stubby.echo"]);
    expect(ops[0]?.inputSchema).toMatchObject({ properties: { text: { type: "string" } } });
    const schema = await client.readResource({ uri: "crm://schema" });
    const doc = JSON.parse((schema.contents[0] as { text: string }).text);
    expect(doc.operations.map((o: { name: string }) => o.name)).toContain("x.stubby.poke");
  });

  it("runs them with call_operation, validating input first", async () => {
    await setPreset("balanced");
    const tokens = await connect(fetchApp, member);
    const client = await mcpClient(fetchApp, tokens.access_token);
    const result = await call(client, "call_operation", {
      name: "x.stubby.echo",
      input: { text: "hi" },
    });
    expect(result.isError).toBe(false);
    expect(result.data).toEqual({ tool: "echo", input: { text: "hi" }, caller: "mcp" });
    const invalid = await call(client, "call_operation", { name: "x.stubby.echo", input: {} });
    expect(invalid.data).toMatchObject({ error: { code: "invalid_input" } });
  });

  it("queues a reviewed write tool for approval", async () => {
    await setPreset("cautious");
    const tokens = await connect(fetchApp, member);
    const client = await mcpClient(fetchApp, tokens.access_token);
    const result = await call(client, "call_operation", {
      name: "x.stubby.poke",
      input: {},
      reason: "Testing review of extension tools",
    });
    expect(result.data).toMatchObject({ status: "pending_approval", operation: "x.stubby.poke" });
    await setPreset("balanced");
  });
});
