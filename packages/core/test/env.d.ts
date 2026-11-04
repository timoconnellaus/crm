import type { Migration } from "@crm/db";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TEST_MIGRATIONS: Migration[];
    }
  }
}
