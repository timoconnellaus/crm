// Writing extensions over MCP for the stage 3b specs: an MCP client connected with the admin scope
// writes a "Projects" extension into the workspace, checks it and proposes it for approval.
import { expect, type Page } from "@playwright/test";
import { unique } from "./helpers.ts";
import { type ConnectedApp, call, connectApp } from "./mcp.ts";

/** A fresh extension id (lowercase letters and digits). */
export function extensionId(prefix = "prj"): string {
  return `${prefix}${unique()}`
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 30);
}

/**
 * The AC6 "Projects" extension: an object linked to Organisations, with a status select, a budget
 * currency and a formula field. `extraField` adds a field (v2).
 */
export function projectsSource(id: string, version = "1.0.0", extraField = ""): string {
  return `import { defineExtension } from "@relationship-os/sdk";

// Projects for organisations, written over MCP by the stage 3b end-to-end spec.
export default defineExtension({
  id: "${id}",
  version: "${version}",
  contractVersion: 1,
  label: "Projects",
  description: "Projects linked to organisations, with a status and a budget.",
  permissions: { read: ["organisation"], modules: ["crm"] },
  objects: {
    project: {
      label: "Project",
      plural: "Projects",
      icon: "folder-kanban",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name", required: true },
        organisation: { type: "relation", label: "Organisation", to: "organisation" },
        status: {
          type: "select",
          label: "Status",
          options: [
            { value: "planned", label: "Planned" },
            { value: "active", label: "Active" },
            { value: "done", label: "Done" },
          ],
        },
        budget: { type: "currency", label: "Budget", currency: "AUD" },
        openBudget: {
          type: "formula",
          label: "Open budget",
          expression: 'if(status = "done", 0, coalesce(budget, 0))',
        },${extraField}
      },
    },
  },
});
`;
}

export interface Proposal {
  actionId: string;
  changeSetId: string;
  commit: string;
}

/** Writes `files`, checks the working copy (must pass) and proposes it. */
export async function writeCheckPropose(
  app: ConnectedApp,
  id: string,
  files: Record<string, string>,
  message: string,
): Promise<Proposal> {
  await call(app.client, "extension_write", { id, files, reason: message });
  const check = await call(app.client, "extension_check", { id });
  expect(check.issues).toEqual([]);
  expect(check.ok).toBe(true);
  const proposed = await call(app.client, "extension_propose", { id, message, reason: message });
  expect(proposed.status, JSON.stringify(proposed)).toBe("pending_approval");
  return {
    actionId: String(proposed.actionId),
    changeSetId: String(proposed.changeSetId),
    commit: String(proposed.commit),
  };
}

/** An MCP client with the admin scope (authoring needs extensions:manage). */
export function connectAdminApp(page: Page, baseURL: string): Promise<ConnectedApp> {
  return connectApp(page, baseURL, `E2E agent ${unique()}`, ["read", "write", "admin"]);
}
