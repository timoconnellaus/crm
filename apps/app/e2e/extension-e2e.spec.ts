// Stage 3, AC6, end to end via MCP: an MCP client writes a "Projects" extension (an object linked
// to Organisations, a status select, a budget currency and a formula field), checks and proposes
// it; a person approves it in the Approvals inbox; records are created over MCP and in the UI; v2
// adds a field and is approved; rolling back to v1 in Settings → Extensions keeps the data.
import { expect, test } from "@playwright/test";
import {
  connectAdminApp,
  extensionId,
  projectsSource,
  writeCheckPropose,
} from "./extension-authoring.ts";
import { isPhone, open, unique } from "./helpers.ts";
import { call } from "./mcp.ts";

test("write, check, propose, approve, use, extend and roll back a Projects extension", async ({
  page,
  baseURL,
}) => {
  test.skip(
    isPhone(page),
    "One end-to-end run is enough; the phone layout is covered by AC7's spec",
  );
  test.setTimeout(180_000);
  const app = await connectAdminApp(page, baseURL ?? "");
  const id = extensionId("prj");
  const object = `${id}.project`;

  // v1: write, check, propose over MCP; approve in the inbox.
  const v1 = await writeCheckPropose(app, id, { "index.ts": projectsSource(id) }, "Track projects");
  await open(page, "/approvals");
  const set1 = page.locator(`[data-change-set="${v1.changeSetId}"]`);
  await set1.getByRole("button", { name: "Approve" }).click();
  await expect(set1.getByTestId("decision-result")).toHaveText(/Applied 1 change/);

  // Use it over MCP: a project for an organisation; the formula computes in the view.
  const org = await call(app.client, "organisation_create", {
    name: `Projects Co ${unique()}`,
    reason: "Organisation for the projects test",
  });
  const viaMcp = await call(app.client, "call_operation", {
    name: "record.create",
    input: {
      object,
      values: { name: "Website rebuild", organisation: org.id, status: "active", budget: 12000 },
    },
    reason: "Project the client asked for",
  });
  const projectId = String(viaMcp.id);
  expect(projectId).toMatch(/^rec_/);
  const got = await call(app.client, "call_operation", {
    name: "record.get",
    input: { object, id: projectId },
  });
  expect(got.values).toMatchObject({
    name: "Website rebuild",
    organisation: org.id,
    status: "active",
    budget: 12000,
    openBudget: 12000,
  });

  // And in the UI.
  await open(page, `/x/${object}`);
  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
  await page.getByRole("button", { name: "New project" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("Brand refresh");
  await dialog.getByLabel("Budget").fill("3000");
  await dialog.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Brand refresh");
  await expect(page.getByTestId("formula-openBudget")).toContainText("3,000");

  // v2 adds a field.
  const v2 = await writeCheckPropose(
    app,
    id,
    {
      "index.ts": projectsSource(
        id,
        "1.1.0",
        `\n        code: { type: "text", label: "Project code" },`,
      ),
    },
    "Add a project code",
  );
  await open(page, "/approvals");
  const set2 = page.locator(`[data-change-set="${v2.changeSetId}"]`);
  const item2 = set2.locator(`[data-action="${v2.actionId}"]`);
  await expect(item2.getByTestId("extension-impact")).toContainText(`${object}.code`);
  await expect(item2.getByTestId("extension-impact")).toContainText("1.0.0 → 1.1.0");
  await expect(item2.getByTestId("extension-diff")).toContainText("+2 −1");
  await set2.getByRole("button", { name: "Approve" }).click();
  await expect(set2.getByTestId("decision-result")).toHaveText(/Applied 1 change/);
  await call(app.client, "call_operation", {
    name: "record.update",
    input: { object, id: projectId, values: { code: "WEB-1" } },
    reason: "Code from the client's PO",
  });

  // Roll back to v1 in Settings → Extensions.
  await open(page, "/settings/extensions");
  const card = page.getByTestId(`extension-${id}`);
  await expect(card).toContainText("1.1.0");
  await card.getByRole("button", { name: "Details" }).click();
  const v1Row = card.getByRole("listitem").filter({ hasText: v1.commit.slice(0, 8) });
  await v1Row.getByRole("button", { name: "Roll back" }).click();
  await expect(page.getByText(/rolled back to v1\.0\.0/)).toBeVisible();

  // v1 again, with its data intact; v2's field is hidden (kept for 30 days).
  const after = await call(app.client, "call_operation", {
    name: "record.get",
    input: { object, id: projectId },
  });
  expect(after.values).toMatchObject({
    name: "Website rebuild",
    organisation: org.id,
    status: "active",
    budget: 12000,
    openBudget: 12000,
  });
  expect((after.values as Record<string, unknown>).code).toBeUndefined();
  await open(page, `/x/${object}`);
  await expect(page.getByRole("link", { name: "Brand refresh" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Website rebuild" })).toBeVisible();
});
