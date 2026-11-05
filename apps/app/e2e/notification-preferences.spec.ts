// Stage 6b, AC6 (notification delivery per preference): an admin connects a fake outbox for the
// org and picks it under Settings → Notifications → Delivery. The user turns on email for
// "Approvals waiting". An agent's change then waits for approval: the minute cron (driven through
// the dev-only route, as local dev has no cron ticks) sends that notice by email, which as an
// outbound action under Balanced waits in Approvals; approved, the fake outbox has sent it to the
// user. With email turned off again, the next notice stays in-app: nothing goes out.
import { expect, type Page, test } from "@playwright/test";
import { expectNoHorizontalScroll, open, unique } from "./helpers.ts";
import {
  addFakeResource,
  connectFake,
  fakeAddress,
  openIntegrations,
  runMinuteCron,
  sentMail,
} from "./integration-helpers.ts";
import { type ConnectedApp, call, connectApp } from "./mcp.ts";
import { TEST_USER } from "./test-user.ts";

/** The agent creates a person and asks to delete it: the delete waits for approval. */
async function queueApproval(app: ConnectedApp, token: string): Promise<void> {
  const created = await call(app.client, "person_create", {
    displayName: `Notify Pending${token}`,
    reason: "Notification preference e2e",
  });
  const deleted = await call(app.client, "call_operation", {
    name: "person.deleteMany",
    input: { ids: [String(created.id ?? "")] },
    reason: "Notification preference e2e",
  });
  expect(deleted.status).toBe("pending_approval");
}

/** Picks the email connection on the Delivery page (null: Off) and saves. */
async function setEmailDelivery(page: Page, address: string | null): Promise<void> {
  await open(page, "/settings/notification-delivery");
  await expect(
    page.getByRole("heading", { level: 1, name: "Notification delivery" }),
  ).toBeVisible();
  await page.getByLabel("Email connection").click();
  await page
    .getByRole(
      "option",
      address ? { name: new RegExp(address.replace(/[.]/g, "\\.")) } : { name: "Off" },
    )
    .click();
  const saveBar = page.getByTestId("save-bar");
  if (await saveBar.isVisible()) {
    await saveBar.getByRole("button", { name: "Save" }).click();
    await expect(saveBar).toHaveCount(0);
  }
}

/** Sets "Approvals waiting by Email" on Settings → Notifications. */
async function setApprovalEmail(page: Page, on: boolean): Promise<void> {
  await open(page, "/settings/notifications");
  const box = page.getByRole("checkbox", { name: "Approvals waiting by Email" });
  await expect(box).toBeEnabled();
  if ((await box.getAttribute("aria-checked")) !== String(on)) await box.click();
  await expect(box).toHaveAttribute("aria-checked", String(on));
}

/** The pending outbound email whose subject is `subject`, in the Approvals inbox. */
function outboundEmail(page: Page, subject: string) {
  return page
    .getByTestId("pending-action")
    .filter({ has: page.getByTestId("outbound-preview").filter({ hasText: subject }) });
}

test("a notification preference is honoured", async ({ page, request, baseURL }) => {
  test.setTimeout(300_000);
  const address = fakeAddress("notify");

  // The org outbox and the delivery setting.
  await openIntegrations(page);
  const connection = await connectFake(page, address, "org");
  await addFakeResource(page, connection, "Outbox", address);
  await setEmailDelivery(page, address);
  await expect(page.getByTestId("auto-approve-hint")).toContainText(
    "Outbound action auto-approval",
  );
  await expectNoHorizontalScroll(page);

  try {
    // The user's preference: approvals waiting also by email.
    await setApprovalEmail(page, true);
    await expect(page.getByTestId("notification-preferences")).not.toContainText(
      "Email is not set up yet",
    );
    await expectNoHorizontalScroll(page);

    // An agent's change waits for approval: its notice goes out by email (an outbound action,
    // waiting in Approvals under Balanced). Delivery lags 30 s behind writes.
    const first = await connectApp(page, baseURL ?? "", `E2E notify ${unique()}`);
    await queueApproval(first, unique());
    const subject = `${first.name} is waiting for your approval`;
    await expect(async () => {
      await runMinuteCron(request);
      await open(page, "/approvals");
      await expect(outboundEmail(page, subject)).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 120_000, intervals: [5_000, 10_000] });
    const action = outboundEmail(page, subject);
    await expect(action.getByTestId("outbound-fields")).toContainText(TEST_USER.email);
    const set = page.getByTestId("change-set").filter({ has: action });
    await set.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(set.getByTestId("decision-result")).toContainText("Applied 1 change");
    await expect
      .poll(async () => (await sentMail(request, address)).map((m) => m.subject))
      .toContain(`[CRM] ${subject}`);
    const sent = (await sentMail(request, address)).find((m) => m.subject === `[CRM] ${subject}`);
    expect(sent?.to).toEqual([TEST_USER.email]);

    // Email off again: the next notice stays in-app.
    await setApprovalEmail(page, false);
    const second = await connectApp(page, baseURL ?? "", `E2E quiet ${unique()}`);
    await queueApproval(second, unique());
    const quiet = `${second.name} is waiting for your approval`;
    await page.waitForTimeout(32_000);
    await runMinuteCron(request);
    await runMinuteCron(request);
    await open(page, "/approvals");
    await expect(page.getByTestId("change-set").first()).toBeVisible();
    await expect(outboundEmail(page, quiet)).toHaveCount(0);
    expect((await sentMail(request, address)).map((m) => m.subject)).not.toContain(
      `[CRM] ${quiet}`,
    );
  } finally {
    // Leave delivery off for the other specs.
    await setEmailDelivery(page, null);
  }
});
