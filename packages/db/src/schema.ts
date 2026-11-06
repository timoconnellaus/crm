// Typed access to core tables. Keep in step with ../migrations: a migration that changes a core
// table updates the matching interface here in the same commit.
import type { ColumnType, Generated } from "kysely";

/** SQLite stores dates as ISO-8601 text; Better Auth writes them, we read them back as strings. */
type DateColumn = ColumnType<string, string | Date, string | Date>;
/** SQLite has no boolean type: 0 or 1. */
type BoolColumn = ColumnType<number, number | boolean, number | boolean>;

export interface CoreMetaTable {
  key: string;
  value: string;
}

export interface CoreMigrationsTable {
  id: Generated<number>;
  name: string;
  applied_at: Generated<string>;
}

export interface CoreUserTable {
  id: string;
  name: string;
  email: string;
  email_verified: BoolColumn;
  image: string | null;
  created_at: DateColumn;
  updated_at: DateColumn;
  /** CRM role (migration 0002). Defaults to member; the first user becomes admin. */
  role: ColumnType<UserRole, UserRole | undefined, UserRole>;
  /** `extension` rows are extension principals (migration 0020); they never sign in. */
  kind: ColumnType<UserKind, UserKind | undefined, UserKind>;
  /** Migration 0170: a deactivated person cannot sign in or act. */
  deactivated_at: ColumnType<string | null, string | null | undefined, string | null>;
  /** Migration 0221 (ADR 0212): set on a support user, the grant it was created for. */
  support_grant_id: ColumnType<string | null, string | null | undefined, string | null>;
}

export type UserKind = "human" | "extension";

export interface CoreSessionTable {
  id: string;
  user_id: string;
  token: string;
  expires_at: DateColumn;
  ip_address: string | null;
  user_agent: string | null;
  created_at: DateColumn;
  updated_at: DateColumn;
}

export interface CoreAccountTable {
  id: string;
  user_id: string;
  account_id: string;
  provider_id: string;
  access_token: string | null;
  refresh_token: string | null;
  id_token: string | null;
  access_token_expires_at: DateColumn | null;
  refresh_token_expires_at: DateColumn | null;
  scope: string | null;
  password: string | null;
  created_at: DateColumn;
  updated_at: DateColumn;
}

export interface CoreVerificationTable {
  id: string;
  identifier: string;
  value: string;
  expires_at: DateColumn;
  created_at: DateColumn;
  updated_at: DateColumn;
}

// --- Stage 1 (migrations 0002-0007) ------------------------------------------------------------

export type UserRole = "admin" | "member" | "viewer";
export type ActivityType = "note" | "email" | "call" | "meeting" | "system";
export type ActivityAuthorActor = "human" | "assistant" | "mcp" | "automation" | "system";
export type TaskStatus = "open" | "done";
export type AuditActor = "human" | "assistant" | "mcp" | "automation" | "extension";
export type AuditRisk =
  | "read"
  | "write"
  | "bulk-write"
  | "destructive"
  | "schema"
  | "extension"
  | "outbound";
export type AuditGateDecision = "auto" | "review" | "deny";
export type AuditOutcome = "ok" | "forbidden" | "denied" | "review" | "error";
export type AuditChangeAction = "create" | "update" | "delete" | "restore" | "erase" | "merge";

/** ISO-8601 UTC timestamp text written by the operation layer. */
type Timestamp = string;
/** A JSON document stored as text. */
type JsonText = string;
/** A column with a database default (or nullable): optional on insert. */
type Defaulted<T> = ColumnType<T, T | undefined, T>;

export interface CoreSettingsTable {
  key: string;
  value: JsonText;
  updated_at: Timestamp;
  updated_by: string | null;
}

/** Columns every soft-deletable core record shares. */
interface RecordColumns {
  id: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  deleted_at: Defaulted<Timestamp | null>;
  deleted_by: Defaulted<string | null>;
}

export interface CorePersonTable extends RecordColumns {
  given_name: Defaulted<string | null>;
  family_name: Defaulted<string | null>;
  display_name: string;
  location: Defaulted<string | null>;
  timezone: Defaulted<string | null>;
  /** JSON array of `{ network, url, handle? }`. */
  social_profiles: Defaulted<JsonText>;
  avatar_key: Defaulted<string | null>;
  owner_id: Defaulted<string | null>;
  description: Defaulted<string | null>;
  created_by: Defaulted<string | null>;
  merged_into_id: Defaulted<string | null>;
  /**
   * Normalised display name for duplicate rules (stage 16, ADR 0247). Required on insert, so every
   * writer sets it; null for a name that has nothing to compare (an email standing in for one).
   */
  name_key: ColumnType<string | null, string | null, string | null>;
}

export interface CorePersonEmailsTable {
  id: string;
  person_id: string;
  email: string;
  label: Defaulted<string | null>;
  is_primary: Defaulted<number>;
  position: Defaulted<number>;
  /** Maintained by triggers from the person's deleted_at; never written by operations. */
  live: Defaulted<number>;
  created_at: Timestamp;
}

export interface CorePersonPhonesTable {
  id: string;
  person_id: string;
  number: string;
  number_normalised: string;
  label: Defaulted<string | null>;
  is_primary: Defaulted<number>;
  position: Defaulted<number>;
  created_at: Timestamp;
}

export interface CoreOrganisationTable extends RecordColumns {
  name: string;
  website: Defaulted<string | null>;
  industry: Defaulted<string | null>;
  parent_id: Defaulted<string | null>;
  avatar_key: Defaulted<string | null>;
  owner_id: Defaulted<string | null>;
  description: Defaulted<string | null>;
  created_by: Defaulted<string | null>;
  merged_into_id: Defaulted<string | null>;
  /** Normalised name for duplicate rules (stage 16, ADR 0247). Required on insert. */
  name_key: ColumnType<string | null, string | null, string | null>;
}

/** A likely duplicate pair found by the scan (stage 16, ADR 0247). a_id < b_id. */
export interface CoreDuplicatePairTable {
  object: "person" | "organisation";
  a_id: string;
  b_id: string;
  /** JSON array of rule ids. */
  rules: JsonText;
  /** JSON object: what each rule matched (organisation, domain, number). */
  details: Defaulted<JsonText>;
  status: Defaulted<"open" | "dismissed" | "merged">;
  created_at: Timestamp;
  updated_at: Timestamp;
  decided_at: Defaulted<Timestamp | null>;
  decided_by: Defaulted<string | null>;
}

export interface CoreOrganisationDomainsTable {
  id: string;
  organisation_id: string;
  domain: string;
  is_primary: Defaulted<number>;
  position: Defaulted<number>;
  /** Maintained by triggers from the organisation's deleted_at; never written by operations. */
  live: Defaulted<number>;
  created_at: Timestamp;
}

export interface CoreOrganisationAddressesTable {
  id: string;
  organisation_id: string;
  label: Defaulted<string | null>;
  line1: Defaulted<string | null>;
  line2: Defaulted<string | null>;
  city: Defaulted<string | null>;
  region: Defaulted<string | null>;
  postal_code: Defaulted<string | null>;
  country: Defaulted<string | null>;
  is_primary: Defaulted<number>;
  position: Defaulted<number>;
  created_at: Timestamp;
}

export interface CoreAffiliationTable extends RecordColumns {
  person_id: string;
  organisation_id: string;
  title: Defaulted<string | null>;
  role: Defaulted<string | null>;
  started_on: Defaulted<string | null>;
  ended_on: Defaulted<string | null>;
  is_current: Defaulted<number>;
  is_primary: Defaulted<number>;
  created_by: Defaulted<string | null>;
}

export interface CoreTagsTable {
  id: string;
  name: string;
  color: Defaulted<string | null>;
  created_at: Timestamp;
  created_by: Defaulted<string | null>;
}

export interface CoreRecordTagsTable {
  tag_id: string;
  object_type: string;
  record_id: string;
  created_at: Timestamp;
}

export interface CoreActivityTable extends RecordColumns {
  type: ActivityType;
  subject: Defaulted<string | null>;
  body: Defaulted<string | null>;
  payload: Defaulted<JsonText>;
  occurred_at: Timestamp;
  author_user_id: Defaulted<string | null>;
  author_actor: Defaulted<ActivityAuthorActor>;
  /** Migration 0111: 'email:<Message-ID>' or 'ical:<UID>' for synced activities (unique). */
  external_key: Defaulted<string | null>;
  /** Migration 0111: 'thread:<root Message-ID>' for synced email. */
  thread_key: Defaulted<string | null>;
  /** Migration 0111: set when marked private; only this user sees it. */
  private_to: Defaulted<string | null>;
  /** Migration 0111: R2 key of the full email body. */
  body_ref: Defaulted<string | null>;
  /** Migration 0111: what a synced activity discloses. */
  disclosure: Defaulted<"full" | "metadata" | null>;
}

export interface CoreActivityLinksTable {
  activity_id: string;
  object_type: string;
  record_id: string;
}

export interface CoreTaskTable extends RecordColumns {
  title: string;
  notes: Defaulted<string | null>;
  due_at: Defaulted<string | null>;
  status: Defaulted<TaskStatus>;
  completed_at: Defaulted<Timestamp | null>;
  completed_by: Defaulted<string | null>;
  assignee_id: Defaulted<string | null>;
  created_by: Defaulted<string | null>;
}

export interface CoreTaskLinksTable {
  task_id: string;
  object_type: string;
  record_id: string;
}

export interface CoreViewsTable {
  id: string;
  user_id: string;
  object: string;
  name: string;
  /** JSON `{ type: "table", object, filter, sort, columns }`. */
  spec: JsonText;
  position: Defaulted<number>;
  /** 1: shared with the org (members view it; admins and the owner edit it). */
  shared: Defaulted<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** Dashboards (migration 0080, ADR 0056): a dashboard spec owned by a user, optionally shared. */
export interface CoreDashboardsTable {
  id: string;
  owner_id: string;
  title: string;
  description: string | null;
  shared: Defaulted<number>;
  /** JSON dashboard spec: filters, widgets and their layout. */
  spec: JsonText;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** Each user's Home dashboard (migration 0080). No row: the shipped Overview. */
export interface CoreUserHomeTable {
  user_id: string;
  dashboard_id: string;
  updated_at: Timestamp;
}

/** Typed extension settings (migration 0080, ADR 0058). */
export interface CoreExtensionSettingsTable {
  extension_id: string;
  value: JsonText;
  updated_at: Timestamp;
  updated_by: string | null;
}

export interface CoreAuditTable {
  id: string;
  at: Timestamp;
  operation: string;
  risk: AuditRisk;
  actor: AuditActor;
  user_id: string | null;
  origin: JsonText;
  input: JsonText;
  result: JsonText | null;
  gate_decision: AuditGateDecision;
  outcome: AuditOutcome;
  error: JsonText | null;
  /** The pending action this row queued (outcome review) or applied (migration 0010). */
  pending_action_id: Defaulted<string | null>;
}

export interface CoreAuditChangesTable {
  id: Generated<number>;
  audit_id: string;
  object_type: string;
  record_id: string;
  action: AuditChangeAction;
  /** JSON `{ "<field>": { before, after } }`. */
  diff: JsonText;
  at: Timestamp;
}

/**
 * A sanctioned redaction of one audit row or field-change row (migration 0008, ADR 0019).
 * Append-only. Inserting one applies the canonical "[erased]" redaction to its target by trigger.
 */
export interface CoreAuditRedactionsTable {
  id: Generated<number>;
  audit_id: string | null;
  change_id: number | null;
  object_type: string;
  record_id: string;
  operation: string;
  user_id: string | null;
  at: Timestamp;
}

export interface CoreSearchDocsTable {
  id: Generated<number>;
  object_type: string;
  record_id: string;
  title: string;
  body: string;
}

/** The FTS5 index over core_search_docs. Query with `MATCH`; join back on `rowid = docs.id`. */
export interface CoreSearchTable {
  rowid: number;
  title: string;
  body: string;
  rank: number;
}

// --- crm_* read views (migration 0007). Read-only: never write to these. ----------------------

export interface CrmUsersView {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  image: string | null;
  created_at: string;
}

export interface CrmPeopleView {
  id: string;
  display_name: string;
  given_name: string | null;
  family_name: string | null;
  primary_email: string | null;
  /** JSON array of strings. */
  emails: JsonText;
  primary_phone: string | null;
  primary_affiliation_id: string | null;
  job_title: string | null;
  organisation_id: string | null;
  organisation_name: string | null;
  location: string | null;
  timezone: string | null;
  owner_id: string | null;
  avatar_key: string | null;
  /** JSON array of tag names. */
  tags: JsonText;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CrmOrganisationsView {
  id: string;
  name: string;
  primary_domain: string | null;
  /** JSON array of strings. */
  domains: JsonText;
  website: string | null;
  industry: string | null;
  parent_id: string | null;
  parent_name: string | null;
  owner_id: string | null;
  avatar_key: string | null;
  current_people_count: number;
  /** JSON array of tag names. */
  tags: JsonText;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CrmAffiliationsView {
  id: string;
  person_id: string;
  organisation_id: string;
  title: string | null;
  role: string | null;
  started_on: string | null;
  ended_on: string | null;
  is_current: number;
  is_primary: number;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CrmActivitiesView {
  id: string;
  type: ActivityType;
  subject: string | null;
  body: string | null;
  payload: JsonText;
  occurred_at: Timestamp;
  author_user_id: string | null;
  author_actor: ActivityAuthorActor;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CrmActivityLinksView {
  activity_id: string;
  object_type: string;
  record_id: string;
}

export interface CrmTasksView {
  id: string;
  title: string;
  notes: string | null;
  due_at: string | null;
  status: TaskStatus;
  completed_at: Timestamp | null;
  assignee_id: string | null;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CrmTaskLinksView {
  task_id: string;
  object_type: string;
  record_id: string;
}

export interface CrmRecordTagsView {
  object_type: string;
  record_id: string;
  tag_id: string;
  tag: string;
}

export type ExtensionSource = "shipped" | "runtime";
export type ExtensionStatus = "active" | "disabled" | "quarantined";

/** Installed extensions (migration 0020). */
export interface CoreExtensionsTable {
  id: string;
  source: ExtensionSource;
  status: ExtensionStatus;
  status_reason: string | null;
  version: string;
  commit_oid: string;
  last_good_commit: string | null;
  manifest: string;
  failure_count: ColumnType<number, number | undefined, number>;
  user_id: string;
  installed_at: string;
  installed_by: string | null;
  updated_at: string;
}

export interface CoreExtensionVersionsTable {
  extension_id: string;
  commit_oid: string;
  version: string;
  manifest: string;
  installed_at: string;
  installed_by: string | null;
}

export interface CoreExtensionRunsTable {
  id: string;
  extension_id: string;
  commit_oid: string | null;
  kind: "tool" | "manifest" | "automation";
  name: string | null;
  actor: string | null;
  user_id: string | null;
  started_at: string;
  duration_ms: number;
  outcome: "ok" | "error" | "timeout";
  error: string | null;
  logs: ColumnType<string, string | undefined, string>;
  operations: ColumnType<string, string | undefined, string>;
}

/** Migration 0130 (ADR 0130): an installed extension's automation. */
export interface CoreAutomationsTable {
  id: string;
  extension_id: string;
  key: string;
  label: string;
  trigger_type: string;
  trigger_object: string | null;
  spec: string;
  commit_oid: string | null;
  enabled: ColumnType<number, number | undefined, number>;
  paused_reason: string | null;
  paused_at: string | null;
  removed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type AutomationRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "review"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired"
  | "skipped";

/** Migration 0130: one automation run (or test run). */
export interface CoreAutomationRunsTable {
  id: string;
  automation_id: string;
  extension_id: string;
  commit_oid: string | null;
  workflow_id: string | null;
  trigger: string;
  record_object: string | null;
  record_id: string | null;
  status: AutomationRunStatus;
  status_reason: string | null;
  test: ColumnType<number, number | undefined, number>;
  depth: ColumnType<number, number | undefined, number>;
  root_event_id: string | null;
  steps: ColumnType<string, string | undefined, string>;
  writes: ColumnType<number, number | undefined, number>;
  change_set_id: string | null;
  wait_until: string | null;
  retry_of: string | null;
  replay_of: string | null;
  report: string | null;
  error: string | null;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
}

/** Migration 0130: records an automation run touched. */
export interface CoreAutomationRunRecordsTable {
  object_type: string;
  record_id: string;
  run_id: string;
  role: string;
  at: string;
}

/** Migration 0130: per-automation run and write counts per UTC hour (rails). */
export interface CoreAutomationCountersTable {
  automation_id: string;
  hour: string;
  runs: ColumnType<number, number | undefined, number>;
  writes: ColumnType<number, number | undefined, number>;
}

/** Migration 0131 (ADR 0132): the in-app notification centre. */
export interface CoreNotificationsTable {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  source: ColumnType<string, string | undefined, string>;
  dedupe_key: string | null;
  read_at: string | null;
  created_at: string;
}

/** Migration 0170 (ADR 0170): a person's consent that an automation uses a connection. */
export interface CoreAutomationBindingTable {
  automation_id: string;
  slot: string;
  gatekeeper: string;
  purpose: string;
  connection_id: string;
  bound_by: string;
  bound_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
  revoke_reason: string | null;
}

/** Migration 0171 (ADR 0171): automation events written with the change, sent after commit. */
export interface CoreAutomationOutboxTable {
  id: string;
  messages: string;
  attempts: ColumnType<number, number | undefined, number>;
  next_at: string;
  last_error: string | null;
  created_at: string;
}

/** Migration 0172 (ADR 0172): a person's notification channels per type and the digest. */
export interface CoreNotificationPreferenceTable {
  user_id: string;
  channels: ColumnType<string, string | undefined, string>;
  digest: ColumnType<number, number | undefined, number>;
  /** Migration 0210 (ADR 0206): the in-app daily digest, on by default. */
  digest_in_app: ColumnType<number, number | undefined, number>;
  updated_at: string;
}

/** Migration 0200: the in-app assistant's conversation list (ADR 0200). */
export interface CoreAssistantConversationTable {
  id: string;
  user_id: string;
  title: string;
  context: string | null;
  turns: ColumnType<number, number | undefined, number>;
  preview: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: ColumnType<string | null, string | null | undefined, string | null>;
}

/**
 * Migration 0270 (ADR 0019 / ADR 0200 amendments): the people and organisations (`per_…`,
 * `org_…`) and email addresses (`email:<sha256>`) an assistant conversation referenced, so an
 * erase can find the conversations to scrub.
 */
export interface CoreAssistantConversationRefsTable {
  conversation_id: string;
  ref: string;
}

/**
 * Migration 0350 (ADR 0340): one assistant thread per user. The thread itself lives in the
 * user's AssistantAgent Durable Object; this row is its bookkeeping (turns, unread, preview).
 */
export interface CoreAssistantThreadTable {
  id: string;
  user_id: string;
  turns: ColumnType<number, number | undefined, number>;
  unread: ColumnType<number, number | undefined, number>;
  preview: string | null;
  compaction: string | null;
  last_activity_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Migration 0350 (ADR 0340, ADR 0019 amendment): the people, organisations and email hashes a
 * thread referenced, so an erase can find the threads to scrub.
 */
export interface CoreAssistantThreadRefsTable {
  thread_id: string;
  ref: string;
}

/** Migration 0352 (ADR 0342): what each person's assistant remembers, and team lines. */
export interface CoreMemoryTable {
  id: string;
  /** The owner; null for team lines. */
  user_id: string | null;
  kind: "personal" | "shortcut" | "style" | "conditional" | "team";
  text: string;
  /** JSON `{ object, filter }` for conditional lines. */
  condition: string | null;
  condition_label: string | null;
  status: "active" | "proposed" | "paused";
  source_thread_id: string | null;
  source_message_seq: number | null;
  /** JSON: what checked the line before it was saved. */
  checked: string | null;
  author_id: string | null;
  /** JSON: team lines' changes, oldest first. */
  history: string | null;
  active_since: string | null;
  created_at: string;
  updated_at: string;
}

/** Migration 0352 (ADR 0342): the people, organisations and email hashes a memory line names. */
export interface CoreMemoryRefsTable {
  memory_id: string;
  ref: string;
}

/** Migration 0352 (ADR 0342): memory paused per person (no row: on). */
export interface CoreMemorySettingsTable {
  user_id: string;
  paused: ColumnType<number, number | undefined, number>;
  updated_at: string;
}

/**
 * Migration 0330 (ADR 0320): erased people's addresses, as `sha256:<hex>` of the lower-cased
 * address (never the address), so sync does not collect them again.
 */
export interface CoreErasedAddressTable {
  hash: string;
  object_type: "person" | "organisation";
  erased_at: string;
  erased_by: string | null;
}

/** Migration 0330 (ADR 0320): R2 objects to delete after a commit, drained with retries. */
export interface CoreBlobDeletionTable {
  key: string;
  queued_at: string;
  attempts: ColumnType<number, number | undefined, number>;
  last_error: string | null;
}

/**
 * Migration 0172: one external delivery (email / Slack), keyed for exactly-once sending. Migration
 * 0210 (ADR 0206) adds `inApp` for a daily digest that went to the app only.
 */
export interface CoreNotificationDeliveryTable {
  key: string;
  kind: "notification" | "escalation" | "digest" | "route";
  channel: "email" | "slack" | "inApp";
  user_id: string | null;
  status: "sending" | "sent" | "pending" | "failed" | "skipped";
  detail: string | null;
  created_at: string;
}

export interface CoreExtensionKvTable {
  extension_id: string;
  key: string;
  value: string;
  updated_at: string;
}

/** Migration 0030: what a reviewer sees for an extension proposal (ADR 0041). */
export interface CoreExtensionProposalsTable {
  action_id: string;
  extension_id: string;
  commit_oid: string;
  base_commit: string | null;
  source: "shipped" | "runtime";
  version: string;
  message: string;
  diff: string;
  impact: string;
  check_result: string;
  ai_summary: string | null;
  ai_model: string | null;
  /** Migration 0250 (ADR 0230): the authoring.intent check, JSON, or null when none ran. */
  intent_check: string | null;
  created_by: string;
  created_at: string;
}

export type ExtensionSchemaStatus = "active" | "hidden";

export interface CoreExtensionObjectsTable {
  name: string;
  extension_id: string;
  local_name: string;
  table_name: string;
  status: ExtensionSchemaStatus;
  hidden_at: string | null;
  definition: string;
  created_at: string;
  updated_at: string;
}

export interface CoreExtensionFieldsTable {
  id: Generated<number>;
  extension_id: string;
  object: string;
  local_name: string;
  name: string;
  table_name: string;
  column_name: string | null;
  type: string;
  definition: string;
  status: ExtensionSchemaStatus;
  hidden_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Every core table and crm_* view, keyed by name. Extension (`x_*`) tables are never listed here.
 */
export type ChangeSetState = "open" | "committed" | "closed";
export type PendingActionStatus =
  | "pending"
  | "applied"
  | "failed"
  | "skipped"
  | "rejected"
  | "expired";

/** A group of pending actions reviewed together (migration 0010, ADR 0022). */
export interface CoreChangeSetTable {
  id: string;
  title: string | null;
  session_id: string | null;
  client_id: string | null;
  client_name: string | null;
  user_id: string;
  actor: AuditActor;
  origin: JsonText;
  explicit: Defaulted<number>;
  state: Defaulted<ChangeSetState>;
  created_at: Timestamp;
  updated_at: Timestamp;
  committed_at: Defaulted<Timestamp | null>;
  closed_at: Defaulted<Timestamp | null>;
}

/** One queued operation call (migration 0010). */
export interface CorePendingActionTable {
  id: string;
  change_set_id: string;
  operation: string;
  risk: AuditRisk;
  input: JsonText;
  reason: string;
  actor: AuditActor;
  user_id: string;
  origin: JsonText;
  granted_permissions: JsonText | null;
  bulk_size: Defaulted<number>;
  preview: JsonText;
  simulated: JsonText;
  provisional: Defaulted<JsonText>;
  depends_on: Defaulted<JsonText>;
  status: Defaulted<PendingActionStatus>;
  status_reason: Defaulted<string | null>;
  error: Defaulted<JsonText | null>;
  bindings: Defaulted<JsonText | null>;
  result: Defaulted<JsonText | null>;
  request_audit_id: Defaulted<string | null>;
  applied_audit_id: Defaulted<string | null>;
  decided_by: Defaulted<string | null>;
  decided_at: Defaulted<Timestamp | null>;
  created_at: Timestamp;
  expires_at: Timestamp;
  /** Migration 0063: set when input, preview and simulated were dropped for `summary`. */
  compacted_at: Defaulted<Timestamp | null>;
  summary: Defaulted<JsonText | null>;
  /** Migration 0110: outbound items (ADR 0051): the connection, facet and gatekeeper action. */
  connection_id: Defaulted<string | null>;
  facet_key: Defaulted<string | null>;
  gk_action: Defaulted<number | null>;
  action_kind: Defaulted<string | null>;
  /** Migration 0205 (ADR 0204): why the gate routed it to review; null: never auto-approved. */
  review_source: Defaulted<ReviewSource | null>;
  /** Migration 0256 (ADR 0238): the judge's check of an outbound message (outbound.message). */
  outbound_check: Defaulted<string | null>;
}

export interface CorePendingActionRecordsTable {
  action_id: string;
  object_type: string;
  record_id: string;
  action: string;
}

/** An OAuth authorization a user gave an MCP client (migration 0011). */
export interface CoreConnectedAppTable {
  id: string;
  user_id: string;
  client_id: string;
  client_name: string;
  client_uri: Defaulted<string | null>;
  redirect_host: Defaulted<string | null>;
  /** JSON array of scopes. */
  scopes: JsonText;
  grant_id: Defaulted<string | null>;
  created_at: Timestamp;
  last_used_at: Defaulted<Timestamp | null>;
  revoked_at: Defaulted<Timestamp | null>;
  revoked_by: Defaulted<string | null>;
  revoke_reason: Defaulted<string | null>;
}

/** Hourly counts of successful non-human reads (migration 0060, ADR 0090). */
export interface CoreAuditReadCountsTable {
  hour: string;
  actor: AuditActor;
  user_id: string;
  caller: Defaulted<string>;
  operation: string;
  count: Defaulted<number>;
  simulated: Defaulted<number>;
  first_at: Timestamp;
  last_at: Timestamp;
}

/** Append-only markers that authorise an audit retention purge (migration 0061, ADR 0090). */
export interface CoreAuditPurgesTable {
  id: Generated<number>;
  cutoff: Timestamp;
  retention_years: number;
  audit_id: string | null;
  user_id: string | null;
  at: Timestamp;
}

/** The storage gauge's cached measurement, one row (migration 0065). */
export interface CoreStorageStatsTable {
  id: number;
  size_bytes: number | null;
  tables: JsonText;
  measured_at: Timestamp;
}

// --- Stage 6a: integrations (migrations 0110-0112) -----------------------------------------------

export type ConnectionScope = "personal" | "org";
export type SharingLevel = "full" | "metadata" | "none";
export type ConnectionStatus = "connecting" | "active" | "expired" | "error" | "disconnected";

/** Gatekeepers an admin enabled (migration 0110). */
export interface CoreIntegrationVendorTable {
  vendor: string;
  enabled: Defaulted<number>;
  mode: Defaulted<"off" | "optional" | "on" | null>;
  updated_at: Timestamp;
  updated_by: Defaulted<string | null>;
}

/** The UI's mirror of a connection; its integration host DO is the authority (migration 0110). */
export interface CoreIntegrationConnectionTable {
  id: string;
  vendor: string;
  scope: ConnectionScope;
  owner_user_id: string;
  title: string;
  account_label: Defaulted<string | null>;
  sharing_level: Defaulted<SharingLevel>;
  status: Defaulted<ConnectionStatus>;
  error: Defaulted<string | null>;
  resources: Defaulted<JsonText>;
  sync: Defaulted<JsonText>;
  created_at: Timestamp;
  updated_at: Timestamp;
  connected_at: Defaulted<Timestamp | null>;
  disconnected_at: Defaulted<Timestamp | null>;
  last_sync_at: Defaulted<Timestamp | null>;
}

/** Outbound action kinds and their auto-approval (migration 0110, ADR 0051). */
export interface CoreOutboundKindTable {
  tag: string;
  vendor: string;
  label: string;
  auto_approvable: Defaulted<number>;
  auto_approve: Defaulted<number>;
  first_seen_at: Timestamp;
  updated_at: Timestamp;
  updated_by: Defaulted<string | null>;
}

/** Inbound webhook and sync events for stage 5 (migration 0110). */
export interface CoreIntegrationEventTable {
  id: string;
  source: "webhook" | "sync";
  connection_id: Defaulted<string | null>;
  type: string;
  external_id: Defaulted<string | null>;
  payload: JsonText;
  occurred_at: Timestamp;
  created_at: Timestamp;
  consumed_at: Defaulted<Timestamp | null>;
}

/** A message or event seen in one mailbox or calendar (migration 0111). */
export interface CoreSyncItemTable {
  connection_id: string;
  provider_id: string;
  external_key: string;
  kind: "email" | "meeting";
  activity_id: Defaulted<string | null>;
  /** Migration 0112: when the message was sent or the event starts (delete reconciliation). */
  occurred_at: Defaulted<Timestamp | null>;
  updated_at: Timestamp;
}

/** Suggested contacts (migration 0111, ADR 0052). */
export interface CoreSuggestedContactTable {
  email: string;
  domain: string;
  name: Defaulted<string | null>;
  message_count: Defaulted<number>;
  first_seen_at: Timestamp;
  last_seen_at: Timestamp;
  status: Defaulted<"open" | "added" | "dismissed">;
  person_id: Defaulted<string | null>;
  decided_by: Defaulted<string | null>;
  decided_at: Defaulted<Timestamp | null>;
}

/** Job-change suggestions from mail signals (migration 0111). */
export interface CoreJobChangeSuggestionTable {
  id: string;
  person_id: string;
  signal: "bounce" | "signature" | "domain";
  dedupe_key: string;
  evidence: JsonText;
  proposal: JsonText;
  status: Defaulted<"open" | "applied" | "dismissed">;
  created_at: Timestamp;
  decided_by: Defaulted<string | null>;
  decided_at: Defaulted<Timestamp | null>;
}

/** The last signature seen from a known person (migration 0111). */
export interface CorePersonSignatureTable {
  person_id: string;
  email: string;
  signature_hash: string;
  company: Defaulted<string | null>;
  title: Defaulted<string | null>;
  seen_at: Timestamp;
}

/** One stage a record has been in (migration 0100, ADR 0100). `left_at` is null for the current one. */
export interface CoreStageHistoryTable {
  id: string;
  object_type: string;
  record_id: string;
  stage_id: string;
  group_id: string | null;
  stage_type: "open" | "won" | "lost";
  entered_at: Timestamp;
  left_at: Timestamp | null;
  entered_by: string | null;
}

export interface CrmStageHistoryView {
  id: string;
  object_type: string;
  record_id: string;
  stage_id: string;
  group_id: string | null;
  stage_type: "open" | "won" | "lost";
  entered_at: Timestamp;
  left_at: Timestamp | null;
  is_current: number;
  days_in_stage: number;
  entered_by: string | null;
}

/** Stage 8 (migration 0160): installer choices, JSON under key 'deployment' (no secrets). */
export interface CoreInstallTable {
  key: string;
  value: JsonText;
  updated_at: Timestamp;
}

/** Stage 8 (migration 0160): every update and rollback, with its Time Travel bookmark. */
export interface CoreUpdateRunsTable {
  id: string;
  kind: "update" | "rollback";
  from_version: string | null;
  to_version: string;
  status: "running" | "succeeded" | "rolled_back" | "failed";
  step: string | null;
  bookmark: string | null;
  bundle_digest: string | null;
  preflight: JsonText | null;
  error: string | null;
  started_by: string | null;
  surface: "ui" | "cli";
  started_at: Timestamp;
  finished_at: Timestamp | null;
}

/** Stage 8 (migration 0160): public GitHub Releases per channel, cached. */
export interface CoreReleaseCacheTable {
  channel: "stable" | "beta";
  releases: JsonText;
  fetched_at: Timestamp;
}

/** Stage 8 (migration 0161): the first-run setup wizard, one row. */
export interface CoreSetupTable {
  id: number;
  status: "pending" | "in_progress" | "completed" | "skipped";
  step: string;
  data: JsonText;
  updated_at: Timestamp;
  updated_by: string | null;
  completed_at: Timestamp | null;
}

/** Stage 8 (migration 0161): records "Install sample data" created. */
export interface CoreSampleRecordsTable {
  object_type: string;
  record_id: string;
  created_at: Timestamp;
}

/** Why the gate routed a pending action to review (migration 0205, ADR 0204). */
export type ReviewSource = "policy" | "floor" | "always" | "dependency";

/** The written policy, one row per version (migration 0205, ADR 0204). */
export interface CoreWrittenPolicyTable {
  version: number;
  text: string;
  hash: string;
  created_at: Timestamp;
  created_by: string;
}

export type AdjudicationMode = "shadow" | "active";
export type AdjudicationVerdict = "approve" | "deny" | "escalate";
export type AdjudicationOutcome = "recorded" | "approved" | "apply_failed" | "escalated";

/** One policy adjudicator verdict per pending action (migration 0205, ADR 0204). */
export interface CoreAdjudicationTable {
  id: string;
  action_id: string;
  judged_at: Timestamp;
  mode: AdjudicationMode;
  verdict: AdjudicationVerdict;
  confidence: number;
  reason: string;
  outcome: AdjudicationOutcome;
  acted: Defaulted<number>;
  note: Defaulted<string | null>;
  provider: Defaulted<string | null>;
  model: Defaulted<string | null>;
  policy_version: Defaulted<number | null>;
  policy_hash: Defaulted<string | null>;
  threshold: number;
  error: Defaulted<JsonText | null>;
  audit_id: string;
  /** Migration 0251 (ADR 0233): the Jev reviewer's raw answer; NULL for the LLM reviewer. */
  judgement: Defaulted<JsonText | null>;
}

/** Cached `summarise` output (migration 0150, ADR 0153). */
export interface CoreAiSummaryTable {
  kind: "record" | "meeting" | "activity" | "changeset";
  subject_type: string;
  subject_id: string;
  input_hash: string;
  text: string;
  model: string;
  /** JSON array of the record ids the input was built from. */
  sources: string;
  created_at: string;
  created_by: string | null;
  /** Migration 0255 (ADR 0237): the judge's check of the summary (summary.statements), JSON. */
  checks: Defaulted<string | null>;
}

/** One embedded record: the hash of the embedded text (migration 0150, ADR 0154). */
export interface CoreEmbeddingTable {
  object_type: string;
  record_id: string;
  vector_id: string;
  text_hash: string;
  model: string;
  embedded_at: string;
}

/** Records whose embedding may be stale, drained in batches (migration 0150, ADR 0154). */
export interface CoreEmbeddingQueueTable {
  object_type: string;
  record_id: string;
  queued_at: string;
  attempts: Generated<number>;
}

/** Migration 0220 (ADR 0211): plan entitlements, written only by the hosted control plane. */
export interface CoreEntitlementsTable {
  key: string;
  value: string;
  updated_at: string;
}

export type SupportGrantStatus = "requested" | "approved" | "denied" | "revoked";

/** Migration 0221 (ADR 0212): a customer-approved, time-limited support grant. */
export interface CoreSupportGrantsTable {
  id: string;
  staff_email: string;
  reason: string;
  role: UserRole;
  requested_minutes: number;
  status: SupportGrantStatus;
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
  expires_at: string | null;
  user_id: string | null;
}

/**
 * Migration 0260 (ADR 0213 amendment): model usage counted in a hosted workspace, per day, role
 * and provider. `billed` is 1 for Platform AI, 0 for the customer's own key.
 */
export interface CoreAiUsageTable {
  day: string;
  role: string;
  provider: string;
  billed: number;
  requests: number;
  tokens_in: number;
  tokens_out: number;
}

/** Migration 0358 (ADR 0341): one row per assistant model response, for review. Kept 180 days. */
export interface CoreAiCacheObservationTable {
  id: Generated<number>;
  at: string;
  provider: string;
  model: string;
  role: string;
  gap_seconds: number;
  prefix_unchanged: number;
  cached_tokens: number;
  prompt_tokens: number;
  prefix_tokens: number | null;
}

/** Migration 0359 (ADR 0341): one row per compaction planner run, actual cost filled in later. */
export interface CoreAiCompactionDecisionTable {
  id: string;
  at: string;
  provider: string;
  model: string;
  role: string;
  decision: "compact" | "continue";
  rule: string;
  /** JSON: the planner's input, verbatim. */
  input: string;
  /** JSON: the planner's result. */
  result: string;
  actual_turns: number | null;
  actual_cost: number | null;
  actual_at: string | null;
}

/** Migration 0360 (ADR 0341): the learned cache lifetime per provider and model. */
export interface CoreAiCacheEstimateTable {
  provider: string;
  model: string;
  /** JSON: the learner's state. */
  state: string;
  learned_seconds: number | null;
  published_seconds: number | null;
  confidence: number | null;
  sample_size: number;
  version: number;
  updated_at: string;
}

/** Migration 0360: each change of a learned estimate. */
export interface CoreAiCacheEstimateHistoryTable {
  id: Generated<number>;
  provider: string;
  model: string;
  at: string;
  from_seconds: number | null;
  to_seconds: number | null;
  reason: "rise" | "fall";
  sample_size: number;
}

/**
 * Migration 0252 (ADR 0234): judge calls and input tokens per day and placement, counted by a
 * statement in the batch a placement already writes.
 */
export interface CoreJudgeUsageTable {
  day: string;
  placement: string;
  calls: number;
  input_tokens: number;
}

export interface CoreDatabase {
  core_ai_usage: CoreAiUsageTable;
  core_ai_cache_observation: CoreAiCacheObservationTable;
  core_ai_compaction_decision: CoreAiCompactionDecisionTable;
  core_ai_cache_estimate: CoreAiCacheEstimateTable;
  core_ai_cache_estimate_history: CoreAiCacheEstimateHistoryTable;
  core_judge_usage: CoreJudgeUsageTable;
  core_entitlements: CoreEntitlementsTable;
  core_support_grants: CoreSupportGrantsTable;
  core_install: CoreInstallTable;
  core_update_runs: CoreUpdateRunsTable;
  core_release_cache: CoreReleaseCacheTable;
  core_setup: CoreSetupTable;
  core_sample_records: CoreSampleRecordsTable;
  core_ai_summary: CoreAiSummaryTable;
  core_written_policy: CoreWrittenPolicyTable;
  core_adjudication: CoreAdjudicationTable;
  core_embedding: CoreEmbeddingTable;
  core_embedding_queue: CoreEmbeddingQueueTable;
  core_meta: CoreMetaTable;
  core_migrations: CoreMigrationsTable;
  core_user: CoreUserTable;
  core_session: CoreSessionTable;
  core_account: CoreAccountTable;
  core_verification: CoreVerificationTable;
  core_settings: CoreSettingsTable;
  core_person: CorePersonTable;
  core_person_emails: CorePersonEmailsTable;
  core_person_phones: CorePersonPhonesTable;
  core_organisation: CoreOrganisationTable;
  core_duplicate_pair: CoreDuplicatePairTable;
  core_organisation_domains: CoreOrganisationDomainsTable;
  core_organisation_addresses: CoreOrganisationAddressesTable;
  core_affiliation: CoreAffiliationTable;
  core_tags: CoreTagsTable;
  core_record_tags: CoreRecordTagsTable;
  core_activity: CoreActivityTable;
  core_activity_links: CoreActivityLinksTable;
  core_task: CoreTaskTable;
  core_task_links: CoreTaskLinksTable;
  core_views: CoreViewsTable;
  core_dashboards: CoreDashboardsTable;
  core_user_home: CoreUserHomeTable;
  core_extension_settings: CoreExtensionSettingsTable;
  core_audit: CoreAuditTable;
  core_audit_changes: CoreAuditChangesTable;
  core_audit_redactions: CoreAuditRedactionsTable;
  core_change_set: CoreChangeSetTable;
  core_pending_action: CorePendingActionTable;
  core_pending_action_records: CorePendingActionRecordsTable;
  core_connected_app: CoreConnectedAppTable;
  core_audit_read_counts: CoreAuditReadCountsTable;
  core_audit_purges: CoreAuditPurgesTable;
  core_storage_stats: CoreStorageStatsTable;
  core_integration_vendor: CoreIntegrationVendorTable;
  core_integration_connection: CoreIntegrationConnectionTable;
  core_outbound_kind: CoreOutboundKindTable;
  core_integration_event: CoreIntegrationEventTable;
  core_sync_item: CoreSyncItemTable;
  core_suggested_contact: CoreSuggestedContactTable;
  core_job_change_suggestion: CoreJobChangeSuggestionTable;
  core_person_signature: CorePersonSignatureTable;
  core_search_docs: CoreSearchDocsTable;
  core_search: CoreSearchTable;
  core_extensions: CoreExtensionsTable;
  core_extension_versions: CoreExtensionVersionsTable;
  core_extension_runs: CoreExtensionRunsTable;
  core_extension_kv: CoreExtensionKvTable;
  core_extension_proposals: CoreExtensionProposalsTable;
  core_extension_objects: CoreExtensionObjectsTable;
  core_extension_fields: CoreExtensionFieldsTable;
  core_stage_history: CoreStageHistoryTable;
  core_automations: CoreAutomationsTable;
  core_automation_runs: CoreAutomationRunsTable;
  core_automation_run_records: CoreAutomationRunRecordsTable;
  core_automation_counters: CoreAutomationCountersTable;
  core_notifications: CoreNotificationsTable;
  core_automation_binding: CoreAutomationBindingTable;
  core_automation_outbox: CoreAutomationOutboxTable;
  core_notification_preference: CoreNotificationPreferenceTable;
  core_notification_delivery: CoreNotificationDeliveryTable;
  core_assistant_conversation: CoreAssistantConversationTable;
  core_assistant_conversation_refs: CoreAssistantConversationRefsTable;
  core_assistant_thread: CoreAssistantThreadTable;
  core_assistant_thread_refs: CoreAssistantThreadRefsTable;
  core_memory: CoreMemoryTable;
  core_memory_refs: CoreMemoryRefsTable;
  core_memory_settings: CoreMemorySettingsTable;
  core_erased_address: CoreErasedAddressTable;
  core_blob_deletion: CoreBlobDeletionTable;
  crm_stage_history: CrmStageHistoryView;
  crm_users: CrmUsersView;
  crm_people: CrmPeopleView;
  crm_organisations: CrmOrganisationsView;
  crm_affiliations: CrmAffiliationsView;
  crm_activities: CrmActivitiesView;
  crm_activity_links: CrmActivityLinksView;
  crm_tasks: CrmTasksView;
  crm_task_links: CrmTaskLinksView;
  crm_record_tags: CrmRecordTagsView;
}
