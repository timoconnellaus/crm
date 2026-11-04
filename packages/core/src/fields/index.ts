// The field registry: every core object's fields. Extension objects join this in stage 3.
import { activityObject } from "./activity.ts";
import { organisationObject } from "./organisation.ts";
import { personObject } from "./person.ts";
import { taskObject } from "./task.ts";
import type { ObjectDefinition } from "./types.ts";

export { activityObject } from "./activity.ts";
export { organisationObject } from "./organisation.ts";
export { personObject } from "./person.ts";
export { taskObject } from "./task.ts";
export * from "./types.ts";

export const CORE_OBJECTS = {
  person: personObject,
  organisation: organisationObject,
  activity: activityObject,
  task: taskObject,
} as const satisfies Record<string, ObjectDefinition>;

export type CoreObjectName = keyof typeof CORE_OBJECTS;

/**
 * Extension objects, and core objects with extension fields appended, by name. Set from D1 by
 * `refreshSchemaRegistry` (extensions/registry.ts), which the pipeline calls at the start of every
 * invocation, so lookups in handlers see the deployment's current schema.
 */
let extensionObjects: ReadonlyMap<string, ObjectDefinition> = new Map();

export function setExtensionObjects(objects: ReadonlyMap<string, ObjectDefinition>): void {
  extensionObjects = objects;
}

/** Looks up an object by registry name: core objects (with extension fields) and extension objects. */
export function getObject(name: string): ObjectDefinition | undefined {
  const extended = extensionObjects.get(name);
  if (extended) return extended;
  return Object.hasOwn(CORE_OBJECTS, name)
    ? (CORE_OBJECTS as Record<string, ObjectDefinition>)[name]
    : undefined;
}

/** Every object in the registry: core objects first, then extension objects by name. */
export function listObjects(): ObjectDefinition[] {
  const core = Object.keys(CORE_OBJECTS).map((name) => getObject(name) as ObjectDefinition);
  const ext = [...extensionObjects.values()]
    .filter((object) => !Object.hasOwn(CORE_OBJECTS, object.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...core, ...ext];
}

export function isCoreObject(name: string): name is CoreObjectName {
  return Object.hasOwn(CORE_OBJECTS, name);
}
