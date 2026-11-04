import type { FullConfig } from "@playwright/test";
import { TEST_USER } from "./test-user.ts";

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
}
