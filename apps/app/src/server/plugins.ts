// The plugin check (ADR 0347). Every 10 minutes it looks at copies waiting for something (a
// connection signed in, an extension approved) so their routines start by themselves. Once a day
// it also moves unchanged copies to new versions and makes copies for people who joined a role.
// It calls the operations as `automation`, which can only do what a person already agreed to:
// `plugin.update` leaves anything that asks for more access or has local edits for its owner.
import { createCrmDb } from "@relationship-os/db";
import {
  type ActingUser,
  type InvocationContext,
  invokeByName,
  marketplaceClientFor,
} from "@relationship-os/core";
import { assistantThreadsFor, type OperationsEnv } from "./operations.ts";

export async function runPluginCron(
  env: OperationsEnv,
  options: { updates: boolean },
): Promise<{ checked: number } | null> {
  try {
    const db = createCrmDb(env.DB);
    const installs = await db.query
      .selectFrom("core_plugin_install as i")
      .innerJoin("core_user as u", (join) =>
        join.on((eb) =>
          eb(
            "u.id",
            "=",
            eb.fn.coalesce("i.owner_user_id", "i.installed_by"),
          ),
        ),
      )
      .select([
        "i.id",
        "i.scope",
        "i.following",
        "i.parent_install_id",
        "u.id as user_id",
        "u.name",
        "u.email",
        "u.role",
      ])
      .execute();
    if (!installs.length) return { checked: 0 };
    const waiting = new Set(
      (
        await db.query
          .selectFrom("core_plugin_item")
          .select("install_id")
          .where("state", "=", "waiting")
          .execute()
      ).map((r) => r.install_id),
    );
    const marketplace = marketplaceClientFor(env);
    const assistantThreads = assistantThreadsFor(env);
    let checked = 0;
    for (const row of installs) {
      const context: InvocationContext = {
        actor: "automation",
        user: { id: row.user_id, name: row.name, email: row.email, role: row.role } as ActingUser,
        origin: { surface: "system" },
        db,
        ...(marketplace ? { marketplace } : {}),
        ...(assistantThreads ? { assistantThreads } : {}),
      };
      try {
        if (waiting.has(row.id)) {
          await invokeByName("plugin.checkNeeds", { id: row.id }, context);
          checked += 1;
        }
        if (!options.updates) continue;
        if (row.following) await invokeByName("plugin.update", { id: row.id }, context);
        if (row.scope === "role") {
          await invokeByName("plugin.syncMembers", { id: row.id }, context);
        }
        checked += 1;
      } catch (error) {
        // One copy that cannot be read does not stop the others.
        console.error(`plugin check: ${row.id} failed`, error);
      }
    }
    return { checked };
  } catch (error) {
    console.error("plugin check failed", error);
    return null;
  }
}
