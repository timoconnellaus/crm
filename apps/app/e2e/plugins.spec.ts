// Plugins (ADR 0347): installing in the chat and on the page, an unchanged copy updating, a version
// that asks for more access, a changed copy going through compare and merge, stop and resume, and
// a locked plugin. Local dev runs the scripted model (AI_FAKE_MODEL=true).
import { expect, type Page, test } from "@playwright/test";
import { expectNoHorizontalScroll, isPhone, open, unique } from "./helpers.ts";

const manifest = (id: string, version: string, instructions: string, extra: object[] = []) =>
  JSON.stringify({
    id,
    name: `Desk ${id}`,
    version,
    publisher: "Northwind",
    description: "A plugin for testing updates",
    whatsNew: [`Version ${version}`],
    items: [
      {
        kind: "skill",
        key: "brief",
        label: "Brief",
        body: { name: `${id}.brief`, description: "A brief", instructions },
      },
      ...extra,
    ],
  });

async function addToWorkspace(page: Page, json: string) {
  await open(page, "/plugins?tab=workspace");
  await page.getByLabel("Add a plugin.json").fill(json);
  await page.getByRole("button", { name: "Add to your workspace" }).click();
  await expect(page.getByLabel("Add a plugin.json")).toHaveValue("");
}

async function installFromPage(page: Page, id: string) {
  await open(page, "/plugins");
  const card = page.locator(`[data-testid="plugin-card"][data-plugin="${id}"]`);
  await card.getByRole("button", { name: "Install" }).click();
  const dialog = page.getByTestId("plugin-install-dialog");
  await expect(dialog).toContainText("What it adds");
  await dialog.getByRole("button", { name: "Install" }).click();
  await expect(dialog).toBeHidden();
}

const copyOf = (page: Page, id: string) =>
  page.locator(`[data-testid="plugin-copy"][data-plugin="${id}"]`);

test("an unchanged copy follows updates, and new access waits", async ({ page }) => {
  const id = unique("desk").toLowerCase().replace(/[^a-z]/g, "x");
  await addToWorkspace(page, manifest(id, "1.0.0", "One"));
  await installFromPage(page, id);

  await addToWorkspace(page, manifest(id, "1.1.0", "One\nTwo"));
  await open(page, "/plugins?tab=installed");
  const copy = copyOf(page, id);
  await expect(copy).toContainText("1.1.0 is out. It will apply by itself.");
  await copy.getByRole("button", { name: "Update" }).click();
  await expect(copy.getByTestId("plugin-copy-status")).toContainText("Unchanged");
  await expect(copy).toContainText("1.1.0");

  await addToWorkspace(
    page,
    manifest(id, "1.2.0", "One\nTwo", [
      {
        kind: "connectionNeed",
        key: "mail",
        label: "Your email",
        body: { service: "gmail", vendors: ["google"], reason: "It reads your email." },
      },
    ]),
  );
  await open(page, "/plugins?tab=installed");
  await expect(copy).toContainText("asks for something new");
  await expect(copy.getByTestId("plugin-widening")).toContainText("Use gmail");
  await expectNoHorizontalScroll(page);
});

test("a changed copy offers compare and merge, and stop and resume work", async ({ page }) => {
  const id = unique("desk").toLowerCase().replace(/[^a-z]/g, "x");
  const base = "List attendees.\nShow open deals.\nKeep it under 300 words.";
  await addToWorkspace(page, manifest(id, "2.0.0", base));
  await installFromPage(page, id);

  // A person's edit: the same operation the item editor calls.
  await open(page, "/plugins?tab=installed");
  const copy = copyOf(page, id);
  await copy.getByRole("button", { name: "Edit Brief" }).click();
  await page.getByLabel("Instructions").fill(`${base}\nNo exclamation marks.`);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(copy.getByTestId("plugin-copy-state")).toContainText("changed");

  await addToWorkspace(page, manifest(id, "2.1.0", base.replace("List attendees.", "List first.")));
  await open(page, "/plugins?tab=installed");
  await expect(copy).toContainText("it needs a merge");
  await copy.getByRole("button", { name: "Compare" }).click();
  await expect(page.getByTestId("plugin-compare")).toBeVisible();
  await expect(page.getByLabel("Merged Brief")).toHaveValue(/List first\./);
  await expect(page.getByLabel("Merged Brief")).toHaveValue(/No exclamation marks\./);
  await expectNoHorizontalScroll(page);
  await page.getByRole("button", { name: "Apply merged" }).click();
  await expect(copy).toContainText("2.1.0");
  await expect(copy.getByTestId("plugin-copy-state")).toContainText("changed");

  await copy.getByRole("button", { name: "Stop updates" }).click();
  await expect(copy).toContainText("Not following updates");
  await addToWorkspace(page, manifest(id, "2.2.0", base));
  await open(page, "/plugins?tab=installed");
  await expect(copy).toContainText("2.2.0 is out. Resuming compares");
  await copy.getByRole("button", { name: "Resume updates" }).click();
  await expect(page.getByTestId("plugin-compare")).toBeVisible();
  await page.getByRole("button", { name: "Resume updates" }).click();
  await expect(copy).toContainText("it needs a merge");
});

test("the assistant offers a plugin, and a person installs it", async ({ page }) => {
  await open(page, "/plugins?tab=installed");
  const installed = await page
    .locator('[data-testid="plugin-copy"][data-plugin="follow-through"]')
    .count();
  const panel = page.getByTestId("assistant-panel");
  if (isPhone(page)) {
    await page.getByTestId("open-assistant").click();
  } else {
    await expect(async () => {
      if (!(await panel.isVisible())) await page.keyboard.press("ControlOrMeta+j");
      await expect(panel).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
  }
  await panel.getByTestId("assistant-input").fill("Install follow-through for me");
  await panel.getByTestId("assistant-send").click();
  const card = panel.getByTestId("assistant-card").filter({ hasText: "Follow-through" }).last();
  await expect(card).toContainText("Monday follow-through");
  await expect(card).toContainText("Sends nothing without you");
  if (!installed) {
    await card.getByRole("button", { name: "Install" }).click();
    await expect(card).toContainText("Installed");
  }
  await open(page, "/settings/assistant-routines");
  await expect(page.getByText("Monday follow-through").first()).toBeVisible();
});

test("an admin locks a plugin for a team, and sees it on Settings", async ({ page }) => {
  const id = unique("desk").toLowerCase().replace(/[^a-z]/g, "x");
  await addToWorkspace(page, manifest(id, "1.0.0", "One"));
  await open(page, "/settings/plugins");
  await page.getByRole("combobox", { name: "Plugin" }).click();
  await page.getByRole("option", { name: `Desk ${id}` }).click();
  await page.getByLabel("Team").fill("Sales");
  const form = page.getByTestId("install-for-team");
  await form.getByRole("checkbox").first().click();
  await form.getByRole("button", { name: /Install for 1 person/ }).click();
  const row = page.getByTestId("workspace-plugins").getByText(`Desk ${id}`);
  await expect(row).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test("admins decide who can use the marketplace", async ({ page }) => {
  await open(page, "/settings/plugins");
  await page.getByLabel("Ask an admin first").click();
  await expect(page.getByLabel("Ask an admin first")).toBeChecked();
  await page.getByLabel("Anyone can install").click();
  await expect(page.getByLabel("Anyone can install")).toBeChecked();
});
