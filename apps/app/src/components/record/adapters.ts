// Data adapters for the record page's timeline, tasks, affiliations and history. Each one is
// the single place a component gets its data from, typed in the shape the component renders.
// Their operations are being built on other branches; every adapter marked TODO(stage-1-wire)
// returns placeholder data (empty, or what person.get already carries) and reports
// `wired: false`, so components can say so instead of looking broken.
import type { FieldDiff } from "@crm/core/client";

/** A record the panels belong to. */
export interface RecordRef {
  object: "person" | "organisation";
  id: string;
}

export interface AdapterResult<T> {
  data: T;
  isPending: boolean;
  /** False while the backing operation does not exist yet. */
  wired: boolean;
}

// --- Timeline -------------------------------------------------------------------------------

export type ActivityType = "note" | "email" | "call" | "meeting" | "system";

export interface TimelineItem {
  id: string;
  type: ActivityType;
  subject: string | null;
  /** Markdown. */
  body: string | null;
  occurredAt: string;
  /** Display name of the author, or null for system events. */
  authorName: string | null;
  authorActor: "human" | "assistant" | "mcp" | "automation" | "system";
  /** For system events: `{ kind: "field_change", changes: [...] }`, `{ kind: "job_change" }`, … */
  payload: {
    kind?: string;
    changes?: { field: string; label: string; before: unknown; after: unknown }[];
  };
}

/**
 * TODO(stage-1-wire): `activity.list` { filter: linked to { object, id }, sort: occurredAt desc,
 * cursor } → paged TimelineItems (newest first).
 */
export function useTimeline(_record: RecordRef): AdapterResult<TimelineItem[]> {
  return { data: [], isPending: false, wired: false };
}

export interface NewActivity {
  type: Exclude<ActivityType, "system">;
  subject?: string;
  body: string;
  occurredAt?: string;
}

/**
 * TODO(stage-1-wire): `activity.create` { type, subject, body, occurredAt, links: [record] }.
 * Until then `create` is null and the composer is disabled.
 */
export function useCreateActivity(_record: RecordRef): {
  create: ((activity: NewActivity) => Promise<void>) | null;
  isPending: boolean;
} {
  return { create: null, isPending: false };
}

// --- Tasks ------------------------------------------------------------------------------------

export interface TaskItem {
  id: string;
  title: string;
  /** `YYYY-MM-DD` or ISO timestamp. */
  dueAt: string | null;
  status: "open" | "done";
  assigneeId: string | null;
}

/** TODO(stage-1-wire): `task.list` { filter: linked to { object, id }, sort: dueAt asc }. */
export function useRecordTasks(_record: RecordRef): AdapterResult<TaskItem[]> {
  return { data: [], isPending: false, wired: false };
}

/**
 * TODO(stage-1-wire): `task.create` { title, dueAt, links: [record] } and `task.update`
 * { id, status } (complete / reopen). Null until then.
 */
export function useTaskActions(_record: RecordRef): {
  create: ((task: { title: string; dueAt?: string | null }) => Promise<void>) | null;
  setDone: ((id: string, done: boolean) => Promise<void>) | null;
} {
  return { create: null, setDone: null };
}

// --- Affiliations ---------------------------------------------------------------------------

export interface AffiliationItem {
  id: string;
  organisationId: string;
  organisationName: string | null;
  title: string | null;
  role: string | null;
  /** `YYYY-MM-DD`. */
  startedOn: string | null;
  endedOn: string | null;
  current: boolean;
  primary: boolean;
}

/**
 * A person's affiliations: current (primary first) and past (job history).
 * TODO(stage-1-wire): `affiliation.list` { personId } → every affiliation, current and past.
 * Until then only the primary affiliation that person.get returns is shown.
 */
export function usePersonAffiliations(person: {
  primaryAffiliation: {
    id: string;
    organisationId: string;
    organisationName: string | null;
    title: string | null;
  } | null;
}): AdapterResult<AffiliationItem[]> {
  const primary = person.primaryAffiliation;
  return {
    data: primary
      ? [
          {
            ...primary,
            role: null,
            startedOn: null,
            endedOn: null,
            current: true,
            primary: true,
          },
        ]
      : [],
    isPending: false,
    wired: false,
  };
}

// --- History ----------------------------------------------------------------------------------

export interface HistoryEntry {
  /** Audit change id. */
  id: string;
  at: string;
  action: "create" | "update" | "delete" | "restore" | "erase" | "merge";
  operation: string;
  actor: "human" | "assistant" | "mcp" | "automation";
  userName: string | null;
  diff: FieldDiff;
}

/**
 * TODO(stage-1-wire): an audit read for one record, e.g. `audit.history` { object, id, cursor }
 * → core_audit_changes joined to core_audit (operation, actor, user), newest first.
 */
export function useRecordHistory(_record: RecordRef): AdapterResult<HistoryEntry[]> {
  return { data: [], isPending: false, wired: false };
}
