// Fingerprints (ADR 0347): a copy is stamped with the fingerprint of what it was copied from, so an
// untouched copy can be told from an edited one. Canonical JSON means key order and an undefined
// never change a fingerprint: only content does.
import type { PluginItem, PluginManifest } from "./manifest.ts";

/** JSON with sorted keys and no undefined values. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** `sha256:<hex>` of a value's canonical JSON. */
export async function fingerprintOf(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${[...hash].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** An item's content. Its description is display text from the plugin, and not editable. */
export function itemFingerprint(item: Pick<PluginItem, "kind" | "key" | "label" | "body">) {
  return fingerprintOf({ kind: item.kind, key: item.key, label: item.label, body: item.body });
}

/** A version's content: its items, whatever order they are listed in. */
export async function manifestFingerprint(manifest: Pick<PluginManifest, "id" | "items">) {
  const items = await Promise.all(manifest.items.map(itemFingerprint));
  return fingerprintOf({ id: manifest.id, items: items.sort() });
}
