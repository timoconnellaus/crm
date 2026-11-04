// Stage 8 AC3/AC4 against a real deployment (install-test.yml). One phase per run, picked by
// LIVE_PHASE, sharing what it made through e2e/live/.state.json:
//
//   install      sign up the first admin, skip the wizard, create a person, connect an MCP client
//                (dynamic registration, consent, token, tools/list) and install a runtime extension
//                through an MCP proposal approved in the inbox
//   verify       the person and the extension are still there, at LIVE_EXPECT_VERSION
//   self-update  Settings → Updates: preflight, then Update to LIVE_TARGET_VERSION, then verify
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { call } from "../mcp.ts";
import { connectAdminApp, extensionId, projectsSource, writeCheckPropose } from "../extension-authoring.ts";
import { createPerson, open, unique } from "../helpers.ts";

const PHASE = process.env.LIVE_PHASE ?? "install";
const STATE = join(dirname(fileURLToPath(import.meta.url)), ".state.json");
const ADMIN = { name: "Live Admin", email: "live-admin@example.com", password: `live-${process.env.GITHUB_RUN_ID ?? "local"}-password` };

interface LiveState {
  person: string;
  extension: string;
  password: string;
}

async function signIn(context: BrowserContext, baseURL: string, password: string) {
  const response = await fetch(`${baseURL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseURL },
    body: JSON.stringify({ email: ADMIN.email, password }),
  });
  expect(response.ok, `sign-in: ${response.status}`).toBe(true);
  const { hostname } = new URL(baseURL);
  await context.addCookies(
    response.headers.getSetCookie().map((header) => {
      const [pair = ""] = header.split(";");
      const [name = "", ...value] = pair.split("=");
      return { name, value: value.join("="), domain: hostname, path: "/", secure: true, sameSite: "Lax" as const };
    }),
  );
}

async function expectVersion(page: Page, version: string | undefined) {
  if (!version) return;
  const health = await (await page.request.get("/api/health")).json();
  expect(health).toMatchObject({ status: "ok", version, database: { upToDate: true } });
}

test("live deployment", async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error("LIVE_BASE_URL is not set");

  if (PHASE === "install") {
    const signup = await fetch(`${baseURL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseURL },
      body: JSON.stringify(ADMIN),
    });
    expect(signup.ok, `sign-up: ${signup.status} ${await signup.clone().text()}`).toBe(true);
    await signIn(context, baseURL, ADMIN.password);

    // The first visit opens the setup wizard; skip it.
    await open(page, "/");
    await expect(page).toHaveURL(/\/setup$/);
    await page.getByTestId("setup-skip").click();
    await expect(page).toHaveURL(/\/$/);

    // Create a person.
    const family = unique("Live");
    await createPerson(page, { given: "Grace", family });

    // MCP handshake and a runtime extension, approved in the inbox.
    const app = await connectAdminApp(page, baseURL);
    const tools = await app.client.listTools();
    expect(tools.tools.length).toBeGreaterThan(5);
    const found = await call(app.client, "search_global", { query: family });
    expect(JSON.stringify(found)).toContain(family);
    const id = extensionId("live");
    const proposal = await writeCheckPropose(app, id, { "index.ts": projectsSource(id) }, "Live test extension");
    await open(page, "/approvals");
    const set = page.locator(`[data-change-set="${proposal.changeSetId}"]`);
    await set.getByRole("button", { name: "Approve" }).click();
    await expect(set.getByTestId("decision-result")).toHaveText(/Applied 1 change/);
    await open(page, `/x/${id}.project`);
    await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();

    writeFileSync(STATE, JSON.stringify({ person: `Grace ${family}`, extension: id, password: ADMIN.password }));
    await expectVersion(page, process.env.LIVE_EXPECT_VERSION);
    return;
  }

  if (!existsSync(STATE)) throw new Error("run LIVE_PHASE=install first");
  const state = JSON.parse(readFileSync(STATE, "utf8")) as LiveState;
  await signIn(context, baseURL, state.password);

  if (PHASE === "self-update") {
    const target = process.env.LIVE_TARGET_VERSION;
    if (!target) throw new Error("LIVE_TARGET_VERSION is not set");
    await open(page, "/settings/updates");
    await page.getByRole("button", { name: "Check now" }).click();
    const release = page.getByTestId(`release-${target}`);
    await expect(release).toBeVisible();
    await release.getByRole("button", { name: "Preflight" }).click();
    await expect(release.getByTestId("preflight")).toContainText("Ready to update");
    await release.getByRole("button", { name: "Update" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Update" }).click();
    await expect(page.getByText(`Updated to ${target}`)).toBeVisible({ timeout: 8 * 60_000 });
    await expect(async () => expectVersion(page, target)).toPass({ timeout: 3 * 60_000 });
  }

  // verify (and after self-update): data and the runtime extension survived.
  await expectVersion(page, process.env.LIVE_EXPECT_VERSION);
  await open(page, "/people");
  await expect(page.getByText(state.person).first()).toBeVisible();
  await open(page, `/x/${state.extension}.project`);
  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
});
