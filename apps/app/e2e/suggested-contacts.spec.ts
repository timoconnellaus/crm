// Email sync and Suggested contacts (stage 6a, ADR 0052): a fake mailbox syncs; an unknown
// external sender seen twice is suggested under their domain and added in one click; mail from a
// known person lands on their timeline as a synced email, which its owner can mark private.
import { expect, test } from "@playwright/test";
import { createPerson, expectNoHorizontalScroll, open, pressUntil, unique } from "./helpers.ts";
import {
  addFakeResource,
  connectFake,
  connectionCard,
  fakeAddress,
  openIntegrations,
  seedMail,
} from "./integration-helpers.ts";

test("synced mail suggests a contact, who is added in one click", async ({ page, request }) => {
  const token = unique();
  const address = fakeAddress("sync");
  const domain = `fresh-${token}.test`.toLowerCase();
  const stranger = { email: `stella@${domain}`, name: `Stella Stranger${token}` };
  const knownEmail = `known-${token}@known-${token}.test`.toLowerCase();
  const knownName = `Kim Known${token}`;

  // A known person, created through the UI.
  const knownId = await createPerson(page, {
    given: "Kim",
    family: `Known${token}`,
    email: knownEmail,
  });

  // Connect a mailbox and sync it.
  await openIntegrations(page);
  const connection = await connectFake(page, address);
  await addFakeResource(page, connection, "Mailbox", address);
  await connection.getByLabel("Mailbox to sync").click();
  await page.getByRole("option", { name: /Mailbox/ }).click();
  await connection.getByRole("button", { name: "Save sync settings" }).click();
  await expect(page.getByText("Sync settings saved")).toBeVisible();

  // Two messages from the stranger, one from the known person.
  const now = Date.now();
  const message = (n: number, from: { email: string; name?: string }, subject: string) => ({
    id: `m-${token}-${n}`,
    messageId: `<m-${token}-${n}@e2e.test>`,
    from,
    to: [{ email: address }],
    subject,
    text: `Hello from ${from.email} (${n})`,
    sentAt: new Date(now - n * 60_000).toISOString(),
  });
  await seedMail(request, address, [
    message(1, stranger, `Intro ${token}`),
    message(2, stranger, `Follow-up ${token}`),
    message(3, { email: knownEmail, name: knownName }, `Catch up ${token}`),
  ]);

  await connectionCard(page, address).getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByText("Synced", { exact: true })).toBeVisible();
  await expect(connection.getByTestId("sync-status-mail")).toContainText("added");

  // The stranger is suggested under their domain.
  await open(page, "/suggested-contacts");
  await expect(page.getByRole("heading", { level: 1, name: "Suggested contacts" })).toBeVisible();
  const group = page.locator(`[data-testid=suggested-domain][data-domain="${domain}"]`);
  await expect(group).toBeVisible();
  await expect(group).toContainText("No organisation");
  const contact = group.getByTestId("suggested-contact");
  await expect(contact).toHaveCount(1);
  await expect(contact).toContainText(stranger.name);
  await expect(contact).toContainText("2 messages");
  // The known person is not suggested.
  await expect(
    page.locator(`[data-testid=suggested-contact][data-email="${knownEmail}"]`),
  ).toHaveCount(0);
  await expectNoHorizontalScroll(page);

  // Add them (with a new organisation for the domain): they leave the inbox.
  await expect(group.getByLabel(`Create an organisation for ${domain}`)).toBeChecked();
  await group.getByRole("button", { name: "Add selected (1)" }).click();
  await expect(page.getByText(`Added 1 person from ${domain}`)).toBeVisible();
  await expect(group).toHaveCount(0);

  // They exist as a person.
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await pressUntil(page, "ControlOrMeta+k", palette);
  await page.keyboard.type(stranger.name);
  const hit = page.getByRole("option", { name: new RegExp(stranger.name) });
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(stranger.name);

  // The known person's email is on their timeline, synced; its owner can mark it private.
  await open(page, `/people/${knownId}?tab=timeline`);
  const entry = page.locator("[data-activity-type=email]").filter({ hasText: `Catch up ${token}` });
  await expect(entry).toBeVisible();
  await expect(entry.getByTestId("synced-markers")).toContainText("Synced");
  await expect(entry.getByTestId("synced-markers")).toContainText("Metadata only");
  await entry.getByRole("button", { name: `Sharing options for Catch up ${token}` }).click();
  await page.getByRole("menuitem", { name: "Mark private" }).click();
  await expect(entry.getByTestId("synced-markers")).toContainText("Private");
  await entry.getByRole("button", { name: `Sharing options for Catch up ${token}` }).click();
  await page.getByRole("menuitem", { name: "Share again" }).click();
  await expect(entry.getByTestId("synced-markers")).not.toContainText("Private");
});
