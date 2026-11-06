// A2UI cards (stage 17 acceptance 9, ADR 0345, ADR 0346). Every catalogue component draws at the
// docked panel's 384 px (desktop project) and on a 390 px phone (phone project) without
// overflowing. In the chat, a model's card draws, an invalid one shows its words, a saved producer
// draws a card with no model call, and buttons act as the viewer through the gate.
import { expect, type Page, test } from "@playwright/test";
import { isPhone, open, unique } from "./helpers.ts";

async function openPanel(page: Page) {
  const panel = page.getByTestId("assistant-panel");
  if (isPhone(page)) {
    await page.getByTestId("open-assistant").click();
  } else {
    await expect(async () => {
      if (!(await panel.isVisible())) await page.keyboard.press("ControlOrMeta+j");
      await expect(panel).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
  }
  await expect(panel).toBeVisible();
  return panel;
}

async function ask(panel: ReturnType<Page["getByTestId"]>, text: string) {
  await panel.getByTestId("assistant-input").fill(text);
  await panel.getByTestId("assistant-send").click();
}

test("every catalogue component draws inside the width, with nothing falling back", async ({
  page,
}) => {
  const width = isPhone(page) ? 390 : 384;
  await open(page, isPhone(page) ? "/assistant/cards" : "/assistant/cards?width=384");
  const gallery = page.getByTestId("a2ui-gallery");
  await expect(gallery).toBeVisible();
  const samples = page.getByTestId("a2ui-sample");
  await expect(samples).toHaveCount(54);
  await expect(page.getByTestId("a2ui-fallback")).toHaveCount(0);
  const overflowing = await samples.evaluateAll(
    (nodes, limit) =>
      nodes.flatMap((node) => {
        const box = node.getBoundingClientRect();
        const problems: string[] = [];
        if (box.width > limit) problems.push(`${box.width}px wide`);
        if (node.scrollWidth > node.clientWidth) problems.push("content overflows");
        return problems.map((p) => `${(node as HTMLElement).dataset.type}: ${p}`);
      }),
    width,
  );
  expect(overflowing).toEqual([]);
  const scroll = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll.width).toBeLessThanOrEqual(scroll.client);
});

test("a high-risk approval takes two steps, and Cancel goes back", async ({ page }) => {
  await open(page, "/assistant/cards?width=384");
  const card = page.locator('[data-type="approval-high-risk"]');
  await expect(card).toContainText("You asked");
  await expect(card).toContainText("Agent's reason");
  const first = card.getByRole("button", { name: "Send 240 emails", exact: true });
  await first.click();
  await expect(first).toHaveCount(0);
  await card.getByRole("button", { name: "Cancel" }).click();
  await first.click();
  const confirm = card.getByRole("button", { name: "Confirm: send 240 emails" });
  await expect(page.getByTestId("a2ui-decided")).toHaveCount(0);
  await confirm.click();
  await expect(page.getByTestId("a2ui-decided")).toHaveText("approve");
});

test("a double tap cannot go through both steps", async ({ page }) => {
  await open(page, "/assistant/cards?width=384");
  const card = page.locator('[data-type="approval-high-risk"]');
  await card.getByRole("button", { name: "Send 240 emails", exact: true }).dblclick();
  await expect(card.getByRole("button", { name: "Confirm: send 240 emails" })).toBeVisible();
  await expect(page.getByTestId("a2ui-decided")).toHaveCount(0);
});

test("the model's card draws; an invalid one shows its words; both are in the thread", async ({
  page,
}) => {
  const token = unique("card");
  await open(page, "/people");
  const panel = await openPanel(page);
  await ask(panel, `Show me a card about ${token}`);
  const card = panel.locator(`[data-a2ui="card"]`, { hasText: token }).last();
  await expect(card).toBeVisible();
  await expect(card.getByRole("button", { name: "Tell me more" })).toBeVisible();
  await expect(panel.getByTestId("assistant-reply").last()).toContainText("Here it is.");

  await ask(panel, `Show me a broken card about ${token}`);
  await expect(panel.getByTestId("a2ui-fallback").last()).toContainText(
    `Plain words about ${token}.`,
  );
  await expect(panel.getByTestId("assistant-reply").last()).toContainText(
    "I could not show that as a card.",
  );

  // Stored, not just streamed.
  await open(page, "/assistant");
  await expect(page.locator(`[data-a2ui="card"]`, { hasText: token }).first()).toBeVisible();
  await expect(
    page.getByTestId("a2ui-fallback").filter({ hasText: `Plain words about ${token}.` }).first(),
  ).toBeVisible();
});

test("a saved producer draws a card, and its checkbox completes the task", async ({ page }) => {
  const title = unique("Overdue call ");
  await open(page, "/tasks");
  const panel = await openPanel(page);
  await ask(panel, `Create an overdue task called ${title}`);
  await expect(panel.getByTestId("assistant-reply").last()).toContainText(title);
  await ask(panel, "Show my overdue tasks");
  const card = panel.locator(`[data-a2ui="taskList"]`).last();
  await expect(card).toContainText("Overdue tasks");
  await expect(card).toContainText(title);
  const box = card.getByRole("checkbox", { name: `Complete: ${title}` });
  // The tick is optimistic, so wait for the operation itself.
  const acted = page.waitForResponse(
    (r) => r.url().includes("/_serverFn/") && (r.request().postData() ?? "").includes("a2ui.act"),
  );
  await box.click();
  await expect(box).toBeChecked();
  await expect(box).toBeDisabled();
  await acted;
  // Balanced: a write by the assistant applies, so the task is really done: a fresh card, read
  // from the CRM again, no longer lists it.
  const cards = panel.getByTestId("assistant-card");
  const before = await cards.count();
  await ask(panel, "Show my overdue tasks");
  await expect(cards).toHaveCount(before + 1);
  await expect(cards.last()).not.toContainText(title);
});

test("the stale deals producer draws a card", async ({ page }) => {
  await open(page, "/assistant");
  await page.getByTestId("assistant-input").fill("Show my stale deals");
  await page.getByTestId("assistant-send").click();
  await expect(
    page.locator(`[data-a2ui="dealList"], [data-a2ui="emptyState"]`).last(),
  ).toBeVisible();
  await expect(page.getByTestId("assistant-reply").last()).toContainText("Here it is.");
});
