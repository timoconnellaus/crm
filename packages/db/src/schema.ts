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
  created_at: Timestamp;
  updated_at: Timestamp;
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

export interface CoreRateLimitTable {
  key: string;
  window_start: string;
  count: Defaulted<number>;
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

export interface CoreDatabase {
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
  core_audit: CoreAuditTable;
  core_audit_changes: CoreAuditChangesTable;
  core_audit_redactions: CoreAuditRedactionsTable;
  core_change_set: CoreChangeSetTable;
  core_pending_action: CorePendingActionTable;
  core_pending_action_records: CorePendingActionRecordsTable;
  core_connected_app: CoreConnectedAppTable;
  core_rate_limit: CoreRateLimitTable;
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
