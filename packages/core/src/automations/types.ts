// Shared automation types (ADR 0028, ADR 0130): post-commit events, the queue message union,
// trigger sources, the automation host (crm-runner RPC), run statuses and step records.
//
// Data flow:
//   pipeline commit ─► EventSink.send(batched AutomationQueueMessage[]) ─► Queue AUTOMATION_EVENTS
//   ─► crm-runner consumer ─► TriggerSource.match(message) per kind ─► rails (depth, cycle,
//   debounce, rate, kill switch, fan-out budget) ─► run row + Workflow AutomationWorkflow
//   (id = workflowInstanceId(...)) ─► each step.do in a Dynamic Worker via the executor.
//
// Stage 6b adds the `integration` message kind (webhooks, sync events) and its TriggerSource; the
// consumer dispatches by `kind`, so nothing else changes.
import type { AutomationManifest, AutomationTestStep, RecordEventType } from "@crm/sdk";
import type { FieldDiff } from "../diff.ts";
import type { Actor, Origin } from "../principals.ts";

/** Automation-caused changes may trigger further automations up to this depth (ADR 0028). */
export const MAX_CASCADE_DEPTH = 3;
/** At most this many runs start from one root event (an import, a cascade), cost audit U3. */
export const FAN_OUT_BUDGET = 500;
/** Record changes per queue message: one operation's changes are chunked, never one per record. */
export const EVENT_CHANGES_PER_MESSAGE = 100;
/** Queue sendBatch takes at most 100 messages and 256 KB; a message at most 128 KB. */
export const QUEUE_BATCH_MESSAGES = 100;
export const QUEUE_MESSAGE_MAX_BYTES = 120_000;
/** Workflow createBatch takes at most 100 instances per call. */
export const WORKFLOW_BATCH_MAX = 100;

/** Settings keys (core_settings, JSON values), seeded by migration 0130. */
export const AUTOMATION_SETTINGS = {
  /** boolean. Human admins only (automation.killSwitch). Pauses every automation at once. */
  killSwitch: "automations_kill_switch",
  /** IANA timezone schedules and date-relative triggers are evaluated in. Default "UTC". */
  timezone: "automation_timezone",
  /** Seconds within which `updated` events for one record coalesce. Default 30. */
  debounceSeconds: "automation_debounce_seconds",
} as const;

/** Host maxima for per-automation rails (an automation's own `rails` can only be stricter). */
export const DEFAULT_RAILS = {
  maxRunsPerMinute: 60,
  maxWritesPerHour: 500,
  debounceSeconds: 30,
} as const;

// ---------------------------------------------------------------------------------------------
// Origin tags carried by every event (cost audit stage-5 notes)

/**
 * Who caused an event and how deep in a cascade it is. Set by the pipeline from the invocation:
 * an automation run's writes carry its automation id, run id and depth; everything else is depth
 * 0. `chain` lists `<automationId>:<object>:<recordId>` for each run in the cascade so far
 * (cycle detection: an automation never retriggers itself on the same record in one cascade).
 */
export interface EventOrigin {
  actor: Actor;
  userId: string;
  surface: Origin["surface"];
  operation: string;
  /** The audit id of the root operation of the cascade. */
  rootEventId: string;
  depth: number;
  chain: string[];
  automationId?: string;
  runId?: string;
  sessionId?: string;
  /** The operation touched more records than the bulk threshold (imports, *Many, backfills). */
  bulk: boolean;
}

/**
 * Cascade context an automation run passes on its writes. It travels in `Origin` (the fields
 * below are added to originSchema) so the pipeline can tag the events those writes emit.
 */
export interface CascadeOrigin {
  automationId: string;
  runId: string;
  depth: number;
  chain: string[];
  rootEventId: string;
}

// ---------------------------------------------------------------------------------------------
// Queue messages

export interface RecordEventChange {
  object: string;
  id: string;
  action: RecordEventType;
  /** Updates: changed fields only, before → after (values capped to keep messages small). */
  diff?: FieldDiff;
}

/** One operation's committed record changes (a chunk of them, for bulk operations). */
export interface RecordEventMessage {
  v: 1;
  kind: "record";
  /** `<auditId>:<chunk>`: stable across redelivery, the base of run idempotency keys. */
  id: string;
  at: string;
  origin: EventOrigin;
  changes: RecordEventChange[];
}

/** A pending action was decided (approved, rejected, failed on apply, or expired). */
export interface ApprovalDecidedMessage {
  v: 1;
  kind: "approval";
  /** `<actionId>:<decision>` */
  id: string;
  at: string;
  actionId: string;
  changeSetId: string;
  operation: string;
  decision: "approved" | "rejected" | "failed" | "expired";
  decidedBy: string | null;
  records: { object: string; id: string }[];
  /** The origin the action was queued with: `runId` set when an automation run is waiting on it. */
  actionOrigin: Origin;
  origin: EventOrigin;
}

/**
 * Stage 6b: inbound webhooks and sync events. Stage 6a stores them in `core_integration_event`
 * (migration 0110: source webhook | sync, connection_id, type, payload; read through
 * core_integration_event_unconsumed_idx, then `consumed_at` is set). 6b turns each unconsumed row
 * into this message (id = the row id) and hands it to the same dispatcher the queue consumer
 * uses, with a TriggerSource for kind `integration`. Declared here so dispatch is exhaustive; no
 * source handles it in stage 5.
 */
export interface IntegrationEventMessage {
  v: 1;
  kind: "integration";
  id: string;
  at: string;
  /** e.g. `webhook`, `sync`. */
  source: string;
  /** Connection / gatekeeper id. */
  connectionId: string;
  eventType: string;
  payload: unknown;
  origin: EventOrigin;
}

export type AutomationQueueMessage =
  | RecordEventMessage
  | ApprovalDecidedMessage
  | IntegrationEventMessage;

/**
 * Where the pipeline sends post-commit events. crm-app and crm-runner pass a Queue producer
 * (`queueEventSink(env.AUTOMATION_EVENTS)`); absent, no events are emitted (tests, scripts).
 * Implementations batch: one `send` call per operation, at most QUEUE_BATCH_MESSAGES per
 * sendBatch. `delaySeconds` debounces `updated` events.
 */
export interface EventSink {
  send(messages: AutomationQueueMessage[], options?: { delaySeconds?: number }): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Trigger sources

/** An enabled automation as the consumer matches it (a core_automations row, parsed). */
export interface AutomationDefinition {
  /** `<extensionId>.<key>` */
  id: string;
  extensionId: string;
  key: string;
  commit: string | null;
  spec: AutomationManifest;
}

/** One run a source wants started. */
export interface RunCandidate {
  automation: AutomationDefinition;
  /** Idempotency key: the Workflow instance id is derived from it (workflowInstanceId). */
  idempotencyKey: string;
  /** The trigger record, when there is one. */
  record?: { object: string; id: string };
  change?: { action: RecordEventType; diff: FieldDiff };
  approval?: {
    actionId: string;
    operation: string;
    decision: "approved" | "rejected";
    records: { object: string; id: string }[];
  };
  period?: string;
  /** Delay before the run starts (debounce), seconds. */
  delaySeconds?: number;
}

/**
 * Turns one queue message into run candidates. One source per message kind; stage 6b registers
 * `integration` (trigger types `webhook` and `syncEvent`). Matching is pure over the message and
 * the enabled automations; conditions and rails are applied by the consumer afterwards.
 */
export interface TriggerSource<M extends AutomationQueueMessage = AutomationQueueMessage> {
  kind: M["kind"];
  /** Trigger types this source fires (e.g. `record`, `fieldChanged`). */
  triggerTypes: readonly string[];
  match(message: M, automations: readonly AutomationDefinition[]): RunCandidate[];
}

// ---------------------------------------------------------------------------------------------
// Runs

export const RUN_STATUSES = [
  /** Row written, Workflow not yet running. */
  "queued",
  "running",
  /** In a step.sleep or step.waitForEvent. */
  "waiting",
  /** Paused on a pending action (review) until a person decides. */
  "review",
  "completed",
  "failed",
  /** Stopped: rejected (onRejected stop), cancelled by a person, or the kill switch. */
  "cancelled",
  /** Its pending action expired. */
  "expired",
  /** Not started: a rail dropped it (depth, cycle, budget, rate, paused, kill switch). */
  "skipped",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "expired",
  "skipped",
];

export interface RunOperationRecord {
  operation: string;
  ok: boolean;
  /** auto | review | deny (test mode: what the gate would decide). */
  gate?: string;
  code?: string;
  pendingActionId?: string;
  /** Records it created / changed, when known. */
  records?: { object: string; id: string; action: string }[];
  /** Flagged when a write was not declared in the step's intents (still gated). */
  undeclared?: boolean;
  ms: number;
}

/** One step in core_automation_runs.steps (JSON array, in order). */
export interface RunStepRecord {
  name: string;
  kind: "do" | "sleep" | "waitForEvent";
  status: "running" | "completed" | "failed" | "waiting" | "review" | "skipped";
  startedAt: string;
  ms?: number;
  attempts?: number;
  operations: RunOperationRecord[];
  logs: { level: string; message: string; at: string }[];
  /** sleep / waitForEvent: when it resumes. */
  until?: string;
  pendingActionIds?: string[];
  error?: { code: string; message: string };
}

/** A notification a test run would send. */
export interface TestNotification {
  to: string[];
  toNames: string[];
  type: string;
  title: string;
}

/** What `automation.test` reports (test mode, ADR 0028: nothing is written). */
export interface AutomationTestReport {
  automationId: string;
  record: { object: string; id: string; title: string | null } | null;
  /** Did the trigger and conditions match this record? */
  matched: boolean;
  matchReason: string;
  steps: (AutomationTestStep & { operations: RunOperationRecord[]; logs: string[] })[];
  /** Records it would create / change (simulated: provisional ids). */
  writes: { object: string; id: string; action: string; title: string | null }[];
  notifications: TestNotification[];
  /** Operations that would need approval under the current policy. */
  approvals: { operation: string; reason: string; bulkSize: number }[];
  policyPreset: string;
  ok: boolean;
  error?: { code: string; message: string };
}

// ---------------------------------------------------------------------------------------------
// The automation host: crm-runner RPC used by automation.* operations (and the UI through them)

export interface StartRunInput {
  automationId: string;
  trigger: "manual";
  userId: string;
  recordIds: string[];
  object: string;
}

export interface AutomationHost {
  /** Test mode: a dry run of `automationId` on a record through the simulation overlay. */
  testAutomation(input: {
    automationId: string;
    record?: { object: string; id: string };
    userId: string;
  }): Promise<AutomationTestReport>;
  /** Manual trigger: starts one run per record (rails apply). Returns the run ids. */
  startManualRun(input: StartRunInput): Promise<{ runIds: string[]; skipped: number }>;
  /** Restarts a failed run from its failed step (Workflow restart). */
  retryRun(runId: string): Promise<{ runId: string }>;
  /** Starts a new run with the same trigger against current data. */
  replayRun(runId: string): Promise<{ runId: string }>;
  /** Cancels a running or waiting run (terminates its Workflow). */
  cancelRun(runId: string): Promise<{ runId: string }>;
}

/** Workflow instance ids: at most 100 chars of [a-zA-Z0-9_-] (Workflows docs). */
export async function workflowInstanceId(automationId: string, key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${automationId}\n${key}`),
  );
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `run-${hex.slice(0, 48)}`;
}
