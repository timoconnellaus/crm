// Where plugins come from (ADR 0347): first-party (shipped with releases), the workspace's private
// registry, and the hosted marketplace. Admins can turn the marketplace off or make members ask.
import {
  listingOf,
  type MarketplaceClient,
  type PluginListing,
  type PluginManifest,
  pluginManifestSchema,
} from "@relationship-os/agent-plugins";
import type { CoreDatabase } from "@relationship-os/db";
import type { Kysely } from "kysely";
import { z } from "zod";
import { compareVersions } from "@relationship-os/agent-plugins";
import { FIRST_PARTY_PLUGINS } from "./first-party.ts";

type Db = Kysely<CoreDatabase>;

export const PLUGIN_SOURCES = ["first_party", "workspace", "marketplace"] as const;
export type PluginSource = (typeof PLUGIN_SOURCES)[number];

/** core_settings: who may install from the marketplace. */
export const PLUGIN_MARKETPLACE_SETTING = "plugins.marketplace";
export const MARKETPLACE_MODES = ["anyone", "approval", "off"] as const;
export type MarketplaceMode = (typeof MARKETPLACE_MODES)[number];

export async function marketplaceMode(db: Db): Promise<MarketplaceMode> {
  const row = await db
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", PLUGIN_MARKETPLACE_SETTING)
    .executeTakeFirst();
  const parsed = z.enum(MARKETPLACE_MODES).safeParse(row ? JSON.parse(row.value) : "anyone");
  // A value that cannot be read is treated as the stricter choice.
  return parsed.success ? parsed.data : "approval";
}

export interface Located {
  manifest: PluginManifest;
  source: PluginSource;
}

const parse = (text: string) => pluginManifestSchema.parse(JSON.parse(text));

/** The newest published version in the registry, or an exact one, proposals included when asked. */
async function fromRegistry(
  db: Db,
  id: string,
  version?: string,
  proposals = false,
): Promise<PluginManifest | null> {
  let query = db.selectFrom("core_plugin_registry").select(["version", "manifest", "status"]);
  query = query.where("plugin_id", "=", id);
  if (version) query = query.where("version", "=", version);
  if (!proposals) query = query.where("status", "=", "published");
  const rows = await query.execute();
  const newest = rows.sort((a, b) => compareVersions(b.version, a.version))[0];
  return newest ? parse(newest.manifest) : null;
}

/** One plugin from one source, or the first that has it. */
export async function locate(
  ctx: { db: Db; marketplace?: MarketplaceClient | undefined },
  input: { id: string; version?: string | undefined; source?: PluginSource | undefined },
): Promise<Located | null> {
  const { id, version, source } = input;
  if (!source || source === "first_party") {
    const manifest = FIRST_PARTY_PLUGINS.find(
      (p) => p.id === id && (!version || p.version === version),
    );
    if (manifest) return { manifest, source: "first_party" };
  }
  if (!source || source === "workspace") {
    const manifest = await fromRegistry(ctx.db, id, version, Boolean(version));
    if (manifest) return { manifest, source: "workspace" };
  }
  if ((!source || source === "marketplace") && ctx.marketplace) {
    if ((await marketplaceMode(ctx.db)) === "off") return null;
    const found = await ctx.marketplace.get(id);
    if (found && (!version || found.manifest.version === version)) {
      return { manifest: found.manifest, source: "marketplace" };
    }
  }
  return null;
}

export interface SourcedListing extends PluginListing {
  source: PluginSource;
  /** In the workspace registry, where it stands. */
  status?: "proposed" | "published" | undefined;
  marketplaceStatus?: "in_review" | "approved" | "rejected" | null | undefined;
}

const matches = (listing: PluginListing, query: string | undefined) => {
  const q = query?.trim().toLowerCase();
  if (!q) return true;
  return [listing.name, listing.description, listing.publisher].some((text) =>
    text.toLowerCase().includes(q),
  );
};

/** First-party and workspace listings. Reads no network. */
export async function localListings(db: Db, query?: string): Promise<SourcedListing[]> {
  const rows = await db
    .selectFrom("core_plugin_registry")
    .select(["plugin_id", "version", "manifest", "status", "marketplace_status", "updated_at"])
    .where("status", "=", "published")
    .execute();
  const newest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const held = newest.get(row.plugin_id);
    if (!held || compareVersions(row.version, held.version) > 0) newest.set(row.plugin_id, row);
  }
  return [
    ...FIRST_PARTY_PLUGINS.map((m) => ({ ...listingOf(m), source: "first_party" as const })),
    ...[...newest.values()].map((row) => ({
      ...listingOf(parse(row.manifest), { updatedAt: row.updated_at }),
      source: "workspace" as const,
      status: row.status,
      marketplaceStatus: row.marketplace_status,
    })),
  ].filter((listing) => matches(listing, query));
}
