import { expect, type Page, test } from "@playwright/test";

// Stage 10 AC1 in a browser: sign up for Team, confirm the email, pay at (fake) Stripe Checkout
// with a trial, and reach the provisioned workspace through the dispatch Worker.

async function followMailLink(page: Page, email: string, subject: RegExp) {
  await page.goto(`/dev/mail?to=${encodeURIComponent(email)}`);
  const card = page.locator(".card").filter({ hasText: subject }).first();
  const text = (await card.locator("pre").textContent()) ?? "";
  const link = /https?:\/\/\S+\/auth\/callback\?token=[\w-]+/.exec(text)?.[0];
  if (!link) throw new Error(`no link in mail to ${email}`);
  await page.goto(new URL(link).pathname + new URL(link).search);
}

test("sign up for Team, trial checkout, workspace provisioned and reachable", async ({ page }) => {
  const email = `owner-${Date.now()}@e2e.test`;
  await page.goto("/signup?plan=team");
  await page.getByLabel("Your email").fill(email);
  await page.getByLabel("Organisation name").fill("E2E Ltd");
  await page.getByLabel("Workspace address").fill("e2e-ltd");
  await expect(page.getByRole("radio", { name: /Team/ })).toBeChecked();
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByText(/We've emailed/)).toBeVisible();

  await followMailLink(page, email, /Sign in/);
  await expect(page.getByRole("heading", { name: "Fake Stripe Checkout" })).toBeVisible();
  await expect(page.getByText(/14-day trial/)).toBeVisible();
  await page.getByRole("button", { name: "Pay" }).click();

  await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
  await expect(page.getByText("Running", { exact: true })).toBeVisible();
  await expect(page.getByText("trialing")).toBeVisible();
  await expect(page.getByRole("link", { name: /Open e2e-ltd\.relationshiposcrm\.com/ })).toBeVisible();

  const health = await page.request.get(
    "/dev/tenant?host=e2e-ltd.relationshiposcrm.com&path=/api/health",
  );
  expect(await health.json()).toMatchObject({ status: "ok", version: "1.0.0" });

  // The billing portal can suspend and restore it.
  await page.getByRole("button", { name: "Manage billing and invoices" }).click();
  await page.getByRole("button", { name: "Becomes unpaid" }).click();
  await expect(page.getByText("Suspended", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Manage billing and invoices" }).click();
  await page.getByRole("button", { name: "Payment recovered" }).click();
  await expect(page.getByText("Running", { exact: true })).toBeVisible();
});
