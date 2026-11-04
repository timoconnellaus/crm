// The core registry and typed entry points adapters call.
import { UnknownOperationError } from "./errors.ts";
import type { AnyOperation, OperationInput, OperationOutput } from "./operation.ts";
import { coreOperations } from "./operations/index.ts";
import { type InvocationContext, invokeOperation } from "./pipeline.ts";
import { createRegistry, type OperationMap, type OperationRegistry } from "./registry.ts";

export const coreRegistry = createRegistry(coreOperations);

/** `{ "person.create": typeof personCreate, ... }` */
export type CoreOperations = OperationMap<typeof coreOperations>;
export type CoreOperationName = keyof CoreOperations & string;
export type CoreInput<N extends CoreOperationName> = OperationInput<CoreOperations[N]>;
export type CoreOutput<N extends CoreOperationName> = OperationOutput<CoreOperations[N]>;

/** A typed `invoke` and a name-checked `invokeByName` over any registry. */
export function createInvoker<Ops extends readonly AnyOperation[]>(
  registry: OperationRegistry<Ops>,
) {
  type Map = OperationMap<Ops>;
  /** For adapters receiving a name from the wire: rejects with UnknownOperationError. */
  const invokeByName = async (
    name: string,
    input: unknown,
    ctx: InvocationContext,
  ): Promise<unknown> => {
    const op = registry.get(name);
    if (!op) throw new UnknownOperationError(name);
    return invokeOperation(op, input, {
      resolveOperation: (other: string) => registry.get(other),
      ...ctx,
    });
  };
  const invoke = <N extends keyof Map & string>(
    name: N,
    input: Map[N] extends AnyOperation ? OperationInput<Map[N]> : never,
    ctx: InvocationContext,
  ) =>
    invokeByName(name, input, ctx) as Promise<
      Map[N] extends AnyOperation ? OperationOutput<Map[N]> : never
    >;
  return { invoke, invokeByName };
}

const coreInvoker = createInvoker(coreRegistry);

/** Invokes a core operation by name: validate → role → gate → handler → audit. */
export function invoke<N extends CoreOperationName>(
  name: N,
  input: CoreInput<N>,
  ctx: InvocationContext,
): Promise<CoreOutput<N>> {
  return coreInvoker.invokeByName(name, input, ctx) as Promise<CoreOutput<N>>;
}

/** Invokes a core operation whose name arrived as a string. */
export function invokeByName(
  name: string,
  input: unknown,
  ctx: InvocationContext,
): Promise<unknown> {
  return coreInvoker.invokeByName(name, input, ctx);
}
