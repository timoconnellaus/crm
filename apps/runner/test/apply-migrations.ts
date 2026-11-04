import { env } from "cloudflare:workers";
import { applyMigrations } from "@crm/db";

await applyMigrations(env.DB, env.TEST_MIGRATIONS);
