import { env } from "cloudflare:workers";
import { applyMigrations } from "@relationship-os/db";

await applyMigrations(env.DB, env.TEST_MIGRATIONS);
