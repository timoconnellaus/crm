// /oauth/consent renders as the app does (its one script allowed by hash, nothing else) and keeps
// the form fields the OAuth flow relies on.
import { describe, expect, it } from "vitest";
import { appFor, openConsent, registerClient, signUp, testEnv } from "./mcp-helpers.ts";

const mcpEnv = testEnv();
const fetchApp = appFor(mcpEnv);

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

describe("consent page", () => {
  it("shows the client, the user and the scopes, with only a hashed theme script", async () => {
    const member = await signUp(mcpEnv, "member");
    const clientId = await registerClient(fetchApp, "Claude Desktop");
    const page = await openConsent(fetchApp, member, clientId, "x".repeat(43), "read write");
    expect(page.response.status).toBe(200);
    expect(page.html).toContain("Connect Claude Desktop to Relationship OS?");
    expect(page.html).toContain(member.email);
    expect(page.html).toMatch(/name="scope" value="read" checked disabled/);
    expect(page.html).toMatch(/name="scope" value="write" checked/);
    expect(page.html).not.toMatch(/value="admin"/);
    expect(page.html).toMatch(/name="decision" value="allow"/);
    expect(page.html).toMatch(/name="decision" value="deny"/);
    expect(page.html).toContain('name="viewport"');

    const scripts = [...page.html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts).toHaveLength(1);
    const csp = page.response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain(`script-src 'sha256-${await sha256(scripts[0] ?? "")}'`);
    expect(csp).toContain("default-src 'none'");
  });
});
