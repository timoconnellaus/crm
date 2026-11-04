// Contract checks for an object's behaviour keys (ADR 0100): indexes, timeline links, the stage
// behaviour and seed records. Called by validateManifest for every declared object.
import { STAGE_TYPES } from "./contract.ts";
import type { FieldTypeName } from "./field-types.ts";
import type { ExtensionManifest, FieldManifest, ObjectManifest } from "./manifest.ts";

const NUMERIC: readonly FieldTypeName[] = ["number", "percent", "currency"];
const SEED_KEY_RE = /^[a-z][a-zA-Z0-9]{0,39}$/;

/** Reports problems with `objects.<name>`'s behaviour keys through `contract`. */
export function checkObjectBehaviour(
  m: ExtensionManifest,
  name: string,
  object: ObjectManifest,
  contract: (path: string, message: string) => void,
): void {
  const path = `objects.${name}`;
  const fieldOf = (local: string): FieldManifest | undefined =>
    Object.hasOwn(object.fields, local) ? object.fields[local] : undefined;
  const isSingle = (field: FieldManifest | undefined) =>
    field !== undefined && field.type !== "formula" && field.type !== "multiSelect" && !field.many;
  const relationTo = (field: FieldManifest | undefined) =>
    field?.type === "relation" && !field.many ? field.to : undefined;
  const ownObject = (target: string | undefined) =>
    target?.startsWith(`${m.id}.`) ? m.objects[target.slice(m.id.length + 1)] : undefined;

  (object.indexes ?? []).forEach((columns, i) => {
    if (new Set(columns).size !== columns.length) {
      contract(`${path}.indexes.${i}`, "An index lists each field once");
    }
    for (const column of columns) {
      if (column === "createdAt" || column === "updatedAt") continue;
      if (!isSingle(fieldOf(column))) {
        contract(
          `${path}.indexes.${i}`,
          `Index field "${column}" must be a single-valued, non-formula field of ${name}`,
        );
      }
    }
  });

  (object.timelineLinks ?? []).forEach((local, i) => {
    if (!relationTo(fieldOf(local))) {
      contract(`${path}.timelineLinks.${i}`, `"${local}" must be a relation field (one record)`);
    }
  });

  const stages = object.stages;
  if (stages) {
    const sp = `${path}.stages`;
    const stageTarget = relationTo(fieldOf(stages.field));
    const stageObject = ownObject(stageTarget);
    if (!stageObject) {
      contract(
        `${sp}.field`,
        `"${stages.field}" must be a relation field (one record) to another of this extension's objects`,
      );
    } else {
      if (fieldOf(stages.field)?.readOnly) {
        contract(`${sp}.field`, "The stage field cannot be read-only");
      }
      const sf = (local: string): FieldManifest | undefined =>
        Object.hasOwn(stageObject.fields, local) ? stageObject.fields[local] : undefined;
      const type = sf(stages.stage.type);
      const values = type?.options?.map((o) => o.value) ?? [];
      if (type?.type !== "select" || !STAGE_TYPES.every((t) => values.includes(t))) {
        contract(
          `${sp}.stage.type`,
          `"${stages.stage.type}" must be a select field of ${stageTarget} with options open, won and lost`,
        );
      }
      const order = sf(stages.stage.order);
      if (!order || !NUMERIC.includes(order.type)) {
        contract(
          `${sp}.stage.order`,
          `"${stages.stage.order}" must be a number field of ${stageTarget}`,
        );
      }
      if (stages.stage.requiredFields !== undefined) {
        const required = sf(stages.stage.requiredFields);
        if (required?.type !== "multiSelect") {
          contract(
            `${sp}.stage.requiredFields`,
            `"${stages.stage.requiredFields}" must be a multiSelect field of ${stageTarget}`,
          );
        } else {
          for (const option of required.options ?? []) {
            const target = fieldOf(option.value);
            if (!target || target.type === "formula" || target.readOnly) {
              contract(
                `${sp}.stage.requiredFields`,
                `Option "${option.value}" must name a writable field of ${name}`,
              );
            }
          }
        }
      }
      if (stages.stage.probability !== undefined) {
        const probability = sf(stages.stage.probability);
        if (!probability || !NUMERIC.includes(probability.type)) {
          contract(
            `${sp}.stage.probability`,
            `"${stages.stage.probability}" must be a number or percent field of ${stageTarget}`,
          );
        }
      }
      const stageGroup = stages.stage.group ? relationTo(sf(stages.stage.group)) : undefined;
      if (stages.stage.group !== undefined && !stageGroup) {
        contract(
          `${sp}.stage.group`,
          `"${stages.stage.group}" must be a relation field (one record) of ${stageTarget}`,
        );
      }
      if ((stages.group === undefined) !== (stages.stage.group === undefined)) {
        contract(`${sp}.group`, "Declare both group and stage.group, or neither");
      } else if (stages.group !== undefined && relationTo(fieldOf(stages.group)) !== stageGroup) {
        contract(
          `${sp}.group`,
          `"${stages.group}" must be a relation field to the same object as ${stageTarget}.${stages.stage.group}`,
        );
      }
    }
    if (stages.probability) {
      const field = fieldOf(stages.probability.field);
      if (!field || !NUMERIC.includes(field.type) || field.readOnly) {
        contract(
          `${sp}.probability.field`,
          `"${stages.probability.field}" must be a writable number or percent field`,
        );
      }
      const flag = fieldOf(stages.probability.overridden);
      if (flag?.type !== "boolean" || flag.readOnly) {
        contract(
          `${sp}.probability.overridden`,
          `"${stages.probability.overridden}" must be a writable boolean field`,
        );
      }
      if (!stages.stage.probability) {
        contract(`${sp}.stage.probability`, "probability needs the stage's default probability");
      }
    }
    if (stages.closedDate !== undefined) {
      const field = fieldOf(stages.closedDate);
      if ((field?.type !== "date" && field?.type !== "datetime") || !field.readOnly) {
        contract(
          `${sp}.closedDate`,
          `"${stages.closedDate}" must be a read-only date or datetime field`,
        );
      }
    }
    if (stages.status !== undefined) {
      const field = fieldOf(stages.status);
      const values = field?.options?.map((o) => o.value) ?? [];
      if (
        field?.type !== "select" ||
        !field.readOnly ||
        !STAGE_TYPES.every((t) => values.includes(t))
      ) {
        contract(
          `${sp}.status`,
          `"${stages.status}" must be a read-only select field with options open, won and lost`,
        );
      }
    }
    for (const [type, list] of Object.entries(stages.requiredByType ?? {})) {
      for (const local of list ?? []) {
        const field = fieldOf(local);
        if (!field || field.type === "formula" || field.readOnly) {
          contract(`${sp}.requiredByType.${type}`, `"${local}" must be a writable field of ${name}`);
        }
      }
    }
  }

  for (const [key, values] of Object.entries(object.seed ?? {})) {
    const kp = `${path}.seed.${key}`;
    if (!SEED_KEY_RE.test(key)) contract(kp, "Seed keys must be camelCase");
    for (const [local, value] of Object.entries(values)) {
      const field = fieldOf(local);
      if (!field || field.type === "formula" || field.readOnly) {
        contract(`${kp}.${local}`, `"${local}" is not a writable field of ${name}`);
        continue;
      }
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const ref = (value as { seed?: unknown }).seed;
        const target = ownObject(field.type === "relation" ? field.to : undefined);
        if (typeof ref !== "string" || !target?.seed || !Object.hasOwn(target.seed, ref)) {
          contract(
            `${kp}.${local}`,
            "A seed reference ({ seed: key }) must name a seed record of the relation's target",
          );
        }
      }
    }
    for (const [local, field] of Object.entries(object.fields)) {
      if (field.required && !(local in values)) {
        contract(kp, `Seed record "${key}" needs required field "${local}"`);
      }
    }
  }
}
