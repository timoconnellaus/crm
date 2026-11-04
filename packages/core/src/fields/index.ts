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

/** Looks up an object by registry name (core objects only in stage 1). */
export function getObject(name: string): ObjectDefinition | undefined {
  return Object.hasOwn(CORE_OBJECTS, name)
    ? (CORE_OBJECTS as Record<string, ObjectDefinition>)[name]
    : undefined;
}
