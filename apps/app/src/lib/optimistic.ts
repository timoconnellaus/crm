// Optimistic cache updates for writes: show the change at once, roll back if the write fails.
//
//   const rollback = await patchRecord(client, ["task."], task.id, { status: "done" });
//   try { await callOp("task.complete", { id }) } catch { rollback() }
//
// A patch is applied to every cached operation result under the given prefixes, wherever a record
// with that id appears (a `get`, a list page, an infinite list's pages, grouped buckets). Only
// fields the cached object already has are changed, and only plain values (strings, numbers,
// booleans, null and arrays of them), so a write's input never puts a differently shaped value
// into a read's cache. The real result arrives with the invalidation after the write.
import type { QueryClient, QueryKey } from "@tanstack/react-query";

type Plain = string | number | boolean | null;
export type RecordPatch = Record<string, unknown>;

function isPlain(value: unknown): value is Plain | Plain[] {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  return Array.isArray(value) && value.every((v) => v === null || typeof v !== "object");
}

/** Only the plain-valued keys of a write's input, minus its id. */
export function plainPatch(input: RecordPatch): RecordPatch {
  return Object.fromEntries(
    Object.entries(input).filter(([key, value]) => key !== "id" && isPlain(value)),
  );
}

function patchDeep(value: unknown, id: string, patch: RecordPatch): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = patchDeep(item, id, patch);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (object.id === id) {
      let changed = false;
      const next = { ...object };
      for (const [key, after] of Object.entries(patch)) {
        if (key in object && object[key] !== after) {
          next[key] = after;
          changed = true;
        }
      }
      return changed ? next : object;
    }
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(object)) {
      const next = patchDeep(item, id, patch);
      if (next !== item) changed = true;
      out[key] = next;
    }
    return changed ? out : object;
  }
  return value;
}

const matches = (prefixes: readonly string[]) => (query: { queryKey: QueryKey }) =>
  query.queryKey[0] === "op" &&
  typeof query.queryKey[1] === "string" &&
  prefixes.some((prefix) => (query.queryKey[1] as string).startsWith(prefix));

/**
 * Patches record `id` in every cached read under `prefixes` and returns a rollback. In-flight
 * reads there are cancelled first, so a stale response cannot overwrite the patch.
 */
export async function patchRecord(
  client: QueryClient,
  prefixes: readonly string[],
  id: string,
  patch: RecordPatch,
): Promise<() => void> {
  const predicate = matches(prefixes);
  await client.cancelQueries({ predicate });
  return updateCached(client, prefixes, (data) => patchDeep(data, id, patch));
}

/** Applies `update` to every cached read under `prefixes`; returns a rollback. */
export function updateCached(
  client: QueryClient,
  prefixes: readonly string[],
  update: (data: unknown) => unknown,
): () => void {
  const snapshots: [QueryKey, unknown][] = [];
  for (const query of client.getQueryCache().findAll({ predicate: matches(prefixes) })) {
    const before = query.state.data;
    if (before === undefined) continue;
    const after = update(before);
    if (after === before) continue;
    snapshots.push([query.queryKey, before]);
    client.setQueryData(query.queryKey, after);
  }
  return () => {
    for (const [key, data] of snapshots) client.setQueryData(key, data);
  };
}
