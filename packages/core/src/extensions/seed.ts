// Seed records (ADR 0100): records an extension declares on an object (`seed`), inserted once in
// the install batch that creates the object, e.g. Deals' default pipelines and stages.
//
// Seed records get deterministic ids, `rec_` + a ULID-shaped hash of extension, object and key, so
// a seed can point at another (`{ seed: "newBusiness" }`) and demo data (`pnpm db:seed`) can refer
// to them without reading the database. packages/db/src/seed.ts carries a copy of `seedRecordId`
// (it cannot import core); a test keeps the two equal.
import type { ExtensionManifest, FieldManifest } from "@relationship-os/sdk";
import { CompiledQuery } from "kysely";
import { FIELD_TYPE_REGISTRY } from "../fields/field-types.ts";
import { columnName, objectTable } from "./naming.ts";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 32-bit FNV-1a of `text`, starting from `seed`. */
function fnv(text: string, seed: number): number {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** The id of seed record `key` of `<extension>.<object>`: `rec_0000000000` + 16 hash characters. */
export function seedRecordId(extension: string, object: string, key: string): string {
  const text = `${extension}.${object}.${key}`;
  let out = "";
  for (const seed of [1, 2, 3, 4]) {
    let hash = fnv(text, seed);
    for (let i = 0; i < 4; i++) {
      out += ALPHABET[hash % 32];
      hash = Math.floor(hash / 32);
    }
  }
  return `rec_0000000000${out}`;
}

export interface SeedIssue {
  path: string;
  message: string;
}

/**
 * The statements that insert `<ext>.<local>`'s seed records (and their search entries), or the
 * problems with them. Values are validated with the field-type registry.
 */
export function seedStatements(
  manifest: ExtensionManifest,
  local: string,
  now: string,
): { statements: CompiledQuery[]; issues: SeedIssue[] } {
  const object = manifest.objects[local];
  const statements: CompiledQuery[] = [];
  const issues: SeedIssue[] = [];
  if (!object?.seed) return { statements, issues };
  const table = objectTable(manifest.id, local);
  const principal = `extension:${manifest.id}`;
  for (const [key, values] of Object.entries(object.seed)) {
    const path = `objects.${local}.seed.${key}`;
    const id = seedRecordId(manifest.id, local, key);
    const columns: string[] = [];
    const params: (string | number | null)[] = [];
    for (const [name, raw] of Object.entries(values)) {
      const field: FieldManifest | undefined = object.fields[name];
      if (!field || field.type === "formula") continue;
      let value = raw;
      if (field.type === "relation" && raw && typeof raw === "object" && !Array.isArray(raw)) {
        const target = field.to?.split(".")[1] ?? "";
        value = seedRecordId(manifest.id, target, String((raw as { seed: unknown }).seed));
      }
      const spec = FIELD_TYPE_REGISTRY[field.type];
      const parsed = spec.schema(field).safeParse(value);
      if (!parsed.success) {
        issues.push({
          path: `${path}.${name}`,
          message: `Invalid seed value for ${name}: ${parsed.error.issues[0]?.message ?? "invalid"}`,
        });
        continue;
      }
      columns.push(columnName(name));
      params.push(spec.toStorage(parsed.data));
    }
    const all = ["id", "created_at", "updated_at", "created_by", ...columns];
    statements.push(
      CompiledQuery.raw(
        `INSERT OR IGNORE INTO ${table} (${all.join(", ")}) VALUES (${all.map(() => "?").join(", ")})`,
        [id, now, now, principal, ...params],
      ),
    );
    const title = values[object.titleField];
    statements.push(
      CompiledQuery.raw(
        "INSERT OR IGNORE INTO core_search_docs (object_type, record_id, title, body) VALUES (?, ?, ?, '')",
        [`${manifest.id}.${local}`, id, typeof title === "string" ? title : ""],
      ),
    );
  }
  return { statements, issues };
}
