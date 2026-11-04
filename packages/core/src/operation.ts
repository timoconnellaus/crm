// defineOperation (ADR 0003, ADR 0016): every operation is defined once with zod schemas, a
// model-facing description, a permission and a risk class. Adapters (server functions now, MCP in
// stage 2, the `codemode:crm` host module in stage 3) are generated from these definitions.
import type { AuditChangeAction, CoreDatabase } from "@crm/db";
import type { Compilable, Kysely } from "kysely";
import type { z } from "zod";
import type { FieldDiff } from "./diff.ts";
import type { GateFloor } from "./gate.ts";
import {
  ACTORS,
  type ActingUser,
  type Actor,
  type Origin,
  PERMISSIONS,
  type Permission,
  RISK_CLASSES,
  type RiskClass,
} from "./principals.ts";

/** One record touched by an operation, recorded as field diffs in core_audit_changes. */
export interface RecordChange {
  /** Registry object name: `person`, `organisation`, `task`, ... */
  object: string;
  id: string;
  action: AuditChangeAction;
  /** Snapshot before (null/omitted for create). Keys are field-registry names. */
  before?: Record<string, unknown> | null;
  /** Snapshot after (null/omitted for erase). */
  after?: Record<string, unknown> | null;
  /** Precomputed diff; when given, before/after are ignored. */
  diff?: FieldDiff;
}

/** A link from an activity or task to a record. */
export interface RecordRef {
  object: string;
  id: string;
}

/** A `system` activity to post on one or more records' timelines. */
export interface SystemActivityInput {
  subject: string;
  body?: string | null;
  /** Typed JSON payload. `kind` names the event, e.g. `field_change`, `job_change`. */
  payload: { kind: string } & Record<string, unknown>;
  links: RecordRef[];
  occurredAt?: string;
}

const AFTER_COMMIT = Symbol("afterCommit");

/** Returned by a handler to compute its output by reading after the writes commit. */
export interface AfterCommit<T> {
  readonly [AFTER_COMMIT]: () => Promise<T>;
}

export function afterCommit<T>(read: () => Promise<T>): AfterCommit<T> {
  return { [AFTER_COMMIT]: read };
}

export function isAfterCommit(value: unknown): value is AfterCommit<unknown> {
  return typeof value === "object" && value !== null && AFTER_COMMIT in value;
}

export function runAfterCommit<T>(value: AfterCommit<T>): Promise<T> {
  return value[AFTER_COMMIT]();
}

/**
 * What a handler receives. Reads run immediately through `db`; writes are queued with `write()`
 * and committed by the pipeline in one D1 batch together with the audit row and any timeline
 * activities, so an operation applies completely or not at all. Queued writes are not visible
 * to reads in the same handler.
 */
export interface HandlerContext {
  readonly operation: string;
  readonly actor: Actor;
  readonly user: ActingUser;
  readonly origin: Origin;
  /** The invocation's timestamp (ISO-8601 UTC). Use it for created_at/updated_at. */
  readonly now: string;
  /** Typed Kysely for reads and for building the statements passed to `write`. */
  readonly db: Kysely<CoreDatabase>;
  /** The deploy-time approval floor (APPROVAL_FLOOR) the gate applied, for display. */
  readonly floor: GateFloor;
  /** Queues statements (Kysely insert/update/delete builders) for the commit batch, in order. */
  write(...statements: Compilable[]): void;
  /**
   * Records a touched record for the audit log. For `update`s, changed fields flagged
   * `track: "timeline"` in the field registry also post a system activity on the record.
   */
  recordChange(change: RecordChange): void;
  /** Queues a `system` activity linked to `links`. Returns its id. */
  postActivity(activity: SystemActivityInput): string;
  /** Wrap the handler's return value to read the output after the commit (see afterCommit). */
  afterCommit: typeof afterCommit;
}

/** Stage-2 MCP metadata. Present now so definitions don't change when the adapter lands. */
export interface McpOptions {
  /** Default true. False keeps the operation off the MCP tool list. */
  expose?: boolean;
  /** Short human title for the tool. */
  title?: string;
  /** MCP tool annotations; risk class supplies sensible defaults. */
  idempotent?: boolean;
}

export interface OperationDefinition<
  Name extends string,
  In extends z.ZodType,
  Out extends z.ZodType,
> {
  /** `<object>.<verb>`, e.g. `person.create`. */
  name: Name;
  /** Written for a model: what it does, when to use it, and its side effects. */
  description: string;
  input: In;
  output: Out;
  permission: Permission;
  risk: RiskClass;
  /** Actor types allowed to call it at all. Default: every actor. */
  actors?: readonly Actor[];
  /** For bulk operations: how many records this input touches (the gate's bulk threshold). */
  bulkSize?: (input: z.output<In>) => number;
  /** Extra input keys to redact in the audit log (secrets matching common names always are). */
  redact?: readonly string[];
  /** A small JSON summary of the result for the audit log. Default: touched records or id. */
  auditSummary?: (output: z.output<Out>, input: z.output<In>) => unknown;
  mcp?: McpOptions;
  handler: (
    input: z.output<In>,
    ctx: HandlerContext,
  ) => Promise<z.input<Out> | AfterCommit<z.input<Out>>>;
}

export type Operation<
  Name extends string = string,
  In extends z.ZodType = z.ZodType,
  Out extends z.ZodType = z.ZodType,
> = Readonly<OperationDefinition<Name, In, Out>>;

// biome-ignore lint/suspicious/noExplicitAny: an operation of any input/output shape; handlers are contravariant in their input, so `unknown` would not accept concrete operations.
export type AnyOperation = Operation<string, any, any>;

/** What callers pass (before zod defaults and transforms). */
export type OperationInput<O extends AnyOperation> = z.input<O["input"]>;
/** What callers get back. */
export type OperationOutput<O extends AnyOperation> = z.output<O["output"]>;

export const OPERATION_NAME_RE = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

/** Defines an operation. Checks the definition is complete; the registry test checks them all. */
export function defineOperation<
  const Name extends string,
  In extends z.ZodType,
  Out extends z.ZodType,
>(definition: OperationDefinition<Name, In, Out>): Operation<Name, In, Out> {
  const problems = operationProblems(definition as unknown as AnyOperation);
  if (problems.length) {
    throw new Error(`Operation ${definition.name}: ${problems.join("; ")}`);
  }
  return Object.freeze({ ...definition });
}

/** Lists what is missing or malformed in a definition (empty when it is complete). */
export function operationProblems(op: AnyOperation): string[] {
  const problems: string[] = [];
  if (!OPERATION_NAME_RE.test(op.name ?? "")) problems.push("name must be <object>.<verb>");
  if (typeof op.description !== "string" || op.description.trim().length < 20) {
    problems.push("description must explain what it does, when to use it and side effects");
  }
  if (!op.input || typeof op.input.safeParse !== "function") problems.push("input schema missing");
  if (!op.output || typeof op.output.safeParse !== "function") {
    problems.push("output schema missing");
  }
  if (!PERMISSIONS.includes(op.permission)) problems.push("permission missing or unknown");
  if (!RISK_CLASSES.includes(op.risk)) problems.push("risk class missing or unknown");
  if (op.actors && (op.actors.length === 0 || op.actors.some((a) => !ACTORS.includes(a)))) {
    problems.push("actors must list known actor types");
  }
  if (typeof op.handler !== "function") problems.push("handler missing");
  if ((op.risk === "bulk-write" || op.risk === "destructive") && op.name.endsWith("Many")) {
    if (typeof op.bulkSize !== "function") problems.push("batch operations need bulkSize");
  }
  return problems;
}
