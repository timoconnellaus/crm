// Stage 4b: the shipped Deals extension through the UI, on desktop and phone.
// - Create a deal for an organisation and move it through stages: the stage rules refuse a move
//   without its required fields, naming them. "Moved to …" shows on the deal's and the
//   organisation's timelines, and the deal on the organisation's Deals tab and panel.
// - Drag a deal across the board by stage and mark it lost: the dialog asks for the lost reason.
// - Win a deal; Sales overview (the default Home) reflects it after a refresh, and clicking the
//   KPI lands on the list of exactly those deals.
// - Pipelines and stages under Settings, the base currency, the Default pipeline setting.
import { seedRecordId } from "@relationship-os/db/seed";
import { expect, type Page, test } from "@playwright/test";
import { expectNoHorizontalScroll, isPhone, moveCard, open, unique } from "./helpers.ts";
import { createOrganisation } from "./org-helpers.ts";

const q = (value: unknown) => encodeURIComponent(JSON.stringify(value));
const NB = seedRecordId("deals", "pipeline", "newBusiness");
const stage = (key: string) => seedRecordId("deals", "stage", key);

async function choose(
  page: Page,
  scope: ReturnType<Page["getByRole"]>,
  label: string,
  option: string,
) {
  await scope.getByRole("combobox", { name: new RegExp(`^${label}( \\*)?$`) }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test("create a deal, move it through stages, and see it on both timelines", async ({ page }) => {
  const token = unique("d");
  const orgName = `Deal Co ${token}`;
  await open(page, "/organisations");
  const orgId = await createOrganisation(page, { name: orgName });

  await open(page, "/x/deals.deal");
  await expect(page.getByRole("heading", { level: 1, name: "Deals" })).toBeVisible();
  await page.getByRole("button", { name: "New deal" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/^Name( \*)?$/).fill(`Platform ${token}`);
  await dialog.getByLabel(/^Value$/).fill("24000");
  await choose(page, dialog, "Pipeline", "New business");
  await dialog.getByRole("button", { name: /^Organisation:/ }).click();
  await page.getByRole("combobox", { name: "Search for organisation" }).fill(token);
  await page.getByRole("option", { name: new RegExp(orgName) }).click();
  await dialog.getByRole("button", { name: "Create deal" }).click();

  // It starts in the pipeline's first stage with that stage's probability.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Platform ${token}`);
  const card = page.getByTestId("record-fields");
  await expect(card).toContainText("Lead");
  await expect(card).toContainText("10%");
  await expect(card).toContainText("$24,000.00");
  await expectNoHorizontalScroll(page);

  // Qualified needs an owner: the move is refused with the field named.
  await card.getByRole("button", { name: /Edit/ }).click();
  await choose(page, card, "Stage", "Qualified");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Qualified needs Owner")).toBeVisible();
  // With an owner it moves.
  await card.getByRole("combobox", { name: /^Owner$/ }).click();
  await page.getByRole("option").nth(1).click();
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByRole("button", { name: /Edit/ })).toBeVisible();
  await expect(card).toContainText("Qualified");
  await expect(card).toContainText("25%");

  // The deal's timeline shows the move.
  await page.getByRole("tab", { name: "Timeline" }).click();
  const timeline = page.getByRole("list", { name: "Timeline" });
  await expect(timeline).toContainText("Moved to Qualified");
  await expect(timeline).toContainText("Stage: Lead → Qualified");

  // And so does the organisation's.
  await open(page, `/organisations/${orgId}?tab=timeline`);
  await expect(page.getByRole("list", { name: "Timeline" })).toContainText("Moved to Qualified");

  // The organisation's Deals tab (recordTabs) lists it, and so does its Open deals panel.
  await page.getByRole("tab", { name: "Deals" }).click();
  await expect(page).toHaveURL(/tab=x%3Adeals\.organisationDeals|tab=x:deals\.organisationDeals/);
  await expect(page.getByTestId("record-main")).toContainText(`Platform ${token}`);
  if (!isPhone(page)) {
    await page.getByRole("tab", { name: "Overview" }).click();
    await expect(page.getByTestId("record-panel-deals.organisationOpenDeals")).toContainText(
      `Platform ${token}`,
    );
  }
});

/** Creates a deal (default pipeline: New business) through the New deal dialog; returns its id. */
async function createDeal(page: Page, name: string, value: string): Promise<string> {
  await open(page, "/x/deals.deal");
  await page.getByRole("button", { name: "New deal" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/^Name( \*)?$/).fill(name);
  await dialog.getByLabel(/^Value$/).fill(value);
  await dialog.getByRole("button", { name: "Create deal" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
  await expect(page.getByTestId("record-fields")).toContainText("New business");
  return page.url().split("/x/deals.deal/")[1]?.split("?")[0] ?? "";
}

test("board by stage: dragging to Lost asks for the lost reason", async ({ page }) => {
  const name = `Board deal ${unique()}`;
  await createDeal(page, name, "5000");
  // Lost is put next to Lead (columnOrder), so a desktop drag stays on screen.
  const layout = {
    groupBy: "stage",
    sumField: "value",
    cardFields: ["value"],
    columnOrder: [stage("nbLead"), stage("nbLost")],
  };
  const filter = {
    and: [
      { field: "name", op: "eq", value: name },
      { field: "pipeline", op: "eq", value: NB },
    ],
  };
  await open(page, `/x/deals.deal?vt=board&layout=${q(layout)}&filter=${q(filter)}`);
  const board = page.getByTestId("board");
  const lead = board.getByTestId(`board-column-${stage("nbLead")}`);
  const lost = board.getByTestId(`board-column-${stage("nbLost")}`);
  // Columns are the pipeline's stages, in order (after the two the layout puts first).
  await expect(board.locator("[data-testid^=board-column-] h3")).toHaveText([
    "Lead",
    "Lost",
    "Qualified",
    "Proposal",
    "Negotiation",
    "Won",
  ]);
  const card = lead.getByTestId("board-card").filter({ hasText: name });
  await expect(card).toBeVisible();
  await expect(lead.getByTestId("board-column-count")).toHaveText("1");
  await expect(lead.getByTestId("board-column-sum")).toContainText("5,000");

  await moveCard(page, card, lost, "Lost");
  const ask = page.getByTestId("missing-field-dialog");
  await expect(ask).toBeVisible();
  await expect(ask).toContainText("Lost needs Lost reason");
  await ask.getByRole("combobox").click();
  await page.getByRole("option", { name: "Price" }).click();
  await ask.getByRole("button", { name: "Move" }).click();

  await expect(lost.getByTestId("board-card").filter({ hasText: name })).toBeVisible();
  await expect(lost.getByTestId("board-column-count")).toHaveText("1");
  await expect(lead.getByTestId("board-column-count")).toHaveText("0");
  await expectNoHorizontalScroll(page);
});

test("Sales overview reflects a win and clicks through to the deals it counted", async ({
  page,
}) => {
  const name = `Won deal ${unique()}`;
  await createDeal(page, name, "4321");

  await open(page, "/");
  await expect(page.getByRole("heading", { level: 1, name: "Sales overview" })).toBeVisible();
  const kpi = page.getByTestId("widget-won");
  await expect(kpi.getByTestId("kpi-value")).toBeVisible();
  await expect(page.getByTestId("widget-pipeline-by-stage")).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Win it on the board (Won needs a value, which it has).
  const layout = {
    groupBy: "stage",
    cardFields: ["value"],
    columnOrder: [stage("nbLead"), stage("nbWon")],
  };
  const filter = { field: "name", op: "eq", value: name };
  await open(page, `/x/deals.deal?vt=board&layout=${q(layout)}&filter=${q(filter)}`);
  const board = page.getByTestId("board");
  const card = board.getByTestId("board-card").filter({ hasText: name });
  await expect(card).toBeVisible();
  await moveCard(
    page,
    card,
    board.getByTestId(`board-column-${stage("nbWon")}`),
    "New business: Won",
  );
  await expect(
    board.getByTestId(`board-column-${stage("nbWon")}`).getByTestId("board-card"),
  ).toContainText(name);

  // After a refresh the Won KPI counts it; clicking the KPI lists exactly the deals it counted.
  await open(page, "/");
  await kpi.getByRole("button", { name: /actions$/ }).click();
  await page.getByRole("menuitem", { name: "Refresh" }).click();
  await expect(kpi.getByText("cached")).toHaveCount(0);
  await kpi.getByRole("button", { name: /Open the/ }).click();
  await expect(page).toHaveURL(/\/x\/deals\.deal\?filter=/);
  // The list is exactly the KPI's deals (won, closed this quarter): narrowed to this deal's name,
  // it is there.
  const clicked = JSON.parse(new URL(page.url()).searchParams.get("filter") ?? "null");
  expect(JSON.stringify(clicked)).toContain('"won"');
  await open(page, `/x/deals.deal?filter=${q({ and: [clicked, filter] })}`);
  await expect(page.getByRole("link", { name })).toBeVisible();
  await expect(page.getByTestId("page-count")).toHaveText(/^1\b/);
});

test("pipelines and stages are set up under Settings", async ({ page }) => {
  await open(page, "/settings");
  await page.getByTestId("settings-object-deals.stage").click();
  await expect(page.getByRole("heading", { level: 1, name: "Stages" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Negotiation" })).toBeVisible();
  await open(page, "/settings");
  await page.getByTestId("settings-object-deals.pipeline").click();
  await expect(page.getByRole("link", { name: "New business" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Renewals" })).toBeVisible();
  await open(page, "/settings/general");
  await expect(page.getByRole("combobox", { name: "Currency" })).toContainText("USD");
});

test("Settings → Extensions lists the shipped Deals extension and its settings", async ({
  page,
}) => {
  await open(page, "/settings/extensions");
  const card = page.getByTestId("extension-deals");
  await expect(card).toContainText("Deals");
  await expect(card).toContainText("active");
  await expect(card).toContainText("shipped");
  await card.getByRole("button", { name: "Details" }).click();
  await expect(card).toContainText("Versions");
  await expect(card).toContainText("Run history");
  const settings = page.getByTestId("extension-settings-deals");
  await expect(settings.getByLabel("Default pipeline")).toHaveValue("New business");
});

test("the shipped saved views are in the Deals views menu", async ({ page }) => {
  await open(page, "/x/deals.deal");
  await page.getByTestId("views-menu").click();
  for (const name of [
    "My open deals",
    "Closing this month",
    "Won this quarter",
    "Pipeline board",
  ]) {
    await expect(page.getByRole("menuitem", { name })).toBeVisible();
  }
  await page.getByRole("menuitem", { name: "Pipeline board" }).click();
  await expect(page.getByTestId("board")).toBeVisible();
});
