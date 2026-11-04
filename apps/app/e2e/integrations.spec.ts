// Settings → Integrations (stage 6a): enable the dev-only fake provider, connect a personal
// connection through the real OAuth popup, add its mailbox through the resource picker, change
// the sharing level, and disconnect.
import { expect, test } from "@playwright/test";
import { expectNoHorizontalScroll } from "./helpers.ts";
import {
  addFakeResource,
  connectFake,
  fakeAddress,
  openIntegrations,
} from "./integration-helpers.ts";

test("connect, add a mailbox, set the sharing level and disconnect", async ({ page }) => {
  const address = fakeAddress("connect");
  await openIntegrations(page);
  await expectNoHorizontalScroll(page);

  const connection = await connectFake(page, address);
  await expect(
    connection.getByRole("heading", { name: "Fake provider (development)" }),
  ).toBeVisible();
  await expect(connection.getByTestId("connection-status")).toHaveText("Active");
  await expect(connection).toContainText("Personal");

  await addFakeResource(page, connection, "Mailbox", address);
  const resource = connection.getByTestId("connection-resource");
  await expect(resource).toContainText("Mailbox");
  // The mailbox is offered to sync.
  await expect(connection.getByLabel("Mailbox to sync")).toBeVisible();

  // Sharing level: metadata by default, full content on request.
  const sharing = connection.getByLabel("Sharing level");
  await expect(sharing).toContainText("Metadata only");
  await sharing.click();
  await page.getByRole("option", { name: "Full content" }).click();
  await expect(page.getByText("Sharing level: Full content")).toBeVisible();
  await expect(sharing).toContainText("Full content");
  await expectNoHorizontalScroll(page);

  // Remove the resource again.
  await connection.getByRole("button", { name: /^Remove / }).click();
  await expect(resource).toHaveCount(0);

  // Disconnect, confirmed.
  await connection.getByRole("button", { name: "Disconnect Fake provider (development)" }).click();
  const confirm = page.getByRole("alertdialog", {
    name: "Disconnect Fake provider (development)?",
  });
  await confirm.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByText("Disconnected Fake provider (development)")).toBeVisible();
  await expect(connection).toHaveCount(0);

  // It is still listed with "Show disconnected".
  await page.getByLabel("Show disconnected").check();
  await expect(connection).toHaveAttribute("data-status", "disconnected");
});
