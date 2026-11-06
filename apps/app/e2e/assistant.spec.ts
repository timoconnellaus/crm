// The in-app assistant (ADR 0030, ADR 0200, ADR 0340): one chat per person, shown by the docked
// panel and by /assistant. The panel on a record knows which record "this" is; it builds a
// dashboard widget and approves a pending change inline; /assistant shows the same thread, keeps
// it across reloads, searches it and jumps to a hit; an unread reply puts a badge on "Ask AI" and
// the nav until it is seen. Local dev runs with AI_FAKE_MODEL=true, so the assistant role is the
// scripted stand-in model, driving the real tool loop through our own MCP server. Desktop and
// phone; the org's approval policy is the default Balanced.
import { expect, type Page, test } from "@playwright/test";
import { createPerson, isPhone, open, unique } from "./helpers.ts";

/** Opens the panel: Cmd-J on desktop, the header button on a phone. */
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

test("Cmd-J on a record: the assistant answers about that record", async ({ page }) => {
  const token = unique("asst");
  await createPerson(page, { given: "Grace", family: `Hopper${token}` });
  const panel = await openPanel(page);
  await expect(panel.getByRole("button", { name: "New conversation" })).toHaveCount(0);
  await expect(panel.getByTestId("assistant-context")).toContainText(`Grace Hopper${token}`);
  await ask(panel, "Summarise this person");
  await expect(panel.getByTestId("assistant-reply").last()).toContainText(
    `Here is what I found about Grace Hopper${token}`,
  );
  await expect(panel.getByTestId("assistant-tool").last()).toHaveAttribute(
    "data-tool",
    "person_get",
  );
  // Never called Claude: its name comes from settings.
  await expect(panel).not.toContainText(/claude/i);
});

test("builds a dashboard widget through the assistant", async ({ page }) => {
  await open(page, "/dashboards");
  const panel = await openPanel(page);
  await ask(panel, "Build a dashboard widget of tasks by status");
  await expect(panel.getByTestId("assistant-reply").last()).toContainText(
    "Done: the dashboard is ready.",
  );
  await page.keyboard.press("Escape");
  await open(page, "/dashboards");
  await expect(page.getByText("Tasks by status dashboard").first()).toBeVisible();
});

test("approves a pending change inline", async ({ page }) => {
  const token = unique("del");
  await createPerson(page, { given: "Temp", family: `Person${token}` });
  await page.getByTestId("ask-ai").click();
  const panel = page.getByTestId("assistant-panel");
  await expect(panel).toBeVisible();
  await ask(panel, "Delete this person");
  // Balanced: a destructive change by the assistant waits for approval.
  const pending = panel.getByTestId("assistant-pending").last();
  await expect(pending).toHaveAttribute("data-status", "pending");
  await expect(panel.getByTestId("assistant-reply").last()).toContainText("waiting for approval");
  await pending.getByRole("button", { name: "Approve" }).click();
  await expect(pending).toHaveAttribute("data-status", "applied");
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByText(/in Trash|deleted/i).first()).toBeVisible();
});

test("/assistant is the same thread: kept across reloads, searchable, no conversation list", async ({
  page,
}) => {
  const token = unique("hist");
  await open(page, "/assistant");
  await expect(page.getByRole("button", { name: /New/ })).toHaveCount(0);
  await page.getByTestId("assistant-input").fill(`Hello ${token}`);
  await page.getByTestId("assistant-send").click();
  await expect(page.getByTestId("assistant-reply").last()).toContainText("I can look up");
  await expect(page).toHaveURL(/\/assistant$/);
  await page.reload();
  await expect(page.getByTestId("assistant-transcript")).toContainText(`Hello ${token}`);

  // Search this chat, then jump back to the message.
  await page.getByTestId("assistant-search-input").fill(token);
  const results = page.getByTestId("assistant-search-results");
  await expect(results).toContainText(`Hello ${token}`);
  await results.getByRole("button", { name: "Jump to" }).first().click();
  await expect(page.getByTestId("assistant-user").filter({ hasText: token })).toBeInViewport();

  // The docked panel shows the same thread.
  if (!isPhone(page)) {
    await open(page, "/people");
    const panel = await openPanel(page);
    await expect(panel.getByTestId("assistant-transcript")).toContainText(`Hello ${token}`);
  }
});

test("an unread reply badges Ask AI and the nav until it is seen", async ({ page }) => {
  test.skip(isPhone(page), "The nav is a drawer on phones");
  const token = unique("unread");
  // A reply that arrives while the chat is closed (sent through the turn route, as evals do).
  await open(page, "/people");
  const status = await page.evaluate(async (text) => {
    const response = await fetch("/api/assistant/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, context: { path: "/people" } }),
    });
    await response.text();
    return response.status;
  }, `Ping ${token}`);
  expect(status).toBe(200);
  await expect(page.getByTestId("assistant-unread")).toBeVisible();
  await expect(page.getByTestId("assistant-unread-nav")).toBeVisible();
  // Opening the chat clears it.
  const panel = await openPanel(page);
  await expect(panel.getByTestId("assistant-transcript")).toContainText(`Ping ${token}`);
  await expect(page.getByTestId("assistant-unread")).toHaveCount(0);
  await expect(page.getByTestId("assistant-unread-nav")).toHaveCount(0);
});
