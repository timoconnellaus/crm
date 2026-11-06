// Agents and approvals in the chat (ADR 0344, ADR 0345): research runs in the background with a
// progress card while the person keeps chatting, an empty field is filled, a changed value waits in
// one review, and Approve all applies it. A typed yes approves a note; settings show the limits.
// Local dev runs the scripted model and the stand-in judge (AI_FAKE_MODEL=true).
import { expect, type Page, test } from "@playwright/test";
import { createPerson, expectNoHorizontalScroll, isPhone, open, unique } from "./helpers.ts";
import { createOrganisation } from "./org-helpers.ts";

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

/** A new organisation's id, from its record page. */
async function organisation(page: Page, name: string): Promise<string> {
  return createOrganisation(page, { name });
}

test("research runs in the background and comes back as one review", async ({ page }) => {
  const id = await organisation(page, unique("Bluegum Analytics "));
  await open(page, "/organisations");
  const panel = await openPanel(page);
  await ask(panel, `Research these accounts: ${id}`);

  const card = panel.getByTestId("agent-job").last();
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-state", /running|done/);
  await expect(card).toHaveAttribute("data-state", "done", { timeout: 30_000 });
  await expect(card.getByTestId("agent-job-filled")).toContainText("1 field filled");
  await card.getByRole("button", { name: "Details" }).click();
  await expect(card).toContainText("Steps");
  await expectNoHorizontalScroll(page);

  await expect(panel.getByText("Researched 1 organisations").last()).toBeVisible({
    timeout: 15_000,
  });
  await open(page, `/organisations/${id}`);
  await expect(page.getByText(/found-.*example\.com/).first()).toBeVisible();

  // A second run changes the value it filled: that waits for the person.
  const again = await openPanel(page);
  await ask(again, `Research these accounts: ${id}`);
  const review = again.getByTestId("change-review").last();
  await expect(review).toBeVisible({ timeout: 30_000 });
  await expect(review).toHaveAttribute("data-left", "1");
  await review.getByRole("button", { name: /^Approve all/ }).click();
  await expect(review).toHaveAttribute("data-left", "0");
});

test("a typed yes approves the note waiting", async ({ page }) => {
  const token = unique("ade");
  await createPerson(page, { given: "Ade", family: `Okafor${token}` });
  const panel = await openPanel(page);
  await ask(panel, `remember Ade is leaving in March ${token}`);
  await expect(panel.getByTestId("assistant-pending").last()).toContainText("Add a note");
  // Other specs may leave items waiting: naming the note says which one.
  await ask(panel, "yes, approve that note");
  await expect(panel.getByText("Done.").last()).toBeVisible();
  await expect(page.getByText(`Ade is leaving in March ${token}`).first()).toBeVisible();
});

test("Settings shows the agent profiles and the limits", async ({ page }) => {
  await open(page, "/settings/agents");
  await expect(page.getByTestId("agent-profile")).toHaveCount(4);
  await expect(page.getByLabel("Running per person")).toHaveValue("4");
  await expect(page.getByLabel("Recipients")).toHaveValue("25");
  await expectNoHorizontalScroll(page);
});
