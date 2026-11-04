// Record page panels (timeline, tasks, job change, history), saved views, search, Trash and the
// admin settings pages, wired to their operations. Runs at desktop and phone width.
import { expect, type Page, test } from "@playwright/test";
import {
  createPerson,
  expectNoHorizontalScroll,
  open,
  pressUntil,
  tableRows,
  unique,
} from "./helpers.ts";

function timeline(page: Page) {
  return page.getByRole("list", { name: "Timeline" });
}

test("log a note and see it on the person's timeline", async ({ page }) => {
  const token = unique("note");
  await createPerson(page, { given: "Mary", family: `Jackson${token}` });

  const composer = page.getByRole("form", { name: "Add activity" });
  await composer.getByLabel("Activity text").fill(`Called about **${token}** pricing`);
  await composer.getByRole("button", { name: "Add note" }).click();
  await expect(timeline(page)).toContainText(`Called about ${token} pricing`);
  await expect(timeline(page).locator("strong")).toHaveText(token);

  // A logged call carries its payload; the type filter narrows the timeline.
  await composer.getByLabel("Activity type").click();
  await page.getByRole("option", { name: "Call" }).click();
  await composer.getByLabel("Topic").fill(`Follow-up call ${token}`);
  await composer.getByRole("button", { name: "Log call" }).click();
  await expect(timeline(page)).toContainText(`Follow-up call ${token}`);
  await expect(timeline(page)).toContainText("Outbound");

  await page.getByRole("button", { name: "Calls", exact: true }).click();
  await expect(timeline(page).locator("li")).toHaveCount(1);
  await expect(timeline(page)).not.toContainText(`Called about ${token}`);

  // It survives a reload, and shows on the Activity feed linked to the person.
  await page.reload();
  await expect(timeline(page)).toContainText(`Called about ${token} pricing`);
  await open(page, "/activity");
  await expect(timeline(page)).toContainText(`Called about ${token} pricing`);
  await expect(timeline(page)).toContainText(`Mary Jackson${token}`);
  await expectNoHorizontalScroll(page);
});

test("a note on a person shows on their organisation's timeline too", async ({ page }) => {
  const token = unique("both");
  await createPerson(page, { given: "Katherine", family: `Johnson${token}` });

  // Affiliate them with a new organisation.
  const card = page.getByTestId("affiliations-card");
  await card.getByRole("button", { name: "Add organisation" }).click();
  const add = page.getByRole("form", { name: "Add organisation" });
  await add.getByLabel("Organisation").fill(`Flight Research${token}`);
  await add.getByRole("button", { name: `Create “Flight Research${token}”` }).click();
  await add.getByRole("button", { name: "Add", exact: true }).click();
  await expect(add).toBeHidden();

  // The composer offers the current organisation, ticked.
  const composer = page.getByRole("form", { name: "Add activity" });
  const also = composer.getByRole("checkbox", { name: `Also on Flight Research${token}` });
  await expect(also).toBeChecked();
  await composer.getByLabel("Activity text").fill(`Trajectory review ${token}`);
  await composer.getByRole("button", { name: "Add note" }).click();
  await expect(timeline(page)).toContainText(`Trajectory review ${token}`);

  // The organisation's Timeline tab shows it, linked back to the person.
  await card.getByRole("link", { name: `Flight Research${token}` }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Flight Research${token}`);
  await page.getByRole("tab", { name: "Timeline" }).click();
  await expect(timeline(page)).toContainText(`Trajectory review ${token}`);

  // Its Tasks tab adds and completes a task about the organisation.
  await page.getByRole("tab", { name: /Tasks/ }).click();
  await page.getByRole("button", { name: "Add task" }).first().click();
  const dialog = page.getByRole("form", { name: "New task" });
  await dialog.getByLabel("Title").fill(`Renew contract ${token}`);
  await dialog.getByRole("button", { name: "Add task" }).click();
  await expect(dialog).toBeHidden();
  const tasks = page.getByRole("tabpanel");
  const done = tasks.getByRole("checkbox", { name: `Done: Renew contract ${token}` });
  await done.click();
  await expect(done).toBeChecked();
  await page.getByRole("tab", { name: "Timeline" }).click();
  await expect(timeline(page)).toContainText(`Task completed: Renew contract ${token}`);

  // Its History tab shows the create.
  await page.getByRole("tab", { name: "History" }).click();
  const history = page.getByRole("list", { name: "Change history" });
  await expect(history.locator("li").filter({ hasText: "Created" })).toHaveCount(1);
  await expect(history).toContainText(`Flight Research${token}`);
  await expectNoHorizontalScroll(page);
});

test("change job and see it on the person's timeline", async ({ page }) => {
  const token = unique("job");
  await createPerson(page, { given: "Dorothy", family: `Vaughan${token}` });

  const card = page.getByTestId("affiliations-card");
  // First job: add an organisation, created from the picker.
  await card.getByRole("button", { name: "Add organisation" }).click();
  const add = page.getByRole("form", { name: "Add organisation" });
  await add.getByLabel("Organisation").fill(`Langley${token}`);
  await add.getByRole("button", { name: `Create “Langley${token}”` }).click();
  await expect(add.getByTestId("picked-organisation")).toHaveText(`Langley${token}`);
  await add.getByLabel("Job title").fill("Computer");
  await add.getByRole("button", { name: "Add", exact: true }).click();
  await expect(add).toBeHidden();
  await expect(card.getByRole("list", { name: "Current organisations" })).toContainText(
    `Langley${token}`,
  );

  // Change job: the old one moves to Past, the new one is primary, and the timeline says so.
  await card.getByRole("button", { name: "Change job" }).click();
  const change = page.getByRole("form", { name: "Change job" });
  await change.getByLabel("New organisation").fill(`NASA${token}`);
  await change.getByRole("button", { name: `Create “NASA${token}”` }).click();
  await change.getByLabel("New job title").fill("Programmer");
  await change.getByRole("button", { name: "Change job" }).click();
  await expect(change).toBeHidden();

  await expect(card.getByRole("list", { name: "Current organisations" })).toContainText(
    `NASA${token}`,
  );
  await expect(card.getByRole("list", { name: "Past organisations" })).toContainText(
    `Langley${token}`,
  );
  await expect(page.getByTestId("record-header")).toContainText(`Programmer at NASA${token}`);
  await expect(timeline(page)).toContainText(
    `Job change: Dorothy Vaughan${token} moved from Langley${token} to NASA${token}`,
  );
});

test("add a task from the record page and complete it", async ({ page }) => {
  const token = unique("task");
  await createPerson(page, { given: "Annie", family: `Easley${token}` });

  await page.getByRole("button", { name: "Task", exact: true }).click();
  const dialog = page.getByRole("form", { name: "New task" });
  await dialog.getByLabel("Title").fill(`Send proposal ${token}`);
  await dialog.getByRole("button", { name: "Add task" }).click();
  await expect(dialog).toBeHidden();

  const card = page.getByTestId("tasks-card");
  const done = card.getByRole("checkbox", { name: `Done: Send proposal ${token}` });
  await expect(done).toBeVisible();

  // It is also on My tasks (assigned to me by default) with a link back to the person.
  await open(page, "/tasks");
  const mine = page.getByTestId("my-tasks");
  await expect(mine).toContainText(`Send proposal ${token}`);
  await expectNoHorizontalScroll(page);
  await expect(mine.getByRole("link", { name: `Annie Easley${token}` })).toBeVisible();
  await mine.getByRole("link", { name: `Annie Easley${token}` }).click();

  await page
    .getByTestId("tasks-card")
    .getByRole("checkbox", {
      name: `Done: Send proposal ${token}`,
    })
    .click();
  await expect(card.getByText(`Send proposal ${token}`)).toBeHidden();
  await expect(timeline(page)).toContainText(`Task completed: Send proposal ${token}`);

  // Done, it leaves My tasks and shows under All tasks → Done.
  await open(page, "/tasks");
  await expect(page.getByText(`Send proposal ${token}`)).toBeHidden();
  await page.getByRole("tab", { name: "All tasks" }).click();
  await page.getByLabel("Status").click();
  await page.getByRole("option", { name: "Done", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: `Done: Send proposal ${token}` })).toBeChecked();
});

test("a saved view persists after reload", async ({ page }) => {
  const token = unique("view");
  await createPerson(page, { given: "Christine", family: `Darden${token}` });
  await createPerson(page, { given: "Other", family: `Person${unique()}` });
  await open(page, "/people");

  const builder = page.getByRole("dialog", { name: "Filter builder" });
  await pressUntil(page, "/", builder);
  await page.keyboard.type(token);
  await expect(tableRows(page)).toHaveCount(1);
  await page.keyboard.press("Escape");

  await page.getByTestId("views-menu").click();
  await page.getByRole("menuitem", { name: "Save as new view…" }).click();
  await page.getByLabel("Name").fill(`Darden ${token}`);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("views-menu")).toContainText(`Darden ${token}`);
  await expect(page).toHaveURL(/view=vw_/);

  // A fresh page (no URL state) lists the view, and applying it restores the filter exactly.
  await open(page, "/people");
  await expect(tableRows(page).first()).toBeVisible();
  await page.getByTestId("views-menu").click();
  await page.getByRole("menuitem", { name: `Darden ${token}` }).click();
  await expect(tableRows(page)).toHaveCount(1);
  await expect(tableRows(page).first()).toContainText(`Christine Darden${token}`);
  await page.reload();
  await expect(page.getByTestId("views-menu")).toContainText(`Darden ${token}`);
  await expect(tableRows(page)).toHaveCount(1);

  // Clean up so the views menu stays short across runs.
  await page.getByTestId("views-menu").click();
  await page.getByRole("menuitem", { name: `Delete “Darden ${token}”` }).click();
  await expect(page.getByTestId("views-menu")).not.toContainText(`Darden ${token}`);
});

test("Cmd-K finds a person by email", async ({ page }) => {
  const token = unique("mail");
  const email = `kj-${token}@example.org`;
  await createPerson(page, { given: "Katherine", family: `G${token}`, email });
  await open(page, "/");

  const palette = page.getByRole("dialog", { name: "Command palette" });
  await pressUntil(page, "ControlOrMeta+k", palette);
  await page.keyboard.type(email);
  const hit = palette.getByRole("option", { name: new RegExp(`Katherine G${token}`) });
  await expect(hit).toBeVisible();
  await expect(hit.locator("mark").first()).toBeVisible();
  await hit.click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Katherine G${token}`);
});

test("restore a person from Trash", async ({ page }) => {
  const token = unique("trash");
  const name = `Mae Jemison${token}`;
  await createPerson(page, { given: "Mae", family: `Jemison${token}` });
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Delete person" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByTestId("trash-banner")).toBeVisible();

  await open(page, "/trash");
  const item = page.getByTestId("trash-item").filter({ hasText: name });
  await expect(item).toContainText("restorable until");
  await expectNoHorizontalScroll(page);
  await item.getByRole("button", { name: `Restore ${name}` }).click();
  await expect(item).toBeHidden();

  await open(page, "/people");
  const builder = page.getByRole("dialog", { name: "Filter builder" });
  await pressUntil(page, "/", builder);
  await page.keyboard.type(token);
  await expect(tableRows(page)).toHaveCount(1);
});

test("an admin changes a user's role", async ({ page, baseURL }) => {
  const email = `${unique("role")}@example.com`;
  const name = `Role ${unique()}`;
  // Sign the user up outside the browser, so the page stays signed in as the admin.
  const signUp = await fetch(`${baseURL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseURL ?? "" },
    body: JSON.stringify({ name, email, password: "role-password-not-secret" }),
  });
  expect(signUp.ok).toBe(true);

  await open(page, "/settings/users");
  const row = page.locator(`[data-testid=user-row][data-email="${email}"]`);
  await expect(row).toBeVisible();
  const role = row.getByRole("combobox", { name: `Role for ${name}` });
  await expect(role).toHaveText("Member");
  await expectNoHorizontalScroll(page);
  await role.click();
  await page.getByRole("option", { name: "Viewer" }).click();
  await expect(page.getByText(`${name} is now viewer`)).toBeVisible();

  await page.reload();
  await expect(
    page
      .locator(`[data-testid=user-row][data-email="${email}"]`)
      .getByRole("combobox", { name: `Role for ${name}` }),
  ).toHaveText("Viewer");
});

test("the audit log shows an entry with its field diffs", async ({ page }) => {
  const token = unique("audit");
  const id = await createPerson(page, { given: "Evelyn", family: `Boyd${token}` });

  await open(page, "/settings/audit");
  await page.getByLabel("Record id").fill(id);
  const entry = page.getByTestId("audit-entry").filter({ hasText: "person.create" });
  await expect(entry).toHaveCount(1);
  await entry.getByRole("button").click();
  await expect(entry.getByTestId("audit-diffs")).toContainText(`Evelyn Boyd${token}`);
  await expect(entry.getByTestId("audit-diffs")).toContainText(id);
  await expectNoHorizontalScroll(page);
});

test("the History tab shows a field diff", async ({ page }) => {
  const token = unique("hist");
  await createPerson(page, { given: "Gladys", family: `West${token}` });

  const form = page.getByRole("form", { name: "Edit details" });
  await pressUntil(page, "e", form);
  await form.getByLabel("Location").fill(`Dahlgren ${token}`);
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toBeHidden();

  await page.getByRole("tab", { name: "History" }).click();
  const history = page.getByRole("list", { name: "Change history" });
  const update = history.locator("li").filter({ hasText: "Updated" }).first();
  await expect(update).toContainText("Location");
  await expect(update).toContainText(`Dahlgren ${token}`);
  await expect(history.locator("li").filter({ hasText: "Created" })).toHaveCount(1);
});
