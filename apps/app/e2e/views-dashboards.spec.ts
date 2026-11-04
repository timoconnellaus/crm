// Stage 4a: view types and dashboards, desktop and phone. A board drag that a stage rule refuses
// asks for the missing field; a calendar drag moves a task's due date; people as a gallery; the
// Overview Home renders, follows its filters and clicks through to the records it counted;
// "Describe a widget" (with the local stand-in model) builds a widget; the example extension's
// Projects tab shows on organisation pages.
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  createPerson,
  expectNoHorizontalScroll,
  isPhone,
  open,
  pressUntil,
  unique,
} from "./helpers.ts";
import { createOrganisation } from "./org-helpers.ts";

const q = (value: unknown) => encodeURIComponent(JSON.stringify(value));

/** Drags `source` onto `target`; on phones (touch) uses the card's own "Move to" menu instead. */
async function moveCard(page: Page, source: Locator, target: Locator, menuChoice: string) {
  if (isPhone(page)) {
    // The menu can re-render while the board settles; reopen it until the choice takes.
    await expect(async () => {
      if (!(await page.getByRole("menuitem", { name: menuChoice }).isVisible())) {
        await source.getByRole("button", { name: /^Move / }).click();
      }
      await page.getByRole("menuitem", { name: menuChoice }).click({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    return;
  }
  await source.dragTo(target);
}

test("board: a stage rule asks for the missing field, then the card moves", async ({ page }) => {
  const name = `Board ${unique()}`;
  await open(page, "/x/example.project");
  await page.getByRole("button", { name: "New project" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);

  const layout = { groupBy: "status", sumField: "budget", cardFields: ["budget", "spent"] };
  await open(
    page,
    `/x/example.project?vt=board&layout=${q(layout)}&filter=${q({ field: "name", op: "eq", value: name })}`,
  );
  const board = page.getByTestId("board");
  const none = board.getByTestId("board-column-__none__");
  const done = board.getByTestId("board-column-done");
  const card = none.getByTestId("board-card").filter({ hasText: name });
  await expect(card).toBeVisible();
  await expect(none.getByTestId("board-column-count")).toHaveText("1");
  await expect(done.getByTestId("board-column-count")).toHaveText("0");

  // Done needs Spent: the move is refused and a dialog asks for it.
  await moveCard(page, card, done, "Done");
  const ask = page.getByTestId("missing-field-dialog");
  await expect(ask).toBeVisible();
  await expect(ask).toContainText("Spent");
  await ask.getByLabel("Spent").fill("250");
  await ask.getByRole("button", { name: "Move" }).click();

  await expect(done.getByTestId("board-card").filter({ hasText: name })).toBeVisible();
  await expect(done.getByTestId("board-column-count")).toHaveText("1");
  await expect(none).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});

function dayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

test("calendar: dragging a task to another day changes its due date", async ({ page }) => {
  const title = `Calendar ${unique()}`;
  const today = new Date();
  const other = new Date(today);
  other.setDate(today.getDate() + (today.getDate() < 20 ? 1 : -1));
  await open(page, "/tasks?tab=all");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await pressUntil(page, "c", dialog);
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByLabel("Due date").fill(dayKey(today));
  await dialog.getByRole("button", { name: /Add task|Create task|Save/ }).click();
  await expect(dialog).toHaveCount(0);

  const layout = { dateField: "dueAt", mode: "month", cardFields: [] };
  await open(
    page,
    `/tasks?tab=all&vt=calendar&layout=${q(layout)}&filter=${q({ field: "title", op: "eq", value: title })}`,
  );
  const from = page.getByTestId(`calendar-day-${dayKey(today)}`);
  const to = page.getByTestId(`calendar-day-${dayKey(other)}`);
  const event = from.getByTestId("calendar-event").filter({ hasText: title });
  await expect(event).toBeVisible();
  if (isPhone(page)) {
    await event.getByRole("button", { name: /to another date/ }).click();
    await page.getByLabel("New date").fill(dayKey(other));
    await page.getByRole("button", { name: "Move", exact: true }).click();
  } else {
    await event.dragTo(to);
  }
  await expect(to.getByTestId("calendar-event").filter({ hasText: title })).toBeVisible();
  await expect(from.getByTestId("calendar-event").filter({ hasText: title })).toHaveCount(0);

  // Week and agenda modes show it too.
  await page.getByRole("tab", { name: "Agenda" }).click();
  await expect(page.getByTestId("calendar-agenda")).toContainText(title);
});

test("people as a gallery", async ({ page }) => {
  await createPerson(page, { given: "Grace", family: `Gallery${unique()}` });
  await open(
    page,
    `/people?vt=gallery&layout=${q({ cardFields: ["jobTitle", "organisationName"] })}`,
  );
  await expect(page.getByTestId("gallery")).toBeVisible();
  await expect(page.getByTestId("gallery-card").first()).toBeVisible();
  await expect(page.getByTestId("view-type-gallery")).toHaveAttribute("aria-checked", "true");
  await expectNoHorizontalScroll(page);

  // Switching view type keeps the list's filter and goes back to the table.
  await page.getByTestId("view-type-table").click();
  await expect(page.getByRole("table", { name: "People" })).toBeVisible();
});

test("the Overview Home renders, follows its filters and clicks through", async ({ page }) => {
  await open(page, "/");
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  const kpi = page.getByTestId("widget-people-added");
  await expect(kpi.getByTestId("kpi-value")).toBeVisible();
  await expect(page.getByTestId("widget-activities-by-type")).toBeVisible();
  await expectNoHorizontalScroll(page);

  // All time: the URL keeps the filter, and the KPI counts every person.
  await page.getByTestId("filter-date").click();
  await page.getByRole("option", { name: "All time" }).click();
  await expect(page).toHaveURL(/filters=/);
  await expect(kpi.getByTestId("kpi-change")).toHaveCount(0);
  // Results are cached for 60 s; refresh so the count includes people other specs just added.
  await kpi.getByRole("button", { name: /actions$/ }).click();
  await page.getByRole("menuitem", { name: "Refresh" }).click();
  await expect(kpi.getByText("cached")).toHaveCount(0);
  const counted = (await kpi.getByTestId("kpi-value").innerText()).trim();

  // Clicking the KPI opens People filtered to exactly those records.
  await kpi.getByRole("button", { name: /Open the/ }).click();
  await expect(page).toHaveURL(/\/people\?filter=/);
  await expect(page.getByRole("heading", { level: 1, name: "People" })).toBeVisible();
  await expect(page.getByTestId("page-header")).toContainText(`${counted} people`);
});

test("describe a widget with the local model, and save it to a new dashboard", async ({ page }) => {
  const title = `Describe ${unique()}`;
  await open(page, "/dashboards");
  await page.getByTestId("new-dashboard").click();
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();

  await page.getByTestId("edit-dashboard").click();
  await page.getByTestId("add-widget").click();
  const editor = page.getByTestId("widget-editor");
  await editor.getByRole("tab", { name: "Describe a widget" }).click();
  await editor.getByLabel("What should it show?").fill("a bar chart of tasks by status");
  await editor.getByTestId("describe-widget").click();
  await expect(editor.getByTestId("widget-preview")).toBeVisible();
  await expect(editor).toContainText("Tasks by status");
  await editor.getByTestId("save-widget").click();
  await expect(editor).toHaveCount(0);

  const widget = page.getByTestId("widget-tasks-by-status");
  await expect(widget).toBeVisible();
  await expect(widget.locator(".recharts-bar-rectangle").first()).toBeVisible();

  // Admins see its SQL.
  await widget.getByRole("button", { name: /actions$/ }).click();
  await page.getByRole("menuitem", { name: "View SQL" }).click();
  await expect(page.getByTestId("widget-sql")).toContainText("FROM crm_tasks");
});

test("the example extension's Projects tab on an organisation page", async ({ page }) => {
  const name = `Tabbed ${unique()}`;
  await createOrganisation(page, { name });
  await page.getByRole("tab", { name: "Projects" }).click();
  await expect(page).toHaveURL(/tab=x%3Aexample\.projects|tab=x:example\.projects/);
  await expect(page.getByTestId("record-main")).toContainText(/No projects yet|Name/);
  // Its panel (a board of the organisation's projects) is in the side panel on desktop.
  if (!isPhone(page)) {
    await page.getByRole("tab", { name: "Overview" }).click();
    await expect(page.getByTestId("record-panel-example.projectBoard")).toBeVisible();
  }
});
