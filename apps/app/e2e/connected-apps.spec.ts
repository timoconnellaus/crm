// The OAuth consent page and Settings → Connected apps (stage 2, AC8), at desktop and phone
// widths: an app connects through the consent page, shows up for its user and for admins, and
// stops working once revoked.
import { expect, test } from "@playwright/test";
import { expectNoHorizontalScroll, open } from "./helpers.ts";
import { call, connectApp, mcpClient } from "./mcp.ts";

test("the consent page renders at this width and allows", async ({ page, baseURL }) => {
  const app = await connectApp(page, baseURL ?? "");
  const tools = await app.client.listTools();
  expect(tools.tools.map((t) => t.name)).toContain("search_global");
  expect(await call(app.client, "search_global", { query: "anything" })).toHaveProperty("hits");
});

test("consent fits a phone and offers admin to admins", async ({ page, baseURL }) => {
  // Stop on the consent page itself (no Allow) to look at it.
  const registered = await fetch(`${baseURL}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Layout check",
      redirect_uris: ["http://localhost:5999/e2e-callback"],
      token_endpoint_auth_method: "none",
    }),
  });
  const { client_id } = (await registered.json()) as { client_id: string };
  const url = new URL("/oauth/consent", baseURL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: "http://localhost:5999/e2e-callback",
    scope: "read write",
    code_challenge: "x".repeat(43),
    code_challenge_method: "S256",
  }).toString();
  await page.goto(url.toString());
  await expect(
    page.getByRole("heading", { name: "Connect Layout check to Relationship OS?" }),
  ).toBeVisible();
  await expect(page.getByText("Signed in as")).toContainText("e2e@example.com");
  // The e2e user is the first user, so an admin: admin is offered, unchecked.
  await expect(page.getByRole("checkbox", { name: /Admin/ })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Deny" })).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test("an app is listed in Connected apps and stops working once revoked", async ({
  page,
  baseURL,
}) => {
  const app = await connectApp(page, baseURL ?? "");
  await call(app.client, "search_global", { query: "warm up" });

  await open(page, "/settings/connected-apps");
  await expect(page.getByRole("heading", { level: 1, name: "Connected apps" })).toBeVisible();
  const mine = page.getByRole("list", { name: "Your connected apps" });
  const row = mine.getByTestId("connected-app").filter({ hasText: app.name });
  await expect(row).toContainText("read");
  await expect(row).toContainText("write");
  await expect(row).toContainText(/last used (just now|\d+ minutes? ago)/);
  // Admins also see it in everyone's apps.
  await expect(
    page
      .getByRole("list", { name: "Every user's connected apps" })
      .getByTestId("connected-app")
      .filter({ hasText: app.name }),
  ).toContainText("E2E User");
  await expectNoHorizontalScroll(page);

  await row.getByRole("button", { name: `Revoke ${app.name}` }).click();
  const dialog = page.getByRole("alertdialog", { name: `Disconnect ${app.name}?` });
  await dialog.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText(`Disconnected ${app.name}`)).toBeVisible();
  await expect(row).toHaveCount(0);

  // Its token no longer works.
  await expect(mcpClient(baseURL ?? "", app.accessToken)).rejects.toThrow();

  await page.getByLabel("Show disconnected").check();
  await expect(mine.getByTestId("connected-app").filter({ hasText: app.name })).toContainText(
    "Disconnected",
  );
});
