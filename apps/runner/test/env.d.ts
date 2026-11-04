import type { Migration } from "@crm/db";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: Migration[];
      /** The fake Email Service behind the email-send gatekeeper (vitest.config.ts). */
      TEST_EMAIL_OUTBOX: Fetcher & {
        list(): Promise<{ from: string; to: string[]; subject: string; text?: string }[]>;
      };
    }
  }
}
