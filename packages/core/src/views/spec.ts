// View specs (ADR 0027, ADR 0056): the JSON a saved view, a record tab or a dashboard is made of.
// A discriminated union on `type`:
//
//   table     { object, filter, sort, columns }                    (stage 1, unchanged)
//   board     { object, filter, sort, groupBy, columnOrder?, sumField?, cardFields }
//   calendar  { object, filter, dateField, mode, cardFields }
//   gallery   { object, filter, sort, imageField?, cardFields }
//   dashboard { title?, filters, widgets }                         (see dashboards/spec.ts)
//
// Object specs are checked against the field registry by `validateViewSpec`. Specs stored before
// stage 4 are `type: "table"` and stay valid; a stored spec without a `type` (never written by
// this codebase, but cheap to accept) reads as a table (`parseStoredViewSpec`).
// Browser-safe: no database imports.
import { z } from "zod";
import { dashboardSpecSchema } from "../dashboards/spec.ts";
import { ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import type { FieldDefinition, ObjectDefinition } from "../fields/types.ts";
import { compileFilter, filterSchema } from "../filter.ts";
import { resolveSort, sortSchema } from "../list.ts";

export const VIEW_TYPES = ["table", "board", "calendar", "gallery", "dashboard"] as const;
export type ViewType = (typeof VIEW_TYPES)[number];
/** View types that list one object's records (everything but dashboards). */
export const OBJECT_VIEW_TYPES = ["table", "board", "calendar", "gallery"] as const;
export type ObjectViewType = (typeof OBJECT_VIEW_TYPES)[number];

export const viewObjectName = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)?$/)
  .describe("The object listed: person, organisation, activity, task or an extension object");

const fieldName = z.string().min(1).max(80);
const cardFields = z
  .array(fieldName)
  .max(8)
  .default([])
  .describe("Fields shown on each card, in order (the title field is always shown)");

const base = {
  object: viewObjectName,
  filter: filterSchema.nullish().describe("Structured filter JSON, as list operations take"),
};

export const tableViewSpecSchema = z.object({
  type: z.literal("table"),
  ...base,
  sort: sortSchema.nullish(),
  columns: z
    .array(z.string().min(1).max(64))
    .min(1)
    .max(100)
    .describe("Field names shown, in order"),
});

export const boardViewSpecSchema = z.object({
  type: z.literal("board"),
  ...base,
  sort: sortSchema.nullish().describe("Card order within a column"),
  groupBy: fieldName.describe("A single-select field: one column per choice"),
  columnOrder: z
    .array(z.string().max(100))
    .max(200)
    .nullish()
    .describe("Column order by choice value; choices not listed follow in their own order"),
  hiddenColumns: z.array(z.string().max(100)).max(200).nullish(),
  sumField: fieldName.nullish().describe("A number or currency field summed per column"),
  cardFields,
});

export const CALENDAR_MODES = ["month", "week", "agenda"] as const;
export const calendarViewSpecSchema = z.object({
  type: z.literal("calendar"),
  ...base,
  dateField: fieldName.describe("A date or datetime field that places each record on a day"),
  mode: z.enum(CALENDAR_MODES).default("month"),
  cardFields,
});

export const galleryViewSpecSchema = z.object({
  type: z.literal("gallery"),
  ...base,
  sort: sortSchema.nullish(),
  imageField: fieldName
    .nullish()
    .describe("A URL field holding an image; cards without one show initials"),
  cardFields,
});

export const dashboardViewSpecSchema = dashboardSpecSchema.extend({
  type: z.literal("dashboard"),
  title: z.string().max(200).nullish(),
});

/** Object view specs: what a saved view stores. */
export const objectViewSpecSchema = z.discriminatedUnion("type", [
  tableViewSpecSchema,
  boardViewSpecSchema,
  calendarViewSpecSchema,
  galleryViewSpecSchema,
]);
export type ObjectViewSpec = z.infer<typeof objectViewSpecSchema>;
export type TableViewSpec = z.infer<typeof tableViewSpecSchema>;
export type BoardViewSpec = z.infer<typeof boardViewSpecSchema>;
export type CalendarViewSpec = z.infer<typeof calendarViewSpecSchema>;
export type GalleryViewSpec = z.infer<typeof galleryViewSpecSchema>;

/** Every view spec, dashboards included (record tabs and panels may embed any of them). */
export const viewSpecSchema = z.discriminatedUnion("type", [
  tableViewSpecSchema,
  boardViewSpecSchema,
  calendarViewSpecSchema,
  galleryViewSpecSchema,
  dashboardViewSpecSchema,
]);
export type ViewSpec = z.infer<typeof viewSpecSchema>;

/** Reads a stored spec: stage-1 specs are tables; a spec without `type` is read as a table. */
export function parseStoredViewSpec(json: string): ObjectViewSpec {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const withType =
    raw && typeof raw === "object" && !("type" in raw) ? { ...raw, type: "table" } : raw;
  const parsed = objectViewSpecSchema.safeParse(withType);
  // A spec that no longer parses (hand-edited row) still loads as a table of its columns.
  if (parsed.success) return parsed.data;
  return {
    type: "table",
    object: String((raw as { object?: unknown }).object ?? ""),
    filter: null,
    sort: null,
    columns: Array.isArray((raw as { columns?: unknown }).columns)
      ? ((raw as { columns: string[] }).columns as string[])
      : ["id"],
  };
}

function requireField(object: ObjectDefinition, name: string, role: string): FieldDefinition {
  const field = object.fields.find((f) => f.name === name);
  if (!field) {
    throw new ValidationError(`${role}: ${object.name} has no field "${name}"`, {
      field: role,
      allowed: object.fields.map((f) => f.name),
    });
  }
  return field;
}

/** A single-valued select (enum) field a board can group by. */
export function isGroupable(field: FieldDefinition): boolean {
  return field.type === "enum" && !field.related && Boolean(field.column);
}

/** A number field a board can sum (number, currency, percent). */
export function isSummable(field: FieldDefinition): boolean {
  return field.type === "number" && !field.related && Boolean(field.column);
}

/** A date or datetime field a calendar can place records by. */
export function isDateField(field: FieldDefinition): boolean {
  return (field.type === "date" || field.type === "datetime") && Boolean(field.column);
}

/** The choices of a groupable field, in declared order. */
export function groupValues(field: FieldDefinition): string[] {
  return field.options?.choices?.map((c) => c.value) ?? [...(field.enumValues ?? [])];
}

function checkCardFields(object: ObjectDefinition, names: readonly string[]) {
  for (const name of names) requireField(object, name, "cardFields");
  if (new Set(names).size !== names.length) {
    throw new ValidationError("A card field is listed twice", { field: "cardFields" });
  }
}

/** Checks an object view spec against the field registry; returns it normalised for storage. */
export function validateViewSpec(spec: ObjectViewSpec): ObjectViewSpec {
  const object = getObject(spec.object);
  if (!object) throw new ValidationError(`Unknown object ${spec.object}`, { field: "object" });
  if (spec.filter) compileFilter(object, spec.filter);
  if ("sort" in spec && spec.sort) resolveSort(object, spec.sort);
  switch (spec.type) {
    case "table": {
      const names = new Set(object.fields.map((f) => f.name));
      const unknown = spec.columns.filter((c) => !names.has(c));
      if (unknown.length) {
        throw new ValidationError(`Unknown ${spec.object} columns: ${unknown.join(", ")}`, {
          field: "columns",
        });
      }
      if (new Set(spec.columns).size !== spec.columns.length) {
        throw new ValidationError("A column is listed twice", { field: "columns" });
      }
      return {
        type: "table",
        object: spec.object,
        filter: spec.filter ?? null,
        sort: spec.sort ?? null,
        columns: spec.columns,
      };
    }
    case "board": {
      const group = requireField(object, spec.groupBy, "groupBy");
      if (!isGroupable(group)) {
        throw new ValidationError(
          `groupBy: ${spec.object}.${spec.groupBy} is not a single-select field`,
          { field: "groupBy" },
        );
      }
      if (spec.sumField) {
        const sum = requireField(object, spec.sumField, "sumField");
        if (!isSummable(sum)) {
          throw new ValidationError(
            `sumField: ${spec.object}.${spec.sumField} is not a number or currency field`,
            { field: "sumField" },
          );
        }
      }
      checkCardFields(object, spec.cardFields);
      return {
        type: "board",
        object: spec.object,
        filter: spec.filter ?? null,
        sort: spec.sort ?? null,
        groupBy: spec.groupBy,
        columnOrder: spec.columnOrder ?? null,
        hiddenColumns: spec.hiddenColumns ?? null,
        sumField: spec.sumField ?? null,
        cardFields: spec.cardFields,
      };
    }
    case "calendar": {
      const date = requireField(object, spec.dateField, "dateField");
      if (!isDateField(date)) {
        throw new ValidationError(
          `dateField: ${spec.object}.${spec.dateField} is not a date or datetime field`,
          { field: "dateField" },
        );
      }
      checkCardFields(object, spec.cardFields);
      return {
        type: "calendar",
        object: spec.object,
        filter: spec.filter ?? null,
        dateField: spec.dateField,
        mode: spec.mode,
        cardFields: spec.cardFields,
      };
    }
    case "gallery": {
      if (spec.imageField) {
        const image = requireField(object, spec.imageField, "imageField");
        if (image.type !== "text" || image.related) {
          throw new ValidationError(
            `imageField: ${spec.object}.${spec.imageField} is not a text or URL field`,
            {
              field: "imageField",
            },
          );
        }
      }
      checkCardFields(object, spec.cardFields);
      return {
        type: "gallery",
        object: spec.object,
        filter: spec.filter ?? null,
        sort: spec.sort ?? null,
        imageField: spec.imageField ?? null,
        cardFields: spec.cardFields,
      };
    }
  }
}
