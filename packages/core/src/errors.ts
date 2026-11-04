// Typed errors every adapter (server functions now, MCP and host modules later) maps to its own
// wire format. `code` is stable and safe to show; `details` is JSON-serialisable.

export type OperationErrorCode =
  | "unknown_operation"
  | "invalid_input"
  | "invalid_output"
  | "forbidden"
  | "denied"
  | "review_not_supported"
  | "not_found"
  | "conflict"
  | "config"
  | "timeout"
  | "internal";

export class OperationError extends Error {
  override name = "OperationError";
  constructor(
    readonly code: OperationErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }

  toJSON(): SerializedOperationError {
    return {
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export interface SerializedOperationError {
  code: OperationErrorCode;
  message: string;
  details?: unknown;
}

export class UnknownOperationError extends OperationError {
  override name = "UnknownOperationError";
  constructor(name: string) {
    super("unknown_operation", `No operation named "${name}"`);
  }
}

export class ValidationError extends OperationError {
  override name = "ValidationError";
  constructor(message: string, details?: unknown) {
    super("invalid_input", message, details);
  }
}

/** The caller's role or actor type may not run this operation. */
export class ForbiddenError extends OperationError {
  override name = "ForbiddenError";
  constructor(message: string, details?: unknown) {
    super("forbidden", message, details);
  }
}

/** The approval gate refused the call (policy or floor). */
export class GateDeniedError extends OperationError {
  override name = "GateDeniedError";
  constructor(message: string, details?: unknown) {
    super("denied", message, details);
  }
}

/**
 * The gate routed the call to review. Stage 1 has no approval queue, so it is refused with this
 * typed error; stage 2 replaces it with a pending, simulated result.
 */
export class ReviewNotYetSupportedError extends OperationError {
  override name = "ReviewNotYetSupportedError";
  constructor(message: string, details?: unknown) {
    super("review_not_supported", message, details);
  }
}

export class NotFoundError extends OperationError {
  override name = "NotFoundError";
  constructor(object: string, id: string) {
    super("not_found", `No ${object} with id ${id}`, { object, id });
  }
}

/** A uniqueness rule was broken, e.g. an email already belongs to another live person. */
export class ConflictError extends OperationError {
  override name = "ConflictError";
  constructor(message: string, details?: unknown) {
    super("conflict", message, details);
  }
}

export class ConfigError extends OperationError {
  override name = "ConfigError";
  constructor(message: string) {
    super("config", message);
  }
}

/** Converts D1 constraint failures into typed errors; everything else becomes `internal`. */
export function toOperationError(error: unknown): OperationError {
  if (error instanceof OperationError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const unique = /UNIQUE constraint failed: ([\w.]+(?:, [\w.]+)*)/.exec(message);
  if (unique) {
    return new ConflictError("A record with that value already exists", {
      constraint: unique[1],
    });
  }
  if (/FOREIGN KEY constraint failed/.test(message)) {
    return new ValidationError("A referenced record does not exist");
  }
  if (/CHECK constraint failed/.test(message)) {
    return new ValidationError("A value is not allowed", { reason: message });
  }
  return new OperationError("internal", "Internal error", { reason: message });
}
