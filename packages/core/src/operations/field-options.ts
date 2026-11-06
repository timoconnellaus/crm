// fieldOptions.* (ADR 0246 amendment): admins edit the options of extension select fields declared
// with `editableOptions` (a lead's status and source). The edit replaces the declared options in
// the field registry, so validation, filters, boards and forms all use it. Options the extension
// marks `fixed` (its code relies on them) can be relabelled, recoloured and reordered, not removed.
import { z } from "zod";
import { ValidationError } from "../errors.ts";
import { type FieldOption, fieldStorage, mergeOptions } from "../extensions/schema.ts";
import { getObject, listObjects } from "../fields/index.ts";
import { defineOperation } from "../operation.ts";

const optionSchema = z.object({
  value: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(100),
  color: z.string().max(20).optional(),
});

const declaredSchema = optionSchema.extend({ fixed: z.boolean() });

const editableFieldSchema = z.object({
  object: z.string(),
  objectLabel: z.string(),
  field: z.string(),
  label: z.string(),
  extension: z.string().nullable(),
  /** The options in use (edited, or the declared defaults). */
  options: z.array(declaredSchema),
  /** What the extension declares: the defaults "Reset" goes back to. */
  defaults: z.array(declaredSchema),
  edited: z.boolean(),
});

function shape(options: readonly FieldOption[]) {
  return options.map((o) => ({
    value: o.value,
    label: o.label,
    ...(o.color ? { color: o.color } : {}),
    fixed: Boolean(o.fixed),
  }));
}

function editableFields() {
  return listObjects().flatMap((object) =>
    object.fields
      .filter((f) => f.options?.editableOptions)
      .map((field) => {
        const storage = fieldStorage(object.name, field.name);
        const declared = (storage?.definition.declaredOptions ??
          storage?.definition.options ??
          []) as FieldOption[];
        return {
          object: object.name,
          objectLabel: object.label,
          field: field.name,
          label: field.label,
          extension: field.extension ?? null,
          options: shape((field.options?.choices ?? []) as FieldOption[]),
          defaults: shape(declared),
          edited: Boolean(storage?.definition.declaredOptions),
        };
      }),
  );
}

export const fieldOptionsList = defineOperation({
  name: "fieldOptions.list",
  description:
    "List the select fields whose options admins can edit (declared by extensions with " +
    "editableOptions, such as a lead's status and source): the options in use and the " +
    "declared defaults. Fixed options cannot be removed. Read-only.",
  input: z.object({ object: z.string().max(80).optional() }),
  output: z.object({ items: z.array(editableFieldSchema) }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input) {
    return { items: editableFields().filter((f) => !input.object || f.object === input.object) };
  },
});

export const fieldOptionsUpdate = defineOperation({
  name: "fieldOptions.update",
  description:
    "Set the options of an editable select field (admins): the full list in order, each " +
    "{ value, label, color? }. New values become choices; fixed options must stay. Records " +
    "holding a removed option keep their value. Pass options null to go back to the defaults.",
  input: z.object({
    object: z.string().min(1).max(80),
    field: z.string().min(1).max(80),
    options: z.array(optionSchema).min(1).max(200).nullable(),
  }),
  output: editableFieldSchema,
  permission: "extensions:manage",
  risk: "write",
  async handler(input, ctx) {
    const object = getObject(input.object);
    const field = object?.fields.find((f) => f.name === input.field);
    if (!object || !field?.options?.editableOptions) {
      throw new ValidationError(`${input.object}.${input.field} has no editable options`, {
        field: "field",
      });
    }
    const current = editableFields().find(
      (f) => f.object === input.object && f.field === input.field,
    );
    const defaults = (current?.defaults ?? []) as FieldOption[];
    if (input.options === null) {
      ctx.write(
        ctx.db
          .deleteFrom("core_field_options")
          .where("object_type", "=", object.name)
          .where("field", "=", field.name),
      );
      return {
        ...(current as z.input<typeof editableFieldSchema>),
        options: shape(defaults),
        edited: false,
      };
    }
    const values = input.options.map((o) => o.value);
    if (new Set(values).size !== values.length) {
      throw new ValidationError("Each option needs its own value", { field: "options" });
    }
    const missing = defaults.filter((o) => o.fixed && !values.includes(o.value));
    if (missing.length) {
      throw new ValidationError(
        `${missing.map((o) => o.label).join(", ")} cannot be removed: ${field.extension ?? "the extension"} relies on it`,
        { field: "options", fixed: missing.map((o) => o.value) },
      );
    }
    const options = input.options.map((o) => ({
      value: o.value,
      label: o.label,
      ...(o.color ? { color: o.color } : {}),
    }));
    ctx.write(
      ctx.db
        .insertInto("core_field_options")
        .values({
          object_type: object.name,
          field: field.name,
          options: JSON.stringify(options),
          updated_at: ctx.now,
          updated_by: ctx.user.id,
        })
        .onConflict((oc) =>
          oc.columns(["object_type", "field"]).doUpdateSet({
            options: JSON.stringify(options),
            updated_at: ctx.now,
            updated_by: ctx.user.id,
          }),
        ),
    );
    return {
      ...(current as z.input<typeof editableFieldSchema>),
      options: shape(mergeOptions(defaults, options)),
      edited: true,
    };
  },
});

export const fieldOptionsOperations = [fieldOptionsList, fieldOptionsUpdate] as const;
