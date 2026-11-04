// Shared steps for the integration specs (stage 6a): the dev-only fake gatekeeper with its fake
// OAuth provider (INTEGRATIONS_FAKE_PROVIDER=true in apps/runner/.dev.vars), connected through
// the real popup flow on Settings → Integrations, plus its seed and "sent" helper routes.
import { type APIRequestContext, expect, type Locator, type Page } from "@playwright/test";
import { open, unique } from "./helpers.ts";

export const FAKE_TITLE = "Fake provider (development)";

/** A fresh mailbox address for this run (the local database and fake provider persist). */
export function fakeAddress(prefix = "e2e"): string {
  return `${prefix}-${unique()}@example.com`;
}

/** Opens Settings → Integrations and enables the fake provider if it is off (admin). */
export async function openIntegrations(page: Page): Promise<void> {
  await open(page, "/settings/integrations");
  await expect(page.getByRole("heading", { level: 1, name: "Integrations" })).toBeVisible();
  const card = page.locator('[data-testid=catalogue-item][data-vendor="fake"]');
  const enable = card.getByRole("switch", { name: `Enable ${FAKE_TITLE}` });
  await expect(enable).toBeVisible();
  if ((await enable.getAttribute("aria-checked")) !== "true") {
    await enable.click();
    await expect(enable).toHaveAttribute("aria-checked", "true");
  }
}

/** The card of the connection whose account is `address`. */
export function connectionCard(page: Page, address: string): Locator {
  return page.getByTestId("connection").filter({ hasText: address });
}

/**
 * Connects a personal fake connection through the real popup: Connect, the provider's consent
 * page (mailbox address, Allow), /connect/handoff, and back. Returns its card, active.
 */
export async function connectFake(page: Page, address: string): Promise<Locator> {
  const card = page.locator('[data-testid=catalogue-item][data-vendor="fake"]');
  const popupOpened = page.waitForEvent("popup");
  await card.getByRole("button", { name: `Connect: ${FAKE_TITLE}` }).click();
  const popup = await popupOpened;
  await popup.getByLabel("Mailbox address").fill(address);
  const closed = popup.waitForEvent("close", { timeout: 30_000 });
  await popup.getByRole("button", { name: "Allow" }).click();
  await closed;
  const connection = connectionCard(page, address);
  await expect(connection).toHaveAttribute("data-status", "active", { timeout: 20_000 });
  return connection;
}

/** Adds a fake resource (Mailbox, Calendar or Outbox) through the picker's generic form. */
export async function addFakeResource(
  page: Page,
  connection: Locator,
  type: "Mailbox" | "Calendar" | "Outbox",
  address: string,
): Promise<void> {
  const before = await connection.getByTestId("connection-resource").count();
  await connection.getByRole("button", { name: "Add resource" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a resource" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("radio", { name: new RegExp(`^${type}`) }).click();
  await dialog.getByLabel("Address").fill(address);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(connection.getByTestId("connection-resource")).toHaveCount(before + 1);
}

export interface SeedMessage {
  id: string;
  messageId: string;
  from: { email: string; name?: string };
  to: { email: string; name?: string }[];
  subject: string;
  text: string;
  sentAt: string;
  restricted?: boolean;
}

/** Puts mail into the fake mailbox at `address` (dev-only route). */
export async function seedMail(
  request: APIRequestContext,
  address: string,
  messages: SeedMessage[],
): Promise<void> {
  const response = await request.post(`/gatekeeper/fake/seed/${encodeURIComponent(address)}`, {
    data: { messages },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

/** What the fake outbox at `address` actually sent. */
export async function sentMail(
  request: APIRequestContext,
  address: string,
): Promise<{ action: number; to: string[]; subject: string; text: string }[]> {
  const response = await request.get(`/gatekeeper/fake/sent/${encodeURIComponent(address)}`);
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as {
    action: number;
    to: string[];
    subject: string;
    text: string;
  }[];
}

/** A connection's id, from its card. */
export async function connectionId(connection: Locator): Promise<string> {
  const id = await connection.getAttribute("data-connection");
  expect(id).toMatch(/^con_/);
  return id ?? "";
}
