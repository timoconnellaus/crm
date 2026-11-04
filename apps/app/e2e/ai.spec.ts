// Stage 7a in-app AI: Settings → AI (roles and the Test button), the record Summary card and the
// Similar records panel. Local dev runs with AI_FAKE_MODEL=true: deterministic fake models for
// every role and an in-memory vector store filled right after each write. Desktop and phone.
import { expect, test } from "@playwright/test";
import { createPerson, open, unique } from "./helpers.ts";
import { createOrganisation } from "./org-helpers.ts";

test("Settings → AI lists the model roles and tests one", async ({ page }) => {
  await open(page, "/settings/ai");
  await expect(page.getByRole("heading", { level: 1, name: "AI" })).toBeVisible();
  const role = page.getByTestId("ai-role-summarise");
  await expect(role.getByTestId("role-model")).toContainText("Workers AI");
  await role.getByRole("button", { name: "Test the Summarise role" }).click();
  const result = role.getByTestId("role-test-result");
  await expect(result).toHaveAttribute("data-ok", "true");
  await expect(result).toContainText("OK in");
  await expect(result).toContainText("fake");
  // Provider keys, usage and semantic search sections render.
  await expect(page.getByTestId("ai-providers")).toBeVisible();
  await expect(page.getByTestId("ai-usage")).toBeVisible();
  await expect(page.getByTestId("ai-semantic-search")).toBeVisible();

  // Listed on the settings home.
  await open(page, "/settings");
  await page.getByRole("link", { name: /^AI\b/ }).click();
  await expect(page).toHaveURL(/\/settings\/ai$/);
});

test("summarise a person from their record page", async ({ page }) => {
  const token = unique("sum");
  await createPerson(page, { given: "Grace", family: `Hopper${token}` });
  const composer = page.getByRole("form", { name: "Add activity" });
  await composer.getByLabel("Activity text").fill(`Asked about the compiler roadmap ${token}`);
  await composer.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByRole("list", { name: "Timeline" })).toContainText(token);

  const card = page.getByTestId("record-summary");
  await expect(card.getByRole("button", { name: "Summarise" })).toBeVisible();
  await card.getByRole("button", { name: "Summarise" }).click();
  await expect(card.getByTestId("summary-text")).not.toBeEmpty();
  await expect(card.getByTestId("ai-generated")).toHaveText("AI-generated");

  // Cached: it is there again after a reload, without generating.
  await page.reload();
  await expect(page.getByTestId("record-summary").getByTestId("summary-text")).not.toBeEmpty();
  await expect(
    page.getByTestId("record-summary").getByRole("button", { name: "Refresh" }),
  ).toBeVisible();
});

test("a meeting on the timeline gets an AI prep brief", async ({ page }) => {
  const token = unique("prep");
  await createPerson(page, { given: "Ada", family: `Lovelace${token}` });
  const composer = page.getByRole("form", { name: "Add activity" });
  await composer.getByLabel("Activity type").click();
  await page.getByRole("option", { name: "Meeting" }).click();
  await composer.getByLabel("Title").fill(`Engine review ${token}`);
  await composer.getByLabel("Activity text").fill(`Walk through the analytical engine ${token}`);
  await composer.getByRole("button", { name: "Log meeting" }).click();
  const timeline = page.getByRole("list", { name: "Timeline" });
  await expect(timeline).toContainText(`Engine review ${token}`);

  await timeline.getByTestId("meeting-prep").first().click();
  const dialog = page.getByRole("dialog", { name: "Prep brief" });
  await expect(dialog.getByTestId("summary-text")).not.toBeEmpty();
  await expect(dialog.getByTestId("ai-generated")).toBeVisible();
});

test("similar records lists an organisation alike in meaning", async ({ page }) => {
  const token = unique();
  const first = `Solar Panels Co ${token}`;
  const second = `Sunny Solar ${token}`;
  await createOrganisation(page, { name: second, industry: "Renewable energy" });
  await createOrganisation(page, { name: `Bakery Bread Ltd ${token}`, industry: "Food" });
  const id = await createOrganisation(page, { name: first, industry: "Renewable energy" });

  // Embeddings are written just after each save: reload until the panel finds the match.
  await expect(async () => {
    await open(page, `/organisations/${id}`);
    const panel = page.getByTestId("similar-records");
    await expect(panel).toHaveAttribute("data-status", "ok", { timeout: 3_000 });
    await expect(panel.getByRole("link", { name: second })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 45_000 });

  const panel = page.getByTestId("similar-records");
  await panel.getByRole("link", { name: second }).click();
  await expect(page.getByRole("heading", { level: 1, name: second })).toBeVisible();
});
