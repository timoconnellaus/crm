import type { Migration } from "@relationship-os/db";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: Migration[];
    }
  }
}
