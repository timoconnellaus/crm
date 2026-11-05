// Vendored from cloudflare/cloudflare-os@a3ba4746b58f packages/gatekeeper-mcp/src/resources.ts (Apache-2.0). Modified locally: see UPSTREAM.md in this package.
import type { SupportedResource } from "@relationship-os/gatekeeper-interface/gatekeeper";

const DESCRIPTION =
  "An MCP endpoint you supply. Tools are discovered automatically, and writes need approval.";

const HTTPS_RESOURCE: SupportedResource = {
  urlPattern: "https://*",
  title: "Any MCP server",
  description: DESCRIPTION,
};

const HTTP_RESOURCE: SupportedResource = { ...HTTPS_RESOURCE, urlPattern: "http://*" };

export function mcpResources(allowInsecure: boolean): SupportedResource[] {
  return allowInsecure ? [HTTPS_RESOURCE, HTTP_RESOURCE] : [HTTPS_RESOURCE];
}

export function mcpResourceFor(endpoint: string): SupportedResource {
  return new URL(endpoint).protocol === "http:" ? HTTP_RESOURCE : HTTPS_RESOURCE;
}
