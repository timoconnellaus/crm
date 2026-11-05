// Stage 6b, AC4 (automation run-as): an automation declares a connection it needs. Its proposal
// says so; after approving, the approver picks one of their connections, with the consent spelled
// out ("Allow … to use … as you"), and the automation becomes active. The automation page's
// Permissions card shows the consent (who allowed it, when); Revoke, confirmed, pauses it as
// "Waiting for connections" and offers the picker again.
import { expect, test } from "@playwright/test";
import { connectAdminApp, extensionId, writeCheckPropose } from "./extension-authoring.ts";
import { expectNoHorizontalScroll, open, unique } from "./helpers.ts";
import { connectFake, FAKE_TITLE, fakeAddress, openIntegrations } from "./integration-helpers.ts";

const LABEL = "Welcome email";

/** An extension whose automation needs a fake-provider connection (it never fires here). */
function runAsSource(id: string, endpoint: string): string {
  return `import { defineAutomation, defineExtension } from "@crm/sdk";

// Written over MCP by the stage 6b run-as e2e spec.
export default defineExtension({
  id: "${id}",
  version: "1.0.0",
  contractVersion: 1,
  label: "Run-as test",
  description: "An automation that sends mail through a connection it is allowed to use.",
  permissions: { read: ["person"], modules: ["crm", "fake"] },
  automations: {
    welcome: defineAutomation({
      label: "${LABEL}",
      description: "When the endpoint receives an event, look at the mailbox.",
      trigger: { type: "webhook", endpoint: "${endpoint}" },
      connections: [{ id: "mailbox", gatekeeper: "fake", purpose: "Send the welcome email" }],
      steps: [{ name: "look" }],
      async run(event, step) {
        return step.do("look", () => ({ seen: event.integration?.type ?? null }));
      },
    }),
  },
});
`;
}

test("bind a connection when approving an automation, see the consent, and revoke it", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(150_000);
  const address = fakeAddress("runas");
  await openIntegrations(page);
  await connectFake(page, address);

  const app = await connectAdminApp(page, baseURL ?? "");
  const id = extensionId("ras");
  const automationId = `${id}.welcome`;
  const proposal = await writeCheckPropose(
    app,
    id,
    { "index.ts": runAsSource(id, `runas-${unique()}`.toLowerCase()) },
    "Send a welcome email",
  );

  // The proposal says which connection it needs and why.
  await open(page, "/approvals");
  const set = page.locator(`[data-change-set="${proposal.changeSetId}"]`);
  const item = set.locator(`[data-action="${proposal.actionId}"]`);
  await expect(item.getByTestId("declared-connection")).toContainText(
    `Needs a ${FAKE_TITLE} connection (mailbox): Send the welcome email`,
  );
  await set.getByRole("button", { name: "Approve" }).click();
  await expect(set.getByTestId("decision-result")).toHaveText(/Applied 1 change/);

  // After approval: allow it to use my connection, with the consent spelled out.
  const binding = item.locator(
    `[data-testid=automation-binding][data-automation="${automationId}"]`,
  );
  await expect(binding.getByTestId("binding-state")).toHaveText("1 connection to allow");
  const binder = binding.getByTestId("connection-binder");
  // Pick the new connection (earlier runs left other fake connections in the shared database).
  await binder.getByRole("combobox", { name: "Connection for mailbox" }).click();
  await page.getByRole("option", { name: `${FAKE_TITLE} · ${address}` }).click();
  await expect(binder.getByTestId("consent-text")).toHaveText(
    `Allow “${LABEL}” to use ${FAKE_TITLE} · ${address} as you?`,
  );
  await expectNoHorizontalScroll(page);
  await binder.getByRole("button", { name: "Allow" }).click();
  await expect(binding.getByTestId("binding-state")).toHaveText("All connections allowed · active");

  // The automation page: active, and the Permissions card records the consent.
  await open(page, `/automations/${automationId}`);
  await expect(page.getByTestId("automation-status")).toHaveText("Active");
  await expect(page.getByTestId("connections-banner")).toHaveCount(0);
  const card = page.getByTestId("card-permissions");
  const slot = card.locator('[data-testid=connection-slot][data-slot="mailbox"]');
  await expect(slot).toHaveAttribute("data-bound", "true");
  await expect(slot.getByTestId("connection-binding")).toContainText(`Uses ${FAKE_TITLE} as you`);
  await expect(slot.getByTestId("connection-consent")).toContainText("Allowed by you");
  await expectNoHorizontalScroll(page);

  // Revoke, confirmed: it pauses, waiting for connections, and offers the picker again.
  await slot.getByRole("button", { name: "Revoke mailbox" }).click();
  const confirm = page.getByRole("alertdialog", { name: `Revoke ${FAKE_TITLE}?` });
  await confirm.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByTestId("automation-status")).toHaveText("Paused");
  const banner = page.getByTestId("connections-banner");
  await expect(banner).toContainText("Waiting for connections");
  await expect(slot).toHaveAttribute("data-bound", "false");
  await expect(slot.getByTestId("connection-revoked")).toContainText("revoked");
  await expect(slot.getByTestId("connection-binder")).toBeVisible();
});
