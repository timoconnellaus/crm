// Stage 4a: view types and dashboards, desktop and phone. A calendar drag moves a task's due date;
// people as a gallery; the Overview renders, follows its filters and clicks through to the
// records it counted; "Describe a widget" (with the local stand-in model) builds a widget. The
// board, record tab, panel and extension settings run on the Deals extension in deals.spec.ts.
import { expect, test } from "@playwright/test";
import {
  createPerson,
  expectNoHorizontalScroll,
  isPhone,
  open,
  pressUntil,
  unique,
} from "./helpers.ts";

const q = (value: unknown) => encodeURIComponent(JSON.stringify(value));

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

test("the Overview renders, follows its filters and clicks through", async ({ page }) => {
  // With Deals installed, Home is Sales overview (deals.spec.ts); the Overview is a dashboard.
  await open(page, "/dashboards/dsh_overview");
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
