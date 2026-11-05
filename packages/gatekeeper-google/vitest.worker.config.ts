import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

// Local change: upstream reads these from cloudflare.config.ts, which we do not keep (wrangler.jsonc
// is our source of truth). Keep them in step with wrangler.jsonc. `assert-workerd` below comes
// from @relationship-os/gatekeeper-interface instead of upstream's @gadgets/scripts.
const compatibilityDate = "2026-09-04";
const compatibilityFlags = ["allow_irrevocable_stub_storage", "nodejs_als"];

/** Workerd coverage for Google resource configurators and the Gmail, Chat, Calendar and BigQuery Durable Objects. */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/workerd/worker.ts",
      miniflare: {
        compatibilityDate,
        compatibilityFlags,
        bindings: {
          CLIENT_ID: "test-client",
          CLIENT_SECRET: "test-secret",
          PUBSUB_CHAT_TOPIC: "projects/test/topics/chat",
          PUBSUB_GMAIL_TOPIC: "projects/test/topics/gmail",
          PUBSUB_PUSH_SERVICE_ACCOUNT: "push@test.iam.gserviceaccount.com",
        },
        durableObjects: {
          BigQueryGatekeeperImpl: { className: "BigQueryGatekeeperImpl", useSQLite: true },
          ChatHookDriver: { className: "ChatHookDriver", useSQLite: true },
          GmailGatekeeperImpl: { className: "GmailGatekeeperImpl", useSQLite: true },
          GmailHookDriver: { className: "GmailHookDriver", useSQLite: true },
          GoogleCalendarGatekeeperImpl: {
            className: "GoogleCalendarGatekeeperImpl",
            useSQLite: true,
          },
          GoogleChatGatekeeperImpl: { className: "GoogleChatGatekeeperImpl", useSQLite: true },
          TestHooks: { className: "TestHooks", useSQLite: true },
          UserAccount: { className: "UserAccount", useSQLite: true },
        },
      },
    }),
  ],
  test: {
    testTimeout: 15_000,
    include: [
      "__tests__/workerd/bigquery-observers.test.ts",
      "__tests__/workerd/calendar-observers.test.ts",
      "__tests__/workerd/chat-actions.test.ts",
      "__tests__/workerd/chat-hooks.test.ts",
      "__tests__/workerd/configurators.test.ts",
      "__tests__/workerd/gmail-actions.test.ts",
      "__tests__/workerd/gmail-hooks.test.ts",
      "__tests__/workerd/gmail-state.test.ts",
    ],
    setupFiles: ["@relationship-os/gatekeeper-interface/testing/assert-workerd"],
  },
});
