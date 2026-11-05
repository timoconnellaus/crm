// Stage 7b in-app assistant (ADR 0030, ADR 0200): the Cmd-J panel on a record (it knows which
// record "this" is), building a dashboard widget through the assistant, approving a pending change
// inline, and /assistant's history. Local dev runs with AI_FAKE_MODEL=true, so the assistant role is
// the scripted stand-in model, driving the real tool loop through our own MCP server. Desktop and
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
  // A fresh conversation, scoped to the record the page shows.
  await panel.getByRole("button", { name: "New conversation" }).click();
  await expect(panel.getByTestId("assistant-context")).toContainText(`Grace Hopper${token}`);
  await ask(panel, "Summarise this person");
  await expect(panel.getByTestId("assistant-tool").first()).toHaveAttribute(
    "data-tool",
    "person_get",
  );
  await expect(panel.getByTestId("assistant-reply").last()).toContainText(
    `Here is what I found about Grace Hopper${token}`,
  );
  // Never called Claude: its name comes from settings.
  await expect(panel).not.toContainText(/claude/i);
});

test("builds a dashboard widget through the assistant", async ({ page }) => {
  await open(page, "/dashboards");
  const panel = await openPanel(page);
  await panel.getByRole("button", { name: "New conversation" }).click();
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
  await panel.getByRole("button", { name: "New conversation" }).click();
  await ask(panel, "Delete this person");
  // Balanced: a destructive change by the assistant waits for approval.
  const pending = panel.getByTestId("assistant-pending");
  await expect(pending).toHaveAttribute("data-status", "pending");
  await expect(panel.getByTestId("assistant-reply").last()).toContainText("waiting for approval");
  await pending.getByRole("button", { name: "Approve" }).click();
  await expect(pending).toHaveAttribute("data-status", "applied");
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByText(/in Trash|deleted/i).first()).toBeVisible();
});

test("/assistant keeps the conversation history", async ({ page }) => {
  const token = unique("hist");
  await open(page, "/assistant");
  await page.getByTestId("assistant-input").fill(`Hello ${token}`);
  await page.getByTestId("assistant-send").click();
  await expect(page.getByTestId("assistant-reply").last()).toContainText("I can look up");
  await expect(page).toHaveURL(/\/assistant\?c=asc_/);
  await expect(page.getByTestId("assistant-history")).toContainText(`Hello ${token}`);
  await page.reload();
  await expect(page.getByTestId("assistant-transcript")).toContainText(`Hello ${token}`);
});
