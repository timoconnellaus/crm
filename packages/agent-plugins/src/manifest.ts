// `plugin.json` (ADR 0347): what a plugin is, in a shape any host can read. A plugin is a list of
// items. This package knows every item's envelope (kind, key, label, body) and treats the body as
// data; a host says which kinds it accepts and what their bodies look like with a kind registry
// (kinds.ts), so a new kind (email templates, reports) needs no change here.
import { z } from "zod";

export const PLUGIN_SCHEMA_VERSION = 1;

/** `renewals-desk`, or `inboxwise.follow-up-nudges` for a publisher's plugin. */
export const pluginIdSchema = z
  .string()
  .max(100)
  .regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)?$/, "a plugin id such as renewals-desk");

export const pluginVersionSchema = z
  .string()
  .max(40)
  .regex(/^\d+\.\d+\.\d+$/, "a version such as 1.4.0");

/** Unique within a plugin, and stable across its versions: how an update finds your copy. */
export const itemKeySchema = z
  .string()
  .max(80)
  .regex(/^[a-z][a-zA-Z0-9_.-]*$/, "an item key such as renewal-brief");

export const pluginItemSchema = z.object({
  kind: z.string().min(1).max(40),
  key: itemKeySchema,
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().max(400).optional(),
  body: z.record(z.string(), z.unknown()),
});
export type PluginItem = z.infer<typeof pluginItemSchema>;

/**
 * What a plugin says it needs. A host adds what it can see for itself (`accessOf` in kinds.ts), so
 * leaving something out of a manifest does not hide it.
 */
export const pluginAccessSchema = z.object({
  /** Operations its items call. */
  operations: z.array(z.string().min(1).max(120)).max(200).default([]),
  /** Connections it uses, by service. */
  connections: z.array(z.string().min(1).max(80)).max(50).default([]),
  /** Objects and fields it adds to the workspace. */
  schema: z.array(z.string().min(1).max(160)).max(100).default([]),
  /** The same in plain words, for the plugin page. */
  words: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
});
export type PluginAccess = z.infer<typeof pluginAccessSchema>;

export const pluginManifestSchema = z
  .object({
    schema: z.literal(PLUGIN_SCHEMA_VERSION).default(PLUGIN_SCHEMA_VERSION),
    id: pluginIdSchema,
    name: z.string().trim().min(1).max(120),
    version: pluginVersionSchema,
    publisher: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(1_000),
    /** One line per change in this version, for "What's new". */
    whatsNew: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
    /** The card catalogue its saved producers write for. */
    catalogue: z.number().int().min(1).optional(),
    access: pluginAccessSchema.default({ operations: [], connections: [], schema: [], words: [] }),
    items: z.array(pluginItemSchema).min(1).max(100),
  })
  .superRefine((manifest, ctx) => {
    const seen = new Set<string>();
    manifest.items.forEach((item, i) => {
      if (seen.has(item.key)) {
        ctx.addIssue({
          code: "custom",
          path: ["items", i, "key"],
          message: `Two items use the key "${item.key}"`,
        });
      }
      seen.add(item.key);
    });
  });
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export type PluginManifestInput = z.input<typeof pluginManifestSchema>;

/** `1.4.0` against `1.10.0`: negative, zero or positive, as a comparator. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(".").map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** What a listing says about a plugin: everything a page shows before it is installed. */
export const pluginListingSchema = z.object({
  id: pluginIdSchema,
  name: z.string(),
  version: pluginVersionSchema,
  publisher: z.string(),
  description: z.string(),
  /** How many items of each kind. */
  adds: z.array(z.object({ kind: z.string(), count: z.number().int().min(0) })),
  connections: z.array(z.string()),
  /** Omitted where the source does not count them. */
  installs: z.number().int().min(0).optional(),
  updatedAt: z.string().optional(),
});
export type PluginListing = z.infer<typeof pluginListingSchema>;

export function listingOf(
  manifest: PluginManifest,
  extra: { installs?: number; updatedAt?: string } = {},
): PluginListing {
  const counts = new Map<string, number>();
  for (const item of manifest.items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    publisher: manifest.publisher,
    description: manifest.description,
    adds: [...counts].map(([kind, count]) => ({ kind, count })),
    connections: manifest.access.connections,
    ...extra,
  };
}
