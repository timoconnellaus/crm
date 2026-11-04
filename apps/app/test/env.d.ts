import type { Migration } from "@crm/db";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: Migration[];
      UPDATER_FAKE_D1: D1Database;
    }
  }
}
