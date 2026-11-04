// Connecting an MCP client to the dev server the way Claude does: dynamic client registration,
// the consent page in the browser (signed in as the e2e user), a PKCE code exchange, then the MCP
// TypeScript client on /mcp. Specs use it to queue real change sets for the Approvals inbox.
import { createHash, randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, type Page } from "@playwright/test";
import { unique } from "./helpers.ts";

/** Never served: the spec reads the code from the browser's redirect to it. */
const REDIRECT = "http://localhost:5999/e2e-callback";

export interface ConnectedApp {
  name: string;
  accessToken: string;
  client: Client;
}

const base64url = (bytes: Buffer) => bytes.toString("base64url");

/** Registers `name`, consents in the browser (checking the page renders), and connects. */
export async function connectApp(
  page: Page,
  baseURL: string,
  name = `E2E Claude ${unique()}`,
): Promise<ConnectedApp> {
  const registered = await fetch(`${baseURL}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(registered.ok, await registered.clone().text()).toBe(true);
  const { client_id: clientId } = (await registered.json()) as { client_id: string };

  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const resource = `${baseURL}/mcp`;
  const consent = new URL("/oauth/consent", baseURL);
  consent.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: "read write",
    state: "e2e",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
  }).toString();

  await page.goto(consent.toString());
  await expect(page.getByRole("heading", { name: `Connect ${name} to the CRM?` })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Read/ })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /Write/ })).toBeChecked();
  // Nothing listens on the redirect URI: read the code off the redirected request.
  const callback = page.waitForRequest((request) => request.url().startsWith(REDIRECT));
  await page.getByRole("button", { name: "Allow" }).click();
  const code = new URL((await callback).url()).searchParams.get("code");
  expect(code).toBeTruthy();

  const token = await fetch(`${baseURL}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code ?? "",
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource,
    }),
  });
  expect(token.ok, await token.clone().text()).toBe(true);
  const { access_token: accessToken } = (await token.json()) as { access_token: string };
  return { name, accessToken, client: await mcpClient(baseURL, accessToken) };
}

export async function mcpClient(baseURL: string, accessToken: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: "crm-e2e", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/** Calls a tool and parses its JSON result; tool errors throw. */
export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text?: string }[];
  };
  const text = result.content.find((c) => c.type === "text")?.text ?? "null";
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

export interface SeededSet {
  app: ConnectedApp;
  title: string;
  changeSetId: string;
  /** Two people, created (applied) by the agent. */
  people: { id: string; name: string }[];
  /** Pending: tag both people (bulk-write). */
  tagActionId: string;
  tag: string;
  /** Pending: delete the first person (destructive); depends on the tag action. */
  deleteActionId: string;
}

/**
 * Under the default Balanced policy: the agent creates two people (applied at once), then in a
 * titled change set tags both (bulk-write, queued) and deletes the first (destructive, queued,
 * depending on the tag action because it touches the same record).
 */
export async function seedChangeSet(page: Page, baseURL: string): Promise<SeededSet> {
  const app = await connectApp(page, baseURL);
  const token = unique();
  const people = [];
  for (const given of ["Ada", "Grace"]) {
    const name = `${given} Pending${token}`;
    const created = await call(app.client, "person_create", {
      displayName: name,
      reason: "Met at the Sydney event",
    });
    const id = String(created.id ?? "");
    if (!/^per_[0-9A-Z]+$/.test(id)) {
      throw new Error(
        `person_create did not apply (is the approval policy Balanced?): ${JSON.stringify(created)}`,
      );
    }
    people.push({ id, name });
  }
  const title = `Tidy the Sydney import ${token}`;
  const begun = await call(app.client, "changeset_begin", { title });
  const tag = `sydney-${token}`.toLowerCase();
  const tagged = await call(app.client, "call_operation", {
    name: "person.updateMany",
    input: { ids: people.map((p) => p.id), addTags: [tag] },
    reason: "Tag everyone from the event list",
  });
  expect(tagged.status).toBe("pending_approval");
  const deleted = await call(app.client, "call_operation", {
    name: "person.deleteMany",
    input: { ids: [people[0]?.id] },
    reason: "Duplicate created by the CSV import",
  });
  expect(deleted.status).toBe("pending_approval");
  expect(deleted.dependsOn).toEqual([tagged.actionId]);
  await call(app.client, "changeset_commit", {});
  return {
    app,
    title,
    changeSetId: String(begun.changeSetId),
    people,
    tagActionId: String(tagged.actionId),
    tag,
    deleteActionId: String(deleted.actionId),
  };
}
