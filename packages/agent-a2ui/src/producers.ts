// Saved A2UI producers (ADR 0346): a short script that queries the host and returns a card with no
// model involved, so repeated cards are fast, cheap and the same every time. This module is the
// registry and the contract; the host decides how a script runs (the CRM runs it on a Dynamic
// Worker under a stable id, so repeat runs reuse the cached worker).
//
// A producer's script is an ES module whose default export is
// `async function (input, { crm, now, timezone })`, returning an A2UI document. It imports nothing.
// `crm.call(operation, input)` reads as the viewer: a producer cannot change anything, and cannot
// show what the viewer cannot see. A version's source never changes: changing what a producer does
// is a new version, which is a new stable id.
import { z } from "zod";
import { A2UI_CATALOGUE_VERSION } from "./catalogue.ts";

export const producerNameSchema = z
  .string()
  .max(120)
  .regex(/^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9_-]+)+$/, "a producer name such as tasks.overdueCard");

export interface SavedProducer {
  /** `tasks.overdueCard`. */
  name: string;
  /** Bumped whenever `source` changes. */
  version: number;
  /** The catalogue version the script writes for. Newer than the host renders: text only. */
  catalogue: number;
  /** One line for the model and for lists. */
  description: string;
  /** Checks the input before the script runs. Defaults apply. */
  input?: z.ZodType<Record<string, unknown>>;
  /** The script (see the top of this file). */
  source: string;
}

/** How a producer version is named in stored cards and stable ids: `tasks.overdueCard@1`. */
export function producerRef(producer: Pick<SavedProducer, "name" | "version">): string {
  return `${producer.name}@${producer.version}`;
}

/** Can this host render what the producer writes? */
export function producerSupported(
  producer: Pick<SavedProducer, "catalogue">,
  supportedVersion: number = A2UI_CATALOGUE_VERSION,
): boolean {
  return producer.catalogue <= supportedVersion;
}

/**
 * The producers a host can run. First-party ones are registered at start-up; plugins add theirs
 * when they install and remove them when they uninstall.
 */
export interface ProducerRegistry {
  /** Adds a producer version. A version's source cannot change, so a different one throws. */
  register(producer: SavedProducer): void;
  /** Removes one version, or every version of a name. */
  remove(name: string, version?: number): void;
  /** One version, or the newest when `version` is absent. */
  get(name: string, version?: number): SavedProducer | undefined;
  /** The newest version of each producer, by name. */
  list(): SavedProducer[];
}

export function createProducerRegistry(initial: readonly SavedProducer[] = []): ProducerRegistry {
  const versions = new Map<string, Map<number, SavedProducer>>();
  const registry: ProducerRegistry = {
    register(producer) {
      producerNameSchema.parse(producer.name);
      const known = versions.get(producer.name) ?? new Map<number, SavedProducer>();
      const existing = known.get(producer.version);
      if (existing && existing.source !== producer.source) {
        throw new Error(`${producerRef(producer)} is already registered with different source`);
      }
      known.set(producer.version, producer);
      versions.set(producer.name, known);
    },
    remove(name, version) {
      if (version === undefined) versions.delete(name);
      else versions.get(name)?.delete(version);
    },
    get(name, version) {
      const known = versions.get(name);
      if (!known?.size) return undefined;
      return known.get(version ?? Math.max(...known.keys()));
    },
    list() {
      return [...versions.keys()]
        .sort()
        .map((name) => registry.get(name))
        .filter((p): p is SavedProducer => p !== undefined);
    },
  };
  for (const producer of initial) registry.register(producer);
  return registry;
}
