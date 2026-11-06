// Item kinds (ADR 0347): a host declares each kind it accepts, what its body must look like, where
// it may be installed and what access it implies. Unknown kinds are refused at install, so a plugin
// written for a newer host says so instead of half-installing. What a kind implies is read from
// the body, not taken from the manifest's own `access`, so a plugin cannot widen by not saying so.
import type { z } from "zod";
import type { PluginAccess, PluginItem, PluginManifest } from "./manifest.ts";
import type { PluginScopeKind } from "./scope.ts";

export interface PluginItemKind {
  kind: string;
  /** For pages: "Skill", "Routine". */
  label: string;
  /** Where it may be installed. */
  scopes: readonly PluginScopeKind[];
  body: z.ZodType<Record<string, unknown>>;
  /** Access its body implies. */
  access?: (body: Record<string, unknown>) => Partial<Omit<PluginAccess, "words">>;
}

export interface PluginKindIssue {
  key: string;
  message: string;
}

export interface PluginKindRegistry {
  get(kind: string): PluginItemKind | undefined;
  list(): PluginItemKind[];
  /** Everything wrong with a manifest's items. Empty: this host can install it. */
  check(manifest: Pick<PluginManifest, "items">): PluginKindIssue[];
  /** Replaces each body with its parsed value, so defaults apply and a copy is normalised. */
  normalise(item: PluginItem): PluginItem;
  /** The kinds a scope cannot hold. */
  outOfScope(manifest: Pick<PluginManifest, "items">, scope: PluginScopeKind): PluginItem[];
  /** What a manifest declares plus what its items imply. */
  accessOf(manifest: Pick<PluginManifest, "items" | "access">): PluginAccess;
}

const unique = (values: readonly string[]) => [...new Set(values)].sort();

export function createKindRegistry(kinds: readonly PluginItemKind[]): PluginKindRegistry {
  const byKind = new Map(kinds.map((k) => [k.kind, k]));
  const registry: PluginKindRegistry = {
    get: (kind) => byKind.get(kind),
    list: () => [...byKind.values()],
    check(manifest) {
      const issues: PluginKindIssue[] = [];
      for (const item of manifest.items) {
        const kind = byKind.get(item.kind);
        if (!kind) {
          issues.push({ key: item.key, message: `This app has no item kind "${item.kind}"` });
          continue;
        }
        const parsed = kind.body.safeParse(item.body);
        if (!parsed.success) {
          const first = parsed.error.issues[0];
          issues.push({
            key: item.key,
            message: `${item.label}: ${first?.path.join(".") || "body"}: ${first?.message ?? "not valid"}`,
          });
        }
      }
      return issues;
    },
    normalise(item) {
      const kind = byKind.get(item.kind);
      return kind ? { ...item, body: kind.body.parse(item.body) } : item;
    },
    outOfScope(manifest, scope) {
      return manifest.items.filter((item) => !byKind.get(item.kind)?.scopes.includes(scope));
    },
    accessOf(manifest) {
      const implied = manifest.items.map((item) => {
        const kind = byKind.get(item.kind);
        if (!kind?.access) return {};
        const parsed = kind.body.safeParse(item.body);
        return parsed.success ? kind.access(parsed.data) : {};
      });
      return {
        operations: unique([
          ...manifest.access.operations,
          ...implied.flatMap((a) => a.operations ?? []),
        ]),
        connections: unique([
          ...manifest.access.connections,
          ...implied.flatMap((a) => a.connections ?? []),
        ]),
        schema: unique([...manifest.access.schema, ...implied.flatMap((a) => a.schema ?? [])]),
        words: manifest.access.words,
      };
    },
  };
  return registry;
}
