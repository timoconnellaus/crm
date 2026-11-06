// Stage 7a in-app AI: Settings → AI (roles and the Test button), the record Summary card and the
// Similar records panel. Local dev runs with AI_FAKE_MODEL=true: deterministic fake models for
// every role and an in-memory vector store filled right after each write. Desktop and phone.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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

test("Settings → AI: cache lifetimes, the rails, and an export the replay tool reads", async ({
  page,
  baseURL,
}) => {
  // Two turns: the second is an observation of the first's cache.
  await open(page, "/settings/ai");
  for (const text of ["Hello there", "Hello again"]) {
    const reply = await page.request.post("/api/assistant/turn", {
      data: { text },
      headers: { origin: baseURL ?? "" },
    });
    expect(reply.ok()).toBe(true);
    await reply.text();
  }
  await page.reload();

  const card = page.getByTestId("ai-cache");
  await expect(card.getByText("Prompt cache and compaction")).toBeVisible();
  await expect(card.getByTestId("ai-cache-estimate").first()).toContainText("fake / fake");

  // The rails save, and come back.
  const floor = card.getByLabel("Never compact below (tokens)");
  await expect(floor).toHaveValue("24000");
  await floor.fill("30000");
  await card.getByRole("button", { name: "Save limits" }).click();
  await expect(page.getByText("Compaction limits saved")).toBeVisible();
  await page.reload();
  await expect(card.getByLabel("Never compact below (tokens)")).toHaveValue("30000");
  await card.getByLabel("Never compact below (tokens)").fill("24000");
  await card.getByRole("button", { name: "Save limits" }).click();
  await expect(page.getByText("Compaction limits saved").first()).toBeVisible();

  // A real export, through the real command.
  const download = page.waitForEvent("download");
  await card.getByRole("button", { name: "Export JSON" }).click();
  const file = await (await download).path();
  const script = fileURLToPath(new URL("../../../scripts/ai-replay-cache.mjs", import.meta.url));
  const report = JSON.parse(
    execFileSync(process.execPath, [script, file, "--json"], { encoding: "utf8" }),
  ) as { models: { provider: string; observations: number }[]; decisions: { total: number } };
  const fake = report.models.find((m) => m.provider === "fake");
  expect(fake?.observations).toBeGreaterThan(0);
  expect(report.decisions.total).toBeGreaterThan(0);
});

test("Settings → AI's Judge section: key status, reviewer, placement switches and spend", async ({
  page,
}) => {
  // Local dev has no TypeSafe key: the judge is off and says how to add one.
  await open(page, "/settings/ai");
  const judge = page.getByTestId("ai-judge");
  await expect(judge.getByRole("heading", { name: "Judge (Jev)" })).toBeVisible();
  await expect(judge.getByTestId("judge-key-status")).toHaveText("No key");
  await expect(judge.getByTestId("judge-route")).toContainText("No TypeSafe key");
  // No key: the LLM reviews, and Jev cannot be chosen.
  await expect(judge.getByTestId("judge-reviewer-current")).toHaveText("the LLM (review role)");
  // Each placement with what it sends, what happens without an answer, and its spend.
  const intent = judge.getByTestId("judge-placement-authoring.intent");
  await expect(intent).toContainText("The person's request words");
  await expect(intent).toContainText("intent/unchecked");
  await expect(judge.getByTestId("judge-spend-authoring.intent")).toContainText("calls");
  await expect(judge.getByTestId("judge-placement-adjudicator.policy")).toContainText(
    "Off: the LLM reviews",
  );
  await expect(judge.getByTestId("judge-spend-total")).toContainText("Last 30 days");

  // A switch is an audited admin change; Reset returns it to its default.
  const widget = judge.getByTestId("judge-placement-widget.shape");
  const toggle = widget.getByRole("switch");
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(widget.getByRole("switch")).not.toBeChecked();
  await expect(widget).toContainText("Set here");
  await widget.getByRole("button", { name: "Reset" }).click();
  await expect(widget.getByRole("switch")).toBeChecked();
  await expect(widget).toContainText("Default");

  // Turning off a check that holds things for a person asks first.
  const outbound = judge.getByTestId("judge-placement-outbound.message");
  await expect(outbound).toContainText("Sends record content");
  if (!(await outbound.getByRole("switch").isChecked())) {
    await outbound.getByRole("switch").click();
    await expect(outbound.getByRole("switch")).toBeChecked();
  }
  await outbound.getByRole("switch").click();
  await expect(page.getByRole("alertdialog")).toContainText("more will go through");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(outbound.getByRole("switch")).toBeChecked();
  if (await outbound.getByRole("button", { name: "Reset" }).isVisible()) {
    await outbound.getByRole("button", { name: "Reset" }).click();
    await expect(outbound).not.toContainText("Set here");
  }
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
