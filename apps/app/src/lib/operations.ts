// Typed client for calling operations from the UI:
//
//   const person = await callOp("person.create", { givenName: "Ada" });
//   //    ^? Person — input and output types come from the operation's zod schemas.
//
// Errors are thrown as OperationCallError with the pipeline's stable `code` (forbidden,
// invalid_input, conflict, not_found, denied, review_not_supported, ...).
import type { CoreInput, CoreOperationName, CoreOutput, OperationErrorCode } from "@crm/core";
import { callOperation } from "#/server/call-operation";

export class OperationCallError extends Error {
  override name = "OperationCallError";
  readonly code: OperationErrorCode;
  readonly details: unknown;

  constructor(error: { code: OperationErrorCode; message: string; details?: unknown }) {
    super(error.message);
    this.code = error.code;
    this.details = error.details;
  }
}

export async function callOp<N extends CoreOperationName>(
  name: N,
  input: CoreInput<N>,
): Promise<CoreOutput<N>> {
  const result = await callOperation({ data: { name, input } });
  if (!result.ok) throw new OperationCallError(result.error);
  return result.data as CoreOutput<N>;
}
