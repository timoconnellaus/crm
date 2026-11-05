import type { Migration } from "@relationship-os/db";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TEST_MIGRATIONS: Migration[];
    }
  }
}
