import type { Migration } from "@crm/db";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: Migration[];
    }
  }
}
