// Stage 11, AC 5 (authoring.intent): an MCP client proposes an automation together with the
// request it was written for; the approval screen shows the check against that request, labelled
// as the client reported it, with a finding code wrote from the manifest. Local dev has no Jev
// key, so the dev stand-in judge answers (AI_FAKE_MODEL: a keyword rule that flags a recipient
// the request does not name); production asks Jev, calibrated in evals/judge.
import { expect, test } from "@playwright/test";
import { connectAdminApp, extensionId } from "./extension-authoring.ts";
import { expectNoHorizontalScroll, open } from "./helpers.ts";
import { call } from "./mcp.ts";

const REQUEST = "When an organisation is created, notify the admins.";

/** Notifies the owner's manager: not the admins the request names. */
function source(id: string): string {
  return `import { defineAutomation, defineExtension } from "@relationship-os/sdk";

// Written over MCP by the stage 11 intent-check e2e spec.
export default defineExtension({
  id: "${id}",
  version: "1.0.0",
  contractVersion: 1,
  label: "Intent check test",
  description: "Tells someone about new organisations.",
  permissions: { read: ["organisation"], operations: ["notification.send"], modules: ["crm"] },
  automations: {
    newOrg: defineAutomation({
      label: "New organisation",
      description: "Notify about a new organisation.",
      trigger: { type: "record", object: "organisation", on: ["created"] },
      steps: [{ name: "tell", notifies: [{ to: { managerOf: "ownerId" }, message: "New: {record}" }] }],
      async run(_event, step) {
        await step.do("tell", () => null);
      },
    }),
  },
});
`;
}

test("a proposal shows its check against the request, with the finding", async ({
  page,
  baseURL,
}) => {
  const app = await connectAdminApp(page, baseURL ?? "");
  const id = extensionId("int");
  const files = { "index.ts": source(id) };
  await call(app.client, "extension_write", { id, files, reason: "Tell the admins" });

  // The check passes; the finding is a warning, not an error.
  const check = await call(app.client, "extension_check", { id, request: REQUEST });
  expect(check.ok).toBe(true);
  expect(check.issues).toEqual([
    expect.objectContaining({ code: "intent/recipients", severity: "warning" }),
  ]);

  const proposed = await call(app.client, "extension_propose", {
    id,
    request: REQUEST,
    reason: "Tell the admins",
  });
  expect(proposed.status, JSON.stringify(proposed)).toBe("pending_approval");

  await open(page, "/approvals");
  const item = page.locator(`[data-action="${String(proposed.actionId)}"]`);
  const intent = item.getByTestId("intent-check");
  await expect(intent).toContainText("Checked against the request");
  await expect(intent).toContainText("as the client reported it");
  await expect(intent).toContainText(REQUEST);
  await expect(intent.getByTestId("intent-finding")).toHaveText(
    "It notifies the owner's manager, which may not be who the request asks to notify.",
  );
  await expectNoHorizontalScroll(page);
});
