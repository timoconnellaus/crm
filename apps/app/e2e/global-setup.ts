import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type FullConfig } from "@playwright/test";
import { TEST_USER } from "./test-user.ts";

const STORAGE_STATE = join(dirname(fileURLToPath(import.meta.url)), ".auth/user.json");

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error("baseURL is not set");
  const response = await fetch(`${baseURL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseURL },
    body: JSON.stringify(TEST_USER),
  });
  // 422: the user exists from an earlier run.
  if (!response.ok && response.status !== 422) {
    throw new Error(`could not create the test user: ${response.status} ${await response.text()}`);
  }

  // Sign in once and save the session cookie for the signed-in projects.
  const signIn = await fetch(`${baseURL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseURL },
    body: JSON.stringify({ email: TEST_USER.email, password: TEST_USER.password }),
  });
  if (!signIn.ok) throw new Error(`could not sign in the test user: ${signIn.status}`);
  const { hostname } = new URL(baseURL);
  const cookies = signIn.headers.getSetCookie().map((header) => {
    const [pair = "", ...attributes] = header.split(";").map((part) => part.trim());
    const [name = "", ...value] = pair.split("=");
    const flags = attributes.map((a) => a.toLowerCase());
    return {
      name,
      value: value.join("="),
      domain: hostname,
      path: "/",
      expires: -1,
      httpOnly: flags.includes("httponly"),
      secure: flags.includes("secure"),
      sameSite: "Lax" as const,
    };
  });
  mkdirSync(dirname(STORAGE_STATE), { recursive: true });
  writeFileSync(STORAGE_STATE, JSON.stringify({ cookies, origins: [] }, null, 2));

  // The first-run setup wizard opens for the first admin (stage 8). Skip it once here so the other
  // specs land where they navigate; setup-wizard.spec.ts reopens it from Settings → General.
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ baseURL, storageState: STORAGE_STATE });
    const page = await context.newPage();
    await page.goto("/setup");
    await page.locator("html[data-hydrated]").waitFor({ state: "attached", timeout: 60_000 });
    const skip = page.getByTestId("setup-skip");
    if (await skip.isVisible().catch(() => false)) {
      await skip.click();
      await page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
    }
  } finally {
    await browser.close();
  }
}
