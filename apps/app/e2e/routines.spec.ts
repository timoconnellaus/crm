// Routines (ADR 0343): asking in the chat shows a read-back with a backtest; Turn on makes it; My
// routines tests it into the chat, where it looks like a normal message with an info dot and a why
// panel, and counts as unread; then pause and delete. In the chat it is never called a routine.
// Local dev runs the scripted model (AI_FAKE_MODEL=true).
import { expect, type Page, test } from "@playwright/test";
import { createPerson, expectNoHorizontalScroll, isPhone, open, unique } from "./helpers.ts";

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

test("from a read-back to a delivered message, and back out", async ({ page }) => {
  await open(page, "/people");
  await createPerson(page, { given: unique("Watched") });
  const panel = await openPanel(page);

  await ask(panel, "Tell me when a person is created");
  const readBack = panel.getByTestId("assistant-card").filter({ hasText: "New person" }).last();
  await expect(readBack.getByTestId("routine-backtest")).toContainText("Would have messaged you");
  await expect(readBack).not.toContainText(/routine/i);
  await readBack.getByRole("button", { name: "Turn on" }).click();
  await expect(readBack).toContainText("Turned on");

  // The real path: the record event starts a run in ros-runner, its Workflow queues the delivery,
  // and ros-app posts the message into the thread.
  const dots = panel.getByTestId("routine-why-dot");
  const delivered = await dots.count();
  await createPerson(page, { given: unique("Arrives") });
  const chatAgain = await openPanel(page);
  await expect(async () => {
    expect(await chatAgain.getByTestId("routine-why-dot").count()).toBeGreaterThan(delivered);
  }).toPass({ timeout: 45_000 });

  await open(page, "/settings/assistant-routines");
  const row = page.getByTestId("routine-row").filter({ hasText: "New person" }).last();
  await expect(row.getByTestId("routine-status")).toHaveText("On");
  await expect(row.getByTestId("routine-next-run")).toHaveText("When it happens");
  await expectNoHorizontalScroll(page);
  await row.getByTestId("routine-test").click();
  await expect(page.getByText("Sent to your chat")).toBeVisible();

  const chat = await openPanel(page);
  const dot = chat.getByTestId("routine-why-dot").last();
  await dot.evaluate((el) => el.scrollIntoView());
  await expect(dot).toBeInViewport();
  await dot.click({ force: true });
  const why = chat.getByTestId("routine-why").last();
  await expect(why).toContainText("You asked");
  await expect(why).toContainText("Tell me when a person is created");
  await expect(why).toContainText("When");
  await expect(why).not.toContainText("%");
  await expect(chat.getByRole("button", { name: "Snooze" }).last()).toBeVisible();

  await why.getByRole("button", { name: "Pause" }).click();
  await open(page, "/settings/assistant-routines");
  await expect(row.getByTestId("routine-status")).toHaveText("Paused");
  const rows = page.getByTestId("routine-row").filter({ hasText: "New person" });
  const count = await rows.count();
  await row.getByRole("button", { name: "Delete" }).click();
  await page.getByTestId("routine-delete-confirm").click();
  await expect(rows).toHaveCount(count - 1);
});

test("a schedule under 15 minutes is refused, in plain words", async ({ page }) => {
  await open(page, "/people");
  const panel = await openPanel(page);
  await ask(panel, "Check in with me every 5 minutes");
  await expect(panel.getByTestId("assistant-reply").last()).toContainText(
    "shortest gap allowed is 15 minutes",
  );
});

test("the morning briefing read-back fits the chat", async ({ page }) => {
  await open(page, "/people");
  const panel = await openPanel(page);
  await ask(panel, "Send me a morning briefing");
  const readBack = panel
    .getByTestId("assistant-card")
    .filter({ hasText: "Morning briefing" })
    .last();
  await expect(readBack.getByTestId("routine-backtest")).toContainText("in 30 days");
  await expect(readBack.getByRole("button", { name: "Turn on" })).toBeVisible();
  await expect(readBack.getByRole("button", { name: "Change it" })).toBeVisible();
  await expectNoHorizontalScroll(page);
});
