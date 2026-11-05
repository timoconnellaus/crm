// Typed client for the stage-5 operations (automation.*, notification.*), built on their shared
// zod contracts (packages/core/src/automations/schemas.ts). They are called exactly like `callOp`
// and cached under the same `["op", name, input]` keys, so `invalidateOps(client, "automation.")`
// refreshes them. Once those operations are in the core registry, `callOp` types them too and
// these wrappers keep working unchanged.
import type {
  AUTOMATION_OPERATION_SCHEMAS,
  NOTIFICATION_OPERATION_SCHEMAS,
} from "@relationship-os/core";
import {
  type QueryKey,
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { z } from "zod";
import { callOperation } from "#/server/call-operation";
import { OperationCallError } from "./operations.ts";
import { invalidateAfterWrite } from "./query.ts";

type Schemas = typeof AUTOMATION_OPERATION_SCHEMAS & typeof NOTIFICATION_OPERATION_SCHEMAS;
export type StageOpName = keyof Schemas & string;
/** What a caller passes (defaults optional). */
export type StageInput<N extends StageOpName> = z.input<Schemas[N]["input"]>;
export type StageOutput<N extends StageOpName> = z.output<Schemas[N]["output"]>;

export async function callStageOp<N extends StageOpName>(
  name: N,
  input: StageInput<N>,
): Promise<StageOutput<N>> {
  const result = await callOperation({ data: { name, input } });
  if (!result.ok) throw new OperationCallError(result.error);
  return result.data as StageOutput<N>;
}

export function stageKey<N extends StageOpName>(name: N, input?: StageInput<N>): QueryKey {
  return input === undefined ? ["op", name] : ["op", name, input];
}

/** A read operation as a query (see useOp). */
export function useStageOp<N extends StageOpName>(
  name: N,
  input: StageInput<N>,
  options: Omit<UseQueryOptions<StageOutput<N>, Error>, "queryKey" | "queryFn"> = {},
) {
  return useQuery<StageOutput<N>, Error>({
    queryKey: stageKey(name, input),
    queryFn: () => callStageOp(name, input),
    ...options,
  });
}

/** A write operation as a mutation that refreshes its object's queries (see useOpMutation). */
export function useStageMutation<N extends StageOpName>(
  name: N,
  { invalidates = [] }: { invalidates?: string[] } = {},
) {
  const client = useQueryClient();
  return useMutation<StageOutput<N>, Error, StageInput<N>>({
    mutationFn: (input) => callStageOp(name, input),
    onSuccess: () => invalidateAfterWrite(client, name, invalidates),
  });
}
