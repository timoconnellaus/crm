// The operations registry: a typed, name-indexed set of operations.
import type { AnyOperation } from "./operation.ts";
import { operationProblems } from "./operation.ts";

/** Maps an operations tuple to `{ [name]: operation }` for typed lookups. */
export type OperationMap<Ops extends readonly AnyOperation[]> = {
  [O in Ops[number] as O["name"]]: O;
};

export class OperationRegistry<Ops extends readonly AnyOperation[]> {
  readonly #byName = new Map<string, AnyOperation>();

  constructor(operations: Ops) {
    for (const op of operations) {
      if (this.#byName.has(op.name)) throw new Error(`Duplicate operation ${op.name}`);
      const problems = operationProblems(op);
      if (problems.length) throw new Error(`Operation ${op.name}: ${problems.join("; ")}`);
      this.#byName.set(op.name, op);
    }
  }

  get(name: string): AnyOperation | undefined {
    return this.#byName.get(name);
  }

  /** Typed lookup of a known operation. */
  require<N extends keyof OperationMap<Ops> & string>(name: N): OperationMap<Ops>[N] {
    const op = this.#byName.get(name);
    if (!op) throw new Error(`No operation named ${name}`);
    return op as OperationMap<Ops>[N];
  }

  has(name: string): boolean {
    return this.#byName.has(name);
  }

  list(): AnyOperation[] {
    return [...this.#byName.values()];
  }

  names(): string[] {
    return [...this.#byName.keys()];
  }
}

export function createRegistry<const Ops extends readonly AnyOperation[]>(
  operations: Ops,
): OperationRegistry<Ops> {
  return new OperationRegistry(operations);
}
