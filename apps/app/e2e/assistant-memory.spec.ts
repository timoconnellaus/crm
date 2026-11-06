// Assistant memory (ADR 0342): a preference is saved inline with Undo and Redo, shows on What your
// assistant remembers with its source message, and can be edited and deleted there; a customer fact
// becomes a note waiting for approval; a conditional line is read back and saved by the person.
// Local dev runs the scripted model and the stand-in judge (AI_FAKE_MODEL=true).
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

test("a preference saves inline, with undo, and shows on the memory page", async ({ page }) => {
  const token = unique("tea");
  const line = `I prefer calls before ${token}`;
  await open(page, "/people");
  const panel = await openPanel(page);
  await ask(panel, `remember ${line}`);
  const saved = panel.getByTestId("memory-saved").filter({ hasText: line });
  await expect(saved).toContainText("Saved to memory");

  // The newest save in the thread, whatever state its line is in.
  const item = panel.getByTestId("assistant-tool").filter({ hasText: "memory.propose" }).last();
  await item.getByRole("button", { name: "Undo" }).click();
  await expect(item.getByTestId("memory-removed")).toContainText("Removed from memory");
  await item.getByRole("button", { name: "Redo" }).click();
  await expect(item.getByTestId("memory-saved")).toContainText(line);

  await open(page, "/settings/assistant-memory");
  const row = page.getByTestId("memory-line").filter({ hasText: line });
  await expect(row).toBeVisible();
  await expect(row.getByTestId("memory-source")).toBeVisible();
  await expectNoHorizontalScroll(page);

  await row.getByRole("button", { name: "Edit" }).click();
  await page.getByTestId("memory-edit-text").fill(`${line} sharp`);
  await page.getByTestId("memory-edit-save").click();
  const edited = page.getByTestId("memory-line").filter({ hasText: `${line} sharp` });
  await expect(edited).toBeVisible();
  await edited.getByRole("button", { name: "Pause" }).click();
  await expect(edited.getByText("Paused")).toBeVisible();
  await edited.getByTestId("memory-line-delete").click();
  await expect(edited).toHaveCount(0);
});

test("a customer fact becomes a note waiting for approval, not a memory line", async ({ page }) => {
  const token = unique("ade");
  await createPerson(page, { given: "Ade", family: `Okafor${token}` });
  const panel = await openPanel(page);
  await ask(panel, `remember Ade is leaving in March ${token}`);
  const card = panel.getByTestId("assistant-pending").last();
  await expect(card).toContainText("Add a note");
  await expect(card).toContainText(`Ade is leaving in March ${token}`);

  await open(page, "/settings/assistant-memory");
  await expect(page.getByRole("heading", { name: "About you" })).toBeVisible();
  await expect(page.getByTestId("memory-line").filter({ hasText: token })).toHaveCount(0);
});

test("a conditional line is read back in words and saved by the person", async ({ page }) => {
  const token = unique("committee");
  await open(page, "/people");
  const panel = await openPanel(page);
  await ask(panel, `when I'm on an organisation with more than 500 people, start with ${token}`);
  const card = panel.getByTestId("memory-readback").last();
  await expect(card.getByTestId("memory-condition")).toHaveText(
    "Organisations where People is more than 500",
  );
  await expect(card).toContainText("matches what you said");
  await card.getByTestId("memory-save").click();
  await expect(
    panel.getByTestId("memory-saved").filter({ hasText: "more than 500" }).last(),
  ).toBeVisible();

  await open(page, "/settings/assistant-memory");
  const row = page.getByTestId("memory-line").filter({ hasText: token });
  await expect(row.getByTestId("memory-line-condition")).toContainText("more than 500");
  await row.getByTestId("memory-line-delete").click();
  await expect(row).toHaveCount(0);
});
