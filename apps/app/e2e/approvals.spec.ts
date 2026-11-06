// The Approvals inbox (stage 2, AC8), at desktop and phone widths: change sets an MCP client
// queued are approved or rejected whole or item by item, dependency cascades and out-of-order
// refusals are shown, the sidebar count follows, and records show pending-change badges.
import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectNoHorizontalScroll, isPhone, open } from "./helpers.ts";
import { type SeededSet, seedChangeSet } from "./mcp.ts";

/** The sidebar's Approvals count (0 when no badge). Opens the drawer on phones. */
async function sidebarCount(page: Page): Promise<number> {
  const nav = page.getByRole("link", { name: /^Approvals/ });
  if (isPhone(page)) await page.getByRole("button", { name: "Toggle navigation" }).click();
  await expect(nav).toBeVisible();
  const badge = page.getByTestId("approvals-count");
  const text = (await badge.count()) ? await badge.textContent() : "0";
  if (isPhone(page)) await page.keyboard.press("Escape");
  return Number(text);
}

async function expectSidebarCount(page: Page, expected: number) {
  await expect(async () => expect(await sidebarCount(page)).toBe(expected)).toPass({
    timeout: 15_000,
  });
}

function changeSet(page: Page, seeded: SeededSet): Locator {
  return page.getByRole("region", { name: new RegExp(seeded.title) });
}

function item(set: Locator, title: RegExp): Locator {
  return set.getByTestId("pending-action").filter({ hasText: title });
}

const TAG = /^Update 2 people/;
const DELETE = /^Delete person/;

test("approving a whole change set applies it and lowers the count", async ({ page, baseURL }) => {
  await open(page, "/approvals");
  const before = await sidebarCount(page);
  const seeded = await seedChangeSet(page, baseURL ?? "");
  await open(page, "/approvals");
  await expectSidebarCount(page, before + 2);

  const set = changeSet(page, seeded);
  await expect(set).toBeVisible();
  await expect(set).toContainText(seeded.app.name);
  await expect(set).toContainText("2 need review");
  const tag = item(set, TAG);
  await expect(tag.getByTestId("risk-badge")).toHaveText("bulk-write");
  await expect(tag).toContainText("Agent's reason: Tag everyone from the event list");
  await expect(tag.getByTestId("change-preview")).toContainText(`+ Tags: ${seeded.tag}`);
  await expect(tag).toContainText("on 2 records");
  await tag.getByRole("button", { name: "show list" }).click();
  await expect(tag.getByTestId("record-list")).toContainText(seeded.people[1]?.name ?? "");
  const remove = item(set, DELETE);
  await expect(remove.getByTestId("risk-badge")).toHaveText("destructive");
  await expect(remove.getByTestId("change-preview")).toContainText("Moved to Trash");
  await expect(remove).toContainText(seeded.people[0]?.name ?? "");
  await expectNoHorizontalScroll(page);

  // A delete is high risk: the button takes two presses (ADR 0345).
  await set.getByRole("button", { name: "Approve 2 changes" }).click();
  await set.getByRole("button", { name: "Confirm: approve 2 changes" }).click();
  await expect(set.getByTestId("decision-result")).toHaveText("Applied 2 changes.");
  await expect(tag.getByTestId("status-badge")).toHaveText("Applied");
  await expect(remove.getByTestId("status-badge")).toHaveText("Applied");
  await expectSidebarCount(page, before);

  // It applied: the second person has the tag, the first is in Trash.
  await open(page, `/people/${seeded.people[1]?.id}`);
  await expect(page.getByText(seeded.tag).first()).toBeVisible();
  await open(page, `/people/${seeded.people[0]?.id}`);
  await expect(page.getByTestId("trash-banner")).toBeVisible();

  // History lists it, decided.
  await open(page, "/approvals?tab=history");
  await expect(changeSet(page, seeded)).toContainText("2 applied");
});

test("rejecting one change also rejects what depends on it", async ({ page, baseURL }) => {
  const seeded = await seedChangeSet(page, baseURL ?? "");
  await open(page, "/approvals");
  const set = changeSet(page, seeded);
  // Only the tag action: the delete depends on it.
  await item(set, DELETE).getByRole("checkbox").uncheck();
  await set.getByRole("button", { name: "Reject 1" }).click();
  await expect(set.getByTestId("decision-result")).toHaveText(
    "Rejected 1 change. Rejecting this also rejected 1 dependent action.",
  );
  await expect(item(set, TAG).getByTestId("status-badge")).toHaveText("Rejected");
  await expect(item(set, DELETE).getByTestId("status-badge")).toHaveText("Rejected");
  await expect(item(set, DELETE).getByTestId("status-reason")).toContainText(
    "depends on was rejected",
  );
  // Nothing applied.
  await open(page, `/people/${seeded.people[0]?.id}`);
  await expect(page.getByRole("heading", { level: 1, name: seeded.people[0]?.name })).toBeVisible();
  await expect(page.getByTestId("trash-banner")).toHaveCount(0);
});

test("rejecting a whole change set", async ({ page, baseURL }) => {
  const seeded = await seedChangeSet(page, baseURL ?? "");
  await open(page, "/approvals");
  const set = changeSet(page, seeded);
  await set.getByRole("button", { name: "Reject all" }).click();
  await expect(set.getByTestId("decision-result")).toHaveText("Rejected 2 changes.");
  await expect(set.getByTestId("status-badge")).toHaveText(["Rejected", "Rejected"]);
  await expect(set.getByRole("button", { name: /^Approve/ })).toHaveCount(0);
});

test("approving a single change, and refusing it out of order", async ({ page, baseURL }) => {
  const seeded = await seedChangeSet(page, baseURL ?? "");
  await open(page, "/approvals");
  const set = changeSet(page, seeded);
  // The delete alone: it depends on the pending tag action, so it is refused.
  await item(set, TAG).getByRole("checkbox").uncheck();
  await set.getByTestId("approval-two-step").click();
  await set.getByTestId("approval-two-step-confirm").click();
  await expect(set.getByTestId("decision-error")).toContainText("Approve it first");
  await expect(item(set, DELETE).getByTestId("status-badge")).toHaveCount(0);

  // The tag action alone applies; the delete stays pending.
  await item(set, TAG).getByRole("checkbox").check();
  await item(set, DELETE).getByRole("checkbox").uncheck();
  await set.getByRole("button", { name: "Approve" }).click();
  await expect(set.getByTestId("decision-result")).toHaveText("Applied 1 change.");
  await expect(item(set, TAG).getByTestId("status-badge")).toHaveText("Applied");
  await expect(item(set, DELETE)).toHaveAttribute("data-status", "pending");
  await expect(set).toContainText("1 needs review");

  // Clean up: reject the rest.
  await set.getByRole("button", { name: "Reject" }).click();
  await expect(set.getByTestId("decision-result")).toHaveText("Rejected 1 change.");
});

test("records show their pending changes", async ({ page, baseURL }) => {
  const seeded = await seedChangeSet(page, baseURL ?? "");
  const [first, second] = seeded.people;

  // Record header: the first person has both actions pending, the second one.
  await open(page, `/people/${second?.id}`);
  const header = page.getByTestId("record-header");
  await expect(header.getByTestId("pending-badge")).toHaveText("1 pending change");
  await open(page, `/people/${first?.id}`);
  await expect(header.getByTestId("pending-badge")).toHaveText("2 pending changes");
  await header.getByTestId("pending-badge").click();
  const popover = page.getByRole("dialog");
  await expect(popover).toContainText("Update person");
  await expect(popover).toContainText("Delete person");
  await expect(popover).toContainText("Agent's reason: Duplicate created by the CSV import");
  await popover.getByRole("link", { name: "Review" }).first().click();
  await expect(page).toHaveURL(new RegExp(`/approvals\\?set=${seeded.changeSetId}`));
  await expect(changeSet(page, seeded)).toBeVisible();

  // List rows, filtered to these two people.
  const filter = { field: "displayName", op: "contains", value: first?.name.split(" ")[1] };
  await open(page, `/people?filter=${encodeURIComponent(JSON.stringify(filter))}`);
  const rows = page.getByRole("table", { name: "People" }).locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.getByTestId("pending-badge")).toHaveCount(2);

  // Clean up.
  await open(page, `/approvals?set=${seeded.changeSetId}`);
  await changeSet(page, seeded).getByRole("button", { name: "Reject all" }).click();
  await expect(changeSet(page, seeded).getByTestId("decision-result")).toBeVisible();
  await open(page, `/people/${first?.id}`);
  await expect(page.getByRole("heading", { level: 1, name: first?.name })).toBeVisible();
  await expect(page.getByTestId("pending-badge")).toHaveCount(0);
});
