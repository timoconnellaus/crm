// Stage 3b, AC7: the approval screen for an extension proposal, at desktop and phone widths. An MCP
// client writes, checks and proposes a Projects extension; the Approvals inbox shows the diff
// (per file, highlighted), the host-computed impact, the check result and the AI summary,
// labelled as AI-written (the dev server has no AI binding, so it says none is available).
// Approving installs it.
import { expect, test } from "@playwright/test";
import {
  connectAdminApp,
  extensionId,
  projectsSource,
  writeCheckPropose,
} from "./extension-authoring.ts";
import { expectNoHorizontalScroll, open } from "./helpers.ts";

test("an extension proposal shows its diff, impact, check and AI summary, and installs on approval", async ({
  page,
  baseURL,
}) => {
  const app = await connectAdminApp(page, baseURL ?? "");
  const id = extensionId("apr");
  const proposal = await writeCheckPropose(
    app,
    id,
    { "index.ts": projectsSource(id) },
    "Add projects for organisations",
  );

  await open(page, "/approvals");
  const set = page.locator(`[data-change-set="${proposal.changeSetId}"]`);
  await expect(set).toBeVisible();
  const item = set.locator(`[data-action="${proposal.actionId}"]`);
  await expect(item).toContainText(`Install extension ${id} 1.0.0`);
  await expect(item.getByTestId("risk-badge")).toHaveText("extension");
  await expect(item).toContainText("Reason: Add projects for organisations");

  // The AI summary is labelled; without AI configured it says so.
  const ai = item.getByTestId("ai-summary");
  await expect(ai).toContainText("AI-written");
  await expect(ai).toContainText("No AI summary available");

  // The impact is the host's: new object and fields, permissions, modules, risk.
  const impact = item.getByTestId("extension-impact");
  await expect(impact).toContainText("New extension");
  await expect(impact).toContainText(`${id}.project`);
  await expect(impact).toContainText(`${id}.project.openBudget`);
  await expect(impact).toContainText("read organisation");
  await expect(impact).toContainText("codemode:crm");
  await expect(impact).toContainText("schema");

  await expect(item.getByTestId("extension-check")).toContainText("Check passed");

  // The diff, per file, syntax-highlighted.
  const diff = item.getByTestId("extension-diff");
  await expect(diff).toContainText("1 file");
  const file = diff.locator('[data-path="index.ts"]');
  await expect(file).toContainText("new");
  await expect(file.locator('tr[data-op="+"]').first()).toBeVisible();
  await expect(file.locator("span", { hasText: /^export$/ }).first()).toHaveClass(/text-purple/);
  await expectNoHorizontalScroll(page);

  await set.getByRole("button", { name: "Approve" }).click();
  await expect(set.getByTestId("decision-result")).toHaveText(/Applied 1 change/);
  await expect(item.getByTestId("status-badge")).toHaveText("Applied");

  // Installed: its object has a list page.
  await open(page, `/x/${id}.project`);
  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
});
