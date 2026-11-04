// Stage 6b, AC5 (webhooks trigger automations): an admin turns on Inbound webhooks, creates the org
// connection and an endpoint through the picker (with a known signing secret). An extension's
// automation triggers on that endpoint's `invoice.paid` events and creates a task from the
// payload. A badly signed delivery is refused; a correctly signed one is stored, the minute cron
// (driven here through the dev-only route, as local dev has no cron ticks) turns it into a run,
// and the run shows in the automation's run history as completed, with its task created.
import { expect, test } from "@playwright/test";
import { connectAdminApp, extensionId, writeCheckPropose } from "./extension-authoring.ts";
import { expectNoHorizontalScroll, open, unique } from "./helpers.ts";
import {
  addWebhookEndpoint,
  postWebhook,
  runMinuteCron,
  webhookConnection,
} from "./integration-helpers.ts";

const LABEL = "Invoice paid → task";

function webhookSource(id: string, endpoint: string): string {
  return `import { defineAutomation, defineExtension } from "@crm/sdk";

// Written over MCP by the stage 6b webhook e2e spec.
export default defineExtension({
  id: "${id}",
  version: "1.0.0",
  contractVersion: 1,
  label: "Billing hooks",
  description: "Turns paid invoices from the billing system into tasks.",
  permissions: { read: ["task"], write: ["task"], modules: ["crm"] },
  automations: {
    invoicePaid: defineAutomation({
      label: "${LABEL}",
      description: "When billing says an invoice was paid, a task to thank the customer.",
      trigger: { type: "webhook", endpoint: "${endpoint}", events: ["invoice.paid"] },
      steps: [{ name: "thank", writes: [{ object: "task" }] }],
      async run(event, step, ctx) {
        const body = (event.integration?.payload as { payload?: { invoice?: string } } | null)?.payload;
        return step.do("thank", () =>
          ctx.crm.call("task.create", { title: "Thank for invoice " + String(body?.invoice) }),
        );
      },
    }),
  },
});
`;
}

test("a signed webhook delivery runs the automation it triggers", async ({
  page,
  request,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const token = unique();
  const endpointId = `billing-${token}`.toLowerCase();
  const secret = `e2e-secret-${token}`;
  const invoice = `INV-${token}`;

  // The org webhook connection and an endpoint with a known secret.
  const connection = await webhookConnection(page);
  await addWebhookEndpoint(page, connection, endpointId, secret);

  // An automation on that endpoint, approved.
  const app = await connectAdminApp(page, baseURL ?? "");
  const id = extensionId("hook");
  const automationId = `${id}.invoicePaid`;
  const proposal = await writeCheckPropose(
    app,
    id,
    { "index.ts": webhookSource(id, endpointId) },
    "Tasks for paid invoices",
  );
  await open(page, "/approvals");
  const set = page.locator(`[data-change-set="${proposal.changeSetId}"]`);
  await set.getByRole("button", { name: "Approve" }).click();
  await expect(set.getByTestId("decision-result")).toHaveText(/Applied 1 change/);

  // Its page reads the webhook trigger in words and in the diagram.
  await open(page, `/automations/${automationId}`);
  await expect(page.getByTestId("automation-status")).toHaveText("Active");
  await expect(page.getByTestId("automation-summary")).toContainText(
    `When the ${endpointId} webhook receives an invoice.paid event`,
  );
  const trigger = page.getByTestId("diagram-node").first();
  await expect(trigger).toHaveAttribute("data-kind", "trigger");
  await expect(trigger).toContainText(`Webhook · ${endpointId} · invoice.paid`);
  await expect(trigger).toContainText("signature checked");
  await expectNoHorizontalScroll(page);

  // A bad signature is refused; a good one is accepted.
  expect(await postWebhook(request, endpointId, "wrong-secret", "invoice.paid", { invoice })).toBe(
    401,
  );
  expect(await postWebhook(request, endpointId, secret, "invoice.paid", { invoice })).toBe(200);

  // The minute cron turns the stored event into a run (the event reaches the CRM through the
  // endpoint's hook, asynchronously: tick until it has been dispatched).
  await expect
    .poll(async () => (await runMinuteCron(request)).integrationEvents?.dispatched ?? 0, {
      timeout: 60_000,
      intervals: [1_000, 2_000, 3_000],
    })
    .toBeGreaterThan(0);

  // Run history: the webhook run, completed.
  await expect(async () => {
    await open(page, `/automations/${automationId}?tab=runs`);
    const run = page.getByTestId("run-item").first();
    await expect(run).toContainText("Webhook · invoice.paid", { timeout: 5_000 });
    await expect(run.getByTestId("run-outcome")).toHaveAttribute("data-tone", "ok", {
      timeout: 5_000,
    });
  }).toPass({ timeout: 90_000, intervals: [2_000, 5_000] });
  await page.getByTestId("run-item").first().click();
  const detail = page.getByTestId("run-detail");
  await expect(detail).toContainText("Completed");
  await expect(detail).toContainText("webhook · invoice.paid");

  // Its effect: the task.
  const filter = { field: "title", op: "eq", value: `Thank for invoice ${invoice}` };
  await open(page, `/tasks?tab=all&filter=${encodeURIComponent(JSON.stringify(filter))}`);
  await expect(page.getByText(`Thank for invoice ${invoice}`).first()).toBeVisible({
    timeout: 15_000,
  });
});
