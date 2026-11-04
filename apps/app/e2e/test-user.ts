// The Better Auth test user the smoke test signs in as. Created by global-setup through the
// sign-up API, which local development opens with AUTH_ALLOW_SIGNUP=true (.dev.vars.example).
export const TEST_USER = {
  name: "E2E User",
  email: "e2e@example.com",
  password: "e2e-password-not-secret",
};
