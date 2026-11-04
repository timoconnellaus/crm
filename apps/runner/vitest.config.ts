import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineWorkersTestConfig } from "@crm/config/vitest";
import { build } from "esbuild";

const migrationsDir = fileURLToPath(new URL("../../packages/db/migrations", import.meta.url));

/**
 * Our own gatekeepers (packages/gatekeeper-webhook, packages/gatekeeper-email-send), bundled to
 * run next to the runner as auxiliary Workers, so tests drive the real gatekeepers through the
 * integration host.
 */
async function bundleGatekeeper(name: "webhook" | "email-send"): Promise<string> {
  const outfile = fileURLToPath(
    new URL(`./.wrangler/test-gatekeepers/${name}.js`, import.meta.url),
  );
  await build({
    entryPoints: [
      fileURLToPath(new URL(`../../packages/gatekeeper-${name}/src/worker.ts`, import.meta.url)),
    ],
    outfile,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*", "node:*"],
    loader: { ".txt": "text" },
    // types.txt is a symlink to types.d.ts: load it as text, not as the .d.ts it points to.
    preserveSymlinks: true,
    logLevel: "error",
  });
  return outfile;
}

/**
 * Stands in for Cloudflare Email Service's `send_email` binding of the email-send gatekeeper
 * (stage 6b notification tests): `FakeEmail.send()` keeps each message; the runner's tests read
 * them through `TEST_EMAIL_OUTBOX` (`Outbox.list()`).
 */
const FAKE_EMAIL_SERVICE = `
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
export class Sent extends DurableObject {
  async add(message) {
    const list = (await this.ctx.storage.get("sent")) ?? [];
    list.push(message);
    await this.ctx.storage.put("sent", list);
  }
  async list() {
    return (await this.ctx.storage.get("sent")) ?? [];
  }
}
export class FakeEmail extends WorkerEntrypoint {
  async send(message) {
    await this.env.SENT.getByName("all").add(JSON.parse(JSON.stringify(message)));
    return { messageId: "fake-" + Date.now() };
  }
}
export class Outbox extends WorkerEntrypoint {
  async list() {
    return this.env.SENT.getByName("all").list();
  }
}
export default { fetch: () => new Response("fake email service") };
`;

export default defineWorkersTestConfig({
  workers: async () => ({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: {
      bindings: {
        TEST_MIGRATIONS: await readD1Migrations(migrationsDir),
        // Stage 6a: the fake OAuth provider and gatekeeper (fake transports only, no accounts).
        INTEGRATIONS_FAKE_PROVIDER: "true",
        APP_ORIGIN: "http://crm.test",
      },
      serviceBindings: {
        GATEKEEPER_WEBHOOK: { name: "crm-gatekeeper-webhook", entrypoint: "GatekeeperVendor" },
        GATEKEEPER_EMAIL_SEND: {
          name: "crm-gatekeeper-email-send",
          entrypoint: "GatekeeperVendor",
        },
        TEST_EMAIL_OUTBOX: { name: "fake-email-service", entrypoint: "Outbox" },
      },
      workers: [
        {
          name: "crm-gatekeeper-webhook",
          modules: true,
          scriptPath: await bundleGatekeeper("webhook"),
          compatibilityDate: "2026-09-04",
          compatibilityFlags: ["allow_irrevocable_stub_storage"],
          bindings: { BASE_URL: "http://crm.test/gatekeeper/webhook" },
          durableObjects: {
            WEBHOOK_ENDPOINT: { className: "WebhookEndpoint", useSQLite: true },
            // Facet classes must be declared to be instantiated (see the package's tests).
            WEBHOOK_ENDPOINT_GATEKEEPER: {
              className: "WebhookEndpointGatekeeper",
              useSQLite: true,
            },
          },
        },
        {
          name: "crm-gatekeeper-email-send",
          modules: true,
          scriptPath: await bundleGatekeeper("email-send"),
          compatibilityDate: "2026-09-04",
          compatibilityFlags: ["allow_irrevocable_stub_storage"],
          bindings: { ALLOWED_SENDER_DOMAINS: "example.com", INTERNAL_DOMAINS: "example.com" },
          serviceBindings: { EMAIL: { name: "fake-email-service", entrypoint: "FakeEmail" } },
          durableObjects: {
            EMAIL_SEND_GATEKEEPER: { className: "EmailSendGatekeeper", useSQLite: true },
          },
        },
        {
          name: "fake-email-service",
          modules: [{ type: "ESModule", path: "fake-email.mjs", contents: FAKE_EMAIL_SERVICE }],
          compatibilityDate: "2026-09-04",
          durableObjects: { SENT: { className: "Sent", useSQLite: true } },
        },
      ],
    },
  }),
  setupFiles: ["./test/apply-migrations.ts"],
});
