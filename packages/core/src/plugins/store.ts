// Reading what is installed (ADR 0347): the install rows, each person's effective copies, and the
// items they contribute. A plugin's skills, saved cards and profiles are looked up here at the point
// of use, from D1, because ros-app, ros-runner and every isolate of them must agree, and because
// what one person installed is theirs alone: an in-memory registry could promise neither.
import {
  effectiveInstalls,
  type PluginItem,
  type PluginManifest,
  type PluginViewer,
  pluginManifestSchema,
  type ScopedInstall,
} from "@relationship-os/agent-plugins";
import type { CoreDatabase, CorePluginInstallTable } from "@relationship-os/db";
import type { Kysely, Selectable } from "kysely";
import { jsonList } from "../records/common.ts";

export type InstallRow = Selectable<CorePluginInstallTable>;

export interface Adaptation {
  from: string;
  to: string;
}

export interface Install extends ScopedInstall {
  row: InstallRow;
  manifest: PluginManifest;
  adaptations: Adaptation[];
}

function toInstall(row: InstallRow, members: readonly string[]): Install {
  return {
    id: row.id,
    pluginId: row.plugin_id,
    scope: row.scope,
    ownerUserId: row.owner_user_id,
    role: row.role,
    members,
    locked: row.locked === 1,
    row,
    manifest: pluginManifestSchema.parse(JSON.parse(row.manifest)),
    adaptations: JSON.parse(row.adaptations) as Adaptation[],
  };
}

async function hydrate(db: Kysely<CoreDatabase>, rows: readonly InstallRow[]): Promise<Install[]> {
  if (!rows.length) return [];
  const teams = rows.filter((r) => r.scope === "team").map((r) => r.id);
  const members = teams.length
    ? await db
        .selectFrom("core_plugin_member")
        .selectAll()
        .where("install_id", "in", jsonList(teams))
        .execute()
    : [];
  return rows.map((row) =>
    toInstall(
      row,
      members.filter((m) => m.install_id === row.id).map((m) => m.user_id),
    ),
  );
}

export async function loadInstall(
  db: Kysely<CoreDatabase>,
  id: string,
): Promise<Install | undefined> {
  const row = await db
    .selectFrom("core_plugin_install")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  return row ? (await hydrate(db, [row]))[0] : undefined;
}

/** Every install that could apply to this person. */
export async function installsFor(
  db: Kysely<CoreDatabase>,
  viewer: PluginViewer,
): Promise<Install[]> {
  const rows = await db
    .selectFrom("core_plugin_install")
    .selectAll()
    .where((eb) =>
      eb.or([eb("owner_user_id", "=", viewer.userId), eb("scope", "<>", "personal")]),
    )
    .orderBy("created_at")
    .execute();
  return hydrate(db, rows);
}

/** What the person actually gets: the nearest copy of each plugin. */
export async function effectiveFor(
  db: Kysely<CoreDatabase>,
  viewer: PluginViewer,
): Promise<Install[]> {
  return effectiveInstalls(await installsFor(db, viewer), viewer);
}

export async function allInstalls(db: Kysely<CoreDatabase>): Promise<Install[]> {
  return hydrate(db, await db.selectFrom("core_plugin_install").selectAll().execute());
}

export interface StoredItem extends PluginItem {
  installId: string;
  name: string | null;
  state: "active" | "waiting" | "offered";
  stateReason: string | null;
}

export async function itemsOf(
  db: Kysely<CoreDatabase>,
  installIds: readonly string[],
): Promise<StoredItem[]> {
  if (!installIds.length) return [];
  const rows = await db
    .selectFrom("core_plugin_item")
    .selectAll()
    .where("install_id", "in", jsonList(installIds))
    .execute();
  return rows.map((r) => ({
    installId: r.install_id,
    key: r.key,
    kind: r.kind,
    name: r.name,
    label: r.label,
    ...(r.description ? { description: r.description } : {}),
    body: JSON.parse(r.body) as Record<string, unknown>,
    state: r.state,
    stateReason: r.state_reason,
  }));
}

export type Viewable = { id: string; role: string };

export const viewerOf = (user: Viewable): PluginViewer => ({
  userId: user.id,
  role: user.role,
  isAdmin: user.role === "admin",
});

/** Active items of these kinds from the person's effective copies. */
export async function itemsForViewer(
  db: Kysely<CoreDatabase>,
  user: Viewable,
  kinds: readonly string[],
): Promise<StoredItem[]> {
  const installs = await effectiveFor(db, viewerOf(user));
  const items = await itemsOf(
    db,
    installs.map((i) => i.id),
  );
  return items.filter((i) => kinds.includes(i.kind) && i.state === "active");
}

/** One named item for this person, read straight from its index. */
export async function namedItem(
  db: Kysely<CoreDatabase>,
  user: Viewable,
  kinds: readonly string[],
  name: string,
): Promise<StoredItem | undefined> {
  const hits = await db
    .selectFrom("core_plugin_item")
    .select("install_id")
    .where("kind", "in", jsonList(kinds))
    .where("name", "=", name)
    .where("state", "=", "active")
    .execute();
  if (!hits.length) return undefined;
  const rows = await db
    .selectFrom("core_plugin_install")
    .selectAll()
    .where(
      "id",
      "in",
      jsonList(hits.map((h) => h.install_id)),
    )
    .execute();
  const installs = effectiveInstalls(await hydrate(db, rows), viewerOf(user));
  const items = await itemsOf(
    db,
    installs.map((i) => i.id),
  );
  return items.find((i) => i.name === name && kinds.includes(i.kind));
}

/** The plugin a target came from, when a member cannot change it. */
export async function lockedPluginOf(
  db: Kysely<CoreDatabase>,
  targetKind: string,
  targetId: string,
): Promise<string | null> {
  const row = await db
    .selectFrom("core_plugin_target as t")
    .innerJoin("core_plugin_install as i", "i.id", "t.install_id")
    .select("i.name")
    .where("t.target_kind", "=", targetKind)
    .where("t.target_id", "=", targetId)
    .where("i.locked", "=", 1)
    .executeTakeFirst();
  return row?.name ?? null;
}
