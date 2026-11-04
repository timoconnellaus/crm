// The one server function behind every operation call from the UI. Private (not *.public.ts): the
// identity middleware has already resolved the Principal, or refused the request with a 401.
import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { type OperationResult, parseOperationCall, runOperation } from "./operations.ts";

export const callOperation = createServerFn({ method: "POST" })
  .validator(parseOperationCall)
  .handler(async ({ data, context }): Promise<OperationResult> => {
    return runOperation(env, context.principal ?? null, data);
  });
