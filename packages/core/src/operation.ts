// defineOperation (ADR 0003, ADR 0016): every operation is defined once with zod schemas, a
// model-facing description, a permission and a risk class. Adapters (server functions now, MCP in
// stage 2, the `codemode:crm` host module in stage 3) are generated from these definitions.
import type { MarketplaceClient } from "@relationship-os/agent-plugins";
import type { AuditChangeAction, CoreDatabase, CrmDb } from "@relationship-os/db";
import type { PermissionsManifest } from "@relationship-os/sdk";
import type { Compilable, CompiledQuery, Kysely } from "kysely";
import type { z } from "zod";
import type { AiAdmin } from "./ai/admin.ts";
import type { AiEnv } from "./ai/client.ts";
import type { VectorStore } from "./ai/vectors.ts";
import type { AssistantThreadStore } from "./assistant/threads.ts";
import type { AutomationHost, EventSink } from "./automations/types.ts";
import type { WidgetCache } from "./dashboards/cache.ts";
import type { FieldDiff } from "./diff.ts";
import type { ExtensionHost } from "./extensions/host.ts";
import type { GateFloor } from "./gate.ts";
import type { BlobStore, IntegrationRuntime } from "./integrations/runtime.ts";
import type { Judge } from "./judge/types.ts";
import type { ModelRunner } from "./models.ts";
import type { VoiceRuntime } from "./operations/voice.ts";
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
import type { UpdaterRuntime } from "./updates.ts";

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
  /**
   * For updates that post on the timeline (tracked fields changed): a subject instead of
   * "<Field> changed", the records to post on (default: this one) and display labels for
   * values such as relation ids (ADR 0100).
   */
  timeline?: {
    subject?: string;
    links?: RecordRef[];
    labels?: Record<string, { before: string | null; after: string | null }>;
  };
  /**
   * The owner was set by an assignment rule (ADR 0246): the owner field's diff entry records the
   * rule's name as `assignedBy`.
   */
  assignment?: { field: string; rule: string } | undefined;
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
  /** The id of this invocation's audit row (written with the batch, when the call is audited). */
  readonly auditId?: string;
  /** Typed Kysely for reads and for building the statements passed to `write`. */
  readonly db: Kysely<CoreDatabase>;
  /** The deploy-time approval floor (APPROVAL_FLOOR) the gate applied, for display. */
  readonly floor: GateFloor;
  /** What the caller's credential allows (MCP token scopes), when it is limited. */
  readonly grantedPermissions?: readonly Permission[] | undefined;
  /** The caller's reason for the change, when it gave one (MCP). */
  readonly reason?: string | undefined;
  /** Queues statements (Kysely insert/update/delete builders) for the commit batch, in order. */
  write(...statements: (Compilable | CompiledQuery)[]): void;
  /**
   * Records a touched record for the audit log. For `update`s, changed fields flagged
   * `track: "timeline"` in the field registry also post a system activity on the record.
   */
  recordChange(change: RecordChange): void;
  /** Queues a `system` activity linked to `links`. Returns its id. */
  postActivity(activity: SystemActivityInput): string;
  /** Wrap the handler's return value to read the output after the commit (see afterCommit). */
  afterCommit: typeof afterCommit;
  /**
   * Present only while a call is being simulated for the approval queue (a dry run whose writes
   * are discarded). It shows the records the session's earlier pending actions created, changed
   * or deleted, so checks such as link targets accept provisional ids (`per_pending_…`).
   */
  readonly simulation?: SimulationView;
  /**
   * Trusted pipeline access for the approval operations, which re-run queued actions through
   * the pipeline on approval. Other handlers never need it.
   */
  readonly pipeline: PipelineAccess;
  /** The extension runtime, when the adapter provides one (extension.* and x.* operations). */
  readonly extensionHost?: ExtensionHost;
  /** For actor `extension`: the calling extension. */
  readonly extension?: ExtensionCaller;
  /** The integration host, when the adapter provides one (connection.*, integration.*). */
  readonly integrations?: IntegrationRuntime;
  /** Blob storage (R2) for email bodies, when the adapter provides it. */
  readonly blobs?: BlobStore;
  /** Model roles (ADR 0009), when the adapter has an AI binding. Absent: AI is not configured. */
  readonly models?: ModelRunner;
  /**
   * The judge (ADR 0230). Absent or off (no key): every placement behaves as before stage 11.
   * Ask it only on an explicit action, never on a read path.
   */
  readonly judge?: Judge;
  /**
   * The person's own words, passed by code (the assistant's Durable Object), never by a model:
   * what `authoring.intent` checks an automation against.
   */
  readonly personsWords?: string;
  /**
   * The chat turn this call is part of, passed by code (the assistant's Durable Object), never by
   * a model. `memory.propose` checks a line against the person's words and links it to their
   * message; an assistant call without it (an agent) cannot write memory (ADR 0342).
   */
  readonly assistantTurn?: AssistantTurn;
  /** The dashboard widget result cache (ADR 0057). Absent: the Workers Cache API. */
  readonly widgetCache?: WidgetCache;
  /** The self-updater (ADR 0164), when the adapter provides one (update.*). */
  readonly updater?: UpdaterRuntime;
  /** Record embeddings (ADR 0154). Absent: semantic search is not configured. */
  readonly vectors?: VectorStore;
  /** Cloudflare API access for Settings → AI (ADR 0151, 0152), when configured. */
  readonly aiAdmin?: AiAdmin;
  /** The AI part of the Worker environment (bindings present, deploy config). */
  readonly aiEnv?: AiEnv;
  /** Post-commit automation events (ADR 0130), for operations that emit their own (approvals). */
  readonly events?: EventSink;
  /** ros-runner's automation host, for automation.* operations. */
  readonly automationHost?: AutomationHost;
  /** The assistant threads (Durable Objects): thread.* operations and erase reach them (ADR 0340). */
  readonly assistantThreads?: AssistantThreadStore;
  /** Speech providers for voice.* operations (ADR 0349). Absent: voice is off. */
  readonly voice?: VoiceRuntime;
  /** The hosted plugin marketplace (ADR 0347). Absent: this deployment has none. */
  readonly marketplace?: MarketplaceClient;
}

/** The person's message a chat turn answers. */
export interface AssistantTurn {
  threadId: string;
  messageSeq: number;
  /** The person's words this turn. */
  text: string;
}

/** The extension an `extension`-actor call runs for, and its approved permissions. */
export interface ExtensionCaller {
  id: string;
  permissions: PermissionsManifest;
}

/** A record as a session's pending actions would leave it (ADR 0022). */
export interface SimulatedRecord {
  object: string;
  /** Real id, or a provisional id for a pending create. */
  id: string;
  state: "live" | "deleted";
  /** The record as `<object>.get` would return it, when it can be simulated. */
  record: Record<string, unknown> | null;
  /** The pending action that last changed it. */
  actionId: string;
  changeSetId: string;
}

export interface SimulationView {
  record(object: string, id: string): SimulatedRecord | undefined;
  records(): SimulatedRecord[];
}

export interface PipelineAccess {
  readonly crm: CrmDb;
  /**
   * Runs another operation through the full pipeline (gate, audit, one batch) with a different
   * actor, user and origin. Used to apply approved pending actions.
   */
  invoke(name: string, input: unknown, ctx: NestedInvocation): Promise<unknown>;
}

export interface NestedInvocation {
  actor: Actor;
  user: ActingUser;
  origin: Origin;
  grantedPermissions?: readonly Permission[] | undefined;
  approval?: ApplyingApproval;
  /** Why the change is wanted; stored on the pending action if the nested call is queued. */
  reason?: string | undefined;
}

/** Set when a call is the approved application of a pending action. */
export interface ApplyingApproval {
  actionId: string;
  /** The human who approved it. */
  approvedBy: string;
  /** Provisional ids the action created when it was simulated, in creation order. */
  provisional: readonly { object: string; id: string }[];
  /**
   * The diff preview the human approved. When a field's current value no longer matches the
   * preview's `before`, the record changed meanwhile and the action fails with a conflict.
   */
  preview: readonly { object: string; id: string; action: string; diff: FieldDiff }[];
}

/** MCP metadata (ADR 0021). */
export interface McpOptions {
  /** Default true. False keeps the operation invisible to MCP and uncallable from it. */
  expose?: boolean;
  /**
   * A curated tool: listed as its own MCP tool. Everything else MCP may call is reached through
   * `describe_operations` / `call_operation`. (The spec's `mcp: "curated"` flag.)
   */
  curated?: boolean;
  /** Short human title for the tool. */
  title?: string;
  /** MCP tool annotations; risk class supplies sensible defaults. */
  idempotent?: boolean;
  /**
   * Ask MCP callers for a `reason` even though the operation is bookkeeping (e.g.
   * extension.propose, whose reason goes on the pending action it queues).
   */
  requireReason?: boolean;
  /** The MCP tool name of a curated operation, when not `<object>_<verb>` (e.g. `code`). */
  toolName?: string;
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
  /**
   * The operation only changes approval or connection bookkeeping (opening a change set,
   * revoking a token), never records, so the gate never queues it for review. A `deny` from the
   * policy or floor still applies.
   */
  bookkeeping?: boolean;
  /**
   * Always queue for human review, whatever the actor, preset or floor says (a `deny` still
   * applies). Used where a change must never auto-apply: extension.apply (an extension install
   * or upgrade, including any widening of its permissions, ADR 0041). `true` for every actor,
   * or the actors it applies to.
   */
  alwaysReview?: true | readonly Actor[];
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
