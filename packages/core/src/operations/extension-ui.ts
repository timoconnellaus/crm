// What extensions declare for the host's UI to render (ADR 0058): record tabs and panels on any
// object's record page (`view.recordViews`), and typed settings (`extensionSettings.*`).
// Extensions ship no UI; these read active extensions' manifests and return plain view specs.
import type { RecordViewManifest, SettingManifest } from "@relationship-os/sdk";
import { z } from "zod";
import { ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import type { Filter } from "../filter.ts";
import { defineOperation } from "../operation.ts";
import { objectViewSpecSchema, validateViewSpec, viewObjectName } from "../views/spec.ts";

interface ActiveManifest {
  id: string;
  label: string;
  manifest: {
    label?: string;
    recordTabs?: Record<string, RecordViewManifest>;
    recordPanels?: Record<string, RecordViewManifest>;
    settings?: Record<string, SettingManifest>;
  };
}

async function activeManifests(ctx: {
  db: import("kysely").Kysely<import("@relationship-os/db").CoreDatabase>;
}): Promise<ActiveManifest[]> {
  const rows = await ctx.db
    .selectFrom("core_extensions")
    .select(["id", "manifest"])
    .where("status", "=", "active")
    .orderBy("id")
    .execute();
  return rows.map((row) => {
    const manifest = JSON.parse(row.manifest) as ActiveManifest["manifest"];
    return { id: row.id, label: manifest.label ?? row.id, manifest };
  });
}

const recordViewSchema = z.object({
  id: z.string().describe("<extension>.<name>, unique on the page"),
  extension: z.string(),
  kind: z.enum(["tab", "panel"]),
  label: z.string(),
  order: z.number(),
  /** The field of spec.object that must equal the current record's id. */
  relation: z.string(),
  spec: objectViewSpecSchema.nullable(),
  /** Why the declaration could not be turned into a view (it is then not rendered). */
  error: z.string().nullable(),
});
export type RecordView = z.infer<typeof recordViewSchema>;

/** A record tab or panel declaration → a validated object view spec (without the record filter). */
function toRecordView(
  extension: string,
  name: string,
  kind: "tab" | "panel",
  entry: RecordViewManifest,
): RecordView {
  const base = {
    id: `${extension}.${name}`,
    extension,
    kind,
    label: entry.label,
    order: entry.order ?? 100,
    relation: entry.view.relation,
  };
  try {
    const object = getObject(entry.view.object);
    if (!object) throw new ValidationError(`Unknown object ${entry.view.object}`);
    if (!object.fields.some((f) => f.name === entry.view.relation && f.filterable)) {
      throw new ValidationError(
        `${entry.view.object} has no filterable field ${entry.view.relation}`,
      );
    }
    const titleField =
      object.titleField ?? object.fields.find((f) => f.name !== "id")?.name ?? "id";
    const system = new Set(["id", "createdAt", "updatedAt", "createdBy", entry.view.relation]);
    const shown = object.fields
      .filter((f) => !system.has(f.name) && f.column && (!object.extension || f.extension))
      .map((f) => f.name);
    const columns =
      entry.view.columns ?? [titleField, ...shown.filter((n) => n !== titleField)].slice(0, 5);
    const spec = validateViewSpec(
      objectViewSpecSchema.parse({
        ...entry.view,
        filter: (entry.view.filter as Filter | undefined) ?? null,
        columns,
        cardFields: entry.view.cardFields ?? [],
      }),
    );
    return { ...base, spec, error: null };
  } catch (error) {
    return { ...base, spec: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export const viewRecordViews = defineOperation({
  name: "view.recordViews",
  description:
    "List the tabs and side panels extensions add to an object's record page: each is a view " +
    "spec (table, board, calendar or gallery) of another object, to be filtered to records " +
    "whose `relation` field equals the record's id. Read-only.",
  input: z.object({ object: viewObjectName }),
  output: z.object({ tabs: z.array(recordViewSchema), panels: z.array(recordViewSchema) }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const tabs: RecordView[] = [];
    const panels: RecordView[] = [];
    for (const { id, manifest } of await activeManifests(ctx)) {
      for (const [name, entry] of Object.entries(manifest.recordTabs ?? {})) {
        if (entry.on === input.object) tabs.push(toRecordView(id, name, "tab", entry));
      }
      for (const [name, entry] of Object.entries(manifest.recordPanels ?? {})) {
        if (entry.on === input.object) panels.push(toRecordView(id, name, "panel", entry));
      }
    }
    const byOrder = (a: RecordView, b: RecordView) => a.order - b.order || a.id.localeCompare(b.id);
    return { tabs: tabs.sort(byOrder), panels: panels.sort(byOrder) };
  },
});

/** The filter a record view lists with: its own filter AND relation = the record's id. */
export function recordViewFilter(
  view: Pick<RecordView, "relation" | "spec">,
  recordId: string,
): Filter {
  const own = view.spec?.filter;
  const match: Filter = { field: view.relation, op: "eq", value: recordId };
  return own ? { and: [match, own] } : match;
}

// --- Settings ------------------------------------------------------------------------------------

const settingValue = z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]);

const extensionSettingsSchema = z.object({
  extension: z.string(),
  label: z.string(),
  settings: z.record(
    z.string(),
    z.object({
      type: z.enum(["text", "number", "boolean", "select"]),
      label: z.string(),
      description: z.string().nullable(),
      required: z.boolean(),
      default: settingValue,
      min: z.number().nullable(),
      max: z.number().nullable(),
      options: z.array(z.object({ value: z.string(), label: z.string() })).nullable(),
    }),
  ),
  values: z.record(z.string(), settingValue),
  updatedAt: z.string().nullable(),
});
export type ExtensionSettings = z.infer<typeof extensionSettingsSchema>;

async function storedSettings(
  ctx: { db: import("kysely").Kysely<import("@relationship-os/db").CoreDatabase> },
  ids: string[],
) {
  if (!ids.length) return new Map<string, { value: Record<string, unknown>; updatedAt: string }>();
  const rows = await ctx.db
    .selectFrom("core_extension_settings")
    .selectAll()
    .where("extension_id", "in", ids)
    .execute();
  return new Map(
    rows.map((r) => [
      r.extension_id,
      { value: JSON.parse(r.value) as Record<string, unknown>, updatedAt: r.updated_at },
    ]),
  );
}

function describeSettings(
  ext: ActiveManifest,
  stored: { value: Record<string, unknown>; updatedAt: string } | undefined,
): ExtensionSettings {
  const settings: ExtensionSettings["settings"] = {};
  const values: ExtensionSettings["values"] = {};
  for (const [name, s] of Object.entries(ext.manifest.settings ?? {})) {
    settings[name] = {
      type: s.type,
      label: s.label,
      description: s.description ?? null,
      required: Boolean(s.required),
      default: s.default ?? null,
      min: s.min ?? null,
      max: s.max ?? null,
      options: s.options ? s.options.map((o) => ({ value: o.value, label: o.label })) : null,
    };
    const value = stored?.value[name];
    values[name] =
      value === undefined ? (s.default ?? null) : (value as string | number | boolean | null);
  }
  return {
    extension: ext.id,
    label: ext.label,
    settings,
    values,
    updatedAt: stored?.updatedAt ?? null,
  };
}

export const extensionSettingsList = defineOperation({
  name: "extensionSettings.list",
  description:
    "List the typed settings every active extension declares, with their current values " +
    "(defaults where unset). Read-only.",
  input: z.object({ extension: z.string().max(40).optional() }),
  output: z.object({ items: z.array(extensionSettingsSchema) }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const exts = (await activeManifests(ctx)).filter(
      (e) =>
        Object.keys(e.manifest.settings ?? {}).length > 0 &&
        (!input.extension || e.id === input.extension),
    );
    const stored = await storedSettings(
      ctx,
      exts.map((e) => e.id),
    );
    return { items: exts.map((e) => describeSettings(e, stored.get(e.id))) };
  },
});

export const extensionSettingsUpdate = defineOperation({
  name: "extensionSettings.update",
  description:
    "Change an extension's settings (admins). Values are checked against the types the " +
    "extension declares; null resets one to its default. Returns the settings.",
  input: z.object({
    extension: z.string().min(1).max(40),
    values: z.record(z.string().max(40), settingValue),
  }),
  output: extensionSettingsSchema,
  permission: "extensions:manage",
  risk: "write",
  async handler(input, ctx) {
    const ext = (await activeManifests(ctx)).find((e) => e.id === input.extension);
    if (!ext)
      throw new ValidationError(`No active extension ${input.extension}`, { field: "extension" });
    const declared = ext.manifest.settings ?? {};
    const stored = (await storedSettings(ctx, [ext.id])).get(ext.id);
    const next: Record<string, unknown> = { ...(stored?.value ?? {}) };
    for (const [name, value] of Object.entries(input.values)) {
      const setting = declared[name];
      if (!setting) {
        throw new ValidationError(`${ext.id} has no setting ${name}`, {
          field: name,
          allowed: Object.keys(declared),
        });
      }
      if (value === null) {
        if (setting.required && setting.default === undefined) {
          throw new ValidationError(`${setting.label} is required`, { field: name });
        }
        delete next[name];
        continue;
      }
      const ok =
        (setting.type === "text" && typeof value === "string") ||
        (setting.type === "boolean" && typeof value === "boolean") ||
        (setting.type === "number" &&
          typeof value === "number" &&
          Number.isFinite(value) &&
          (setting.min === undefined || value >= setting.min) &&
          (setting.max === undefined || value <= setting.max)) ||
        (setting.type === "select" &&
          typeof value === "string" &&
          (setting.options ?? []).some((o) => o.value === value));
      if (!ok) {
        throw new ValidationError(`Invalid value for ${setting.label}`, { field: name });
      }
      next[name] = value;
    }
    ctx.write(
      ctx.db
        .insertInto("core_extension_settings")
        .values({
          extension_id: ext.id,
          value: JSON.stringify(next),
          updated_at: ctx.now,
          updated_by: ctx.user.id,
        })
        .onConflict((oc) =>
          oc.column("extension_id").doUpdateSet({
            value: JSON.stringify(next),
            updated_at: ctx.now,
            updated_by: ctx.user.id,
          }),
        ),
    );
    ctx.recordChange({
      object: "extension",
      id: ext.id,
      action: "update",
      before: { settings: stored?.value ?? {} },
      after: { settings: next },
    });
    return describeSettings(ext, { value: next, updatedAt: ctx.now });
  },
});

export const extensionUiOperations = [
  viewRecordViews,
  extensionSettingsList,
  extensionSettingsUpdate,
] as const;
