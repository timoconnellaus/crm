// What an update does to a copy (ADR 0347). A copy that still matches what it was copied from
// updates by itself, unless the new version asks for more; a changed copy waits for a compare; a
// detached copy hears nothing.
import type { PluginAccess } from "./manifest.ts";

export interface AccessWidening {
  operations: string[];
  connections: string[];
  schema: string[];
}

export function accessWidening(from: PluginAccess, to: PluginAccess): AccessWidening {
  const added = (a: readonly string[], b: readonly string[]) =>
    b.filter((value) => !a.includes(value));
  return {
    operations: added(from.operations, to.operations),
    connections: added(from.connections, to.connections),
    schema: added(from.schema, to.schema),
  };
}

export function widens(widening: AccessWidening): boolean {
  return (
    widening.operations.length > 0 ||
    widening.connections.length > 0 ||
    widening.schema.length > 0
  );
}

export type UpdatePlan =
  /** Already on it, or the source has nothing newer. */
  | "none"
  /** Stopped: the copy stays as it is. */
  | "detached"
  /** Unchanged and asks for nothing new: it applies by itself. */
  | "auto"
  /** Unchanged, but it asks for more: it waits for the person. */
  | "approve"
  /** Changed: Compare, then the merge proposal. */
  | "compare";

export function planUpdate(input: {
  following: boolean;
  /** Upstream differs from what this copy was made from. */
  newer: boolean;
  /** The copy still matches what it was made from. */
  unchanged: boolean;
  widening: AccessWidening;
}): UpdatePlan {
  if (!input.following) return "detached";
  if (!input.newer) return "none";
  if (!input.unchanged) return "compare";
  return widens(input.widening) ? "approve" : "auto";
}
