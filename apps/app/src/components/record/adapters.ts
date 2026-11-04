// Data adapters for a record page's timeline, tasks, affiliations and history. Each one is the
// single place a component gets its data from, typed in the shape the component renders. They
// are generic over the record's object (`"person" | "organisation"`), so the person and the
// organisation record pages share them:
//
//   const timeline = useTimeline("organisation", org.id, { types: ["note", "call"] });
//   const { log } = useLogActivity("organisation", org.id);
//   const tasks = useRecordTasks("organisation", org.id);
//   const { create, setDone } = useTaskActions("organisation", org.id);
//   const history = useRecordHistory("organisation", org.id);
//   const affiliations = useAffiliations("organisation", org.id);
import type { Activity, CoreInput, FieldDiff, Task } from "@crm/core";
import { infiniteQueryOptions, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { callOp } from "#/lib/operations";
import { patchRecord } from "#/lib/optimistic";
import { opKey, useOp, useOpMutation } from "#/lib/query";

/** The kinds of record these panels belong to. */
/** person, organisation, or an extension object (`<extension>.<object>`). */
export type RecordObject = "person" | "organisation" | (string & {});

/** A record the panels belong to. */
export interface RecordRef {
  object: RecordObject;
  id: string;
}

export interface AdapterResult<T> {
  data: T;
  isPending: boolean;
  error: Error | null;
}

/** An adapter over a paged, newest-first list. */
export interface PagedResult<T> extends AdapterResult<T> {
  hasMore: boolean;
  /** Fetches the next page (never alongside another request for this list). */
  loadMore: () => void;
  isLoadingMore: boolean;
  /** The last next-page request failed (infinite scroll waits for a retry). */
  loadMoreFailed: boolean;
}

// --- Timeline -------------------------------------------------------------------------------

export type ActivityType = "note" | "email" | "call" | "meeting" | "system";
export type HumanActivityType = Exclude<ActivityType, "system">;
export const ACTIVITY_TYPE_LABELS: Record<ActivityType, string> = {
  note: "Note",
  email: "Email",
  call: "Call",
  meeting: "Meeting",
  system: "System",
};

export interface TimelinePayload extends Record<string, unknown> {
  /** For system events: `field_change`, `job_change`, `task_completed`, `merge`. */
  kind?: string;
  changes?: {
    field: string;
    label: string;
    before: unknown;
    after: unknown;
    beforeLabel?: string | null;
    afterLabel?: string | null;
  }[];
}

export interface TimelineItem {
  id: string;
  type: ActivityType;
  subject: string | null;
  /** Markdown. */
  body: string | null;
  occurredAt: string;
  /** Display name of the author, or null for system events. */
  authorName: string | null;
  authorActor: string;
  /** Typed per type: email direction/to/cc, call outcome/duration, meeting time/place, … */
  payload: TimelinePayload;
  /** The records whose timelines show it (people, organisations, tasks), with titles. */
  links: { object: string; id: string; title: string | null }[];
  /** The user who logged it; for synced mail and meetings, the mailbox's owner. */
  authorUserId: string | null;
  /** Synced from a connected mailbox or calendar (stage 6a). */
  synced: boolean;
  /** Marked private: only its owner sees it. */
  private: boolean;
  /** For synced items: what the sharing level disclosed. */
  disclosure: "full" | "metadata" | null;
  /** The full email body can be read with activity.getBody. */
  hasFullBody: boolean;
  threadKey: string | null;
}

export function toTimelineItem(activity: Partial<Activity> & { id: string }): TimelineItem {
  return {
    id: activity.id,
    type: (activity.type ?? "note") as ActivityType,
    subject: activity.subject ?? null,
    body: activity.body ?? null,
    occurredAt: activity.occurredAt ?? "",
    authorName: activity.authorName ?? null,
    authorActor: activity.authorActor ?? "human",
    payload: (activity.payload ?? {}) as TimelinePayload,
    links: (activity.links ?? []).map((l) => ({
      object: l.object,
      id: l.id,
      title: l.title ?? null,
    })),
    authorUserId: activity.authorUserId ?? null,
    synced: activity.synced === true,
    private: activity.private === true,
    disclosure: activity.disclosure ?? null,
    hasFullBody: activity.hasFullBody === true,
    threadKey: activity.threadKey ?? null,
  };
}

export interface TimelineOptions {
  /** Only these types (default: all, system events included). */
  types?: ActivityType[];
  pageSize?: number;
}

/** The infinite query behind a record's timeline (shared with route loaders that preload it). */
export function timelineQueryOptions(
  object: RecordObject,
  id: string,
  { types, pageSize = 25 }: TimelineOptions = {},
) {
  const input = {
    object,
    recordId: id,
    limit: pageSize,
    ...(types?.length ? { types } : {}),
  };
  return infiniteQueryOptions({
    queryKey: opKey("activity.listForRecord", input),
    queryFn: ({ pageParam }) =>
      callOp("activity.listForRecord", { ...input, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

/** A record's timeline (`activity.listForRecord`), newest first, page by page. */
export function useTimeline(
  object: RecordObject,
  id: string,
  options: TimelineOptions = {},
): PagedResult<TimelineItem[]> {
  const query = useInfiniteQuery(timelineQueryOptions(object, id, options));
  const data = useMemo(
    () => query.data?.pages.flatMap((page) => page.items.map(toTimelineItem)) ?? [],
    [query.data],
  );
  return {
    data,
    isPending: query.isPending,
    error: query.error,
    hasMore: query.hasNextPage,
    loadMore: () => void query.fetchNextPage({ cancelRefetch: false }),
    isLoadingMore: query.isFetching,
    loadMoreFailed: query.isFetchNextPageError,
  };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** What the composer submits: `activity.log`'s input without links (the record is the link). */
export type NewActivity = DistributiveOmit<CoreInput<"activity.log">, "links">;

/**
 * Logs a note, email, call or meeting on the record's timeline (`activity.log`), and on the
 * timelines of any `also` records (e.g. the person's organisation).
 */
export function useLogActivity(
  object: RecordObject,
  id: string,
): { log: (activity: NewActivity, also?: RecordRef[]) => Promise<void>; isPending: boolean } {
  const mutation = useOpMutation("activity.log");
  const { mutateAsync } = mutation;
  const log = useCallback(
    async (activity: NewActivity, also: RecordRef[] = []) => {
      await mutateAsync({
        ...activity,
        links: [{ object, id }, ...also.filter((r) => r.id !== id)],
      } as CoreInput<"activity.log">);
    },
    [mutateAsync, object, id],
  );
  return { log, isPending: mutation.isPending };
}

// --- Tasks ------------------------------------------------------------------------------------

export interface TaskItem {
  id: string;
  title: string;
  notes: string | null;
  /** `YYYY-MM-DD` or ISO timestamp. */
  dueAt: string | null;
  status: "open" | "done";
  assigneeId: string | null;
  assigneeName: string | null;
  links: { object: string; id: string; title: string | null }[];
}

export function toTaskItem(task: Partial<Task> & { id: string }): TaskItem {
  return {
    id: task.id,
    title: task.title ?? "",
    notes: task.notes ?? null,
    dueAt: task.dueAt ?? null,
    status: task.status ?? "open",
    assigneeId: task.assigneeId ?? null,
    assigneeName: task.assigneeName ?? null,
    links: (task.links ?? []).map((l) => ({ object: l.object, id: l.id, title: l.title ?? null })),
  };
}

/** Tasks linked to a record (`task.list` by linkedRecordId), open and done, by due date. */
export function useRecordTasks(object: RecordObject, id: string): AdapterResult<TaskItem[]> {
  void object; // ids are globally unique (per_…, org_…); the object keeps the signature uniform.
  const query = useOp("task.list", {
    filter: { field: "linkedRecordId", op: "eq", value: id },
    sort: { field: "dueAt", direction: "asc" },
    limit: 200,
  });
  const data = useMemo(() => query.data?.items.map(toTaskItem) ?? [], [query.data]);
  return { data, isPending: query.isPending, error: query.error };
}

export interface NewTask {
  title: string;
  dueAt?: string | null;
  notes?: string | null;
  /** Default: the signed-in user. */
  assigneeId?: string | null;
}

/**
 * Task writes for a record: create (linked to the record), complete/reopen and delete. Usable
 * with `object`/`id` null for tasks not about any record (the Tasks page).
 *
 * Completing or reopening is optimistic: every cached task read shows the new status at once and
 * rolls back if the write fails (the error is rethrown for the caller to report). Success shows a
 * toast with Undo.
 */
export function useTaskActions(
  object: RecordObject | null,
  id: string | null,
): {
  create: (task: NewTask) => Promise<void>;
  setDone: (taskId: string, done: boolean) => Promise<void>;
  remove: (taskId: string) => Promise<void>;
  isPending: boolean;
} {
  const create = useOpMutation("task.create");
  const complete = useOpMutation("task.complete");
  const reopen = useOpMutation("task.reopen");
  const remove = useOpMutation("task.delete");
  const client = useQueryClient();
  const setDone = async (taskId: string, done: boolean, undoable = true): Promise<void> => {
    const rollback = await patchRecord(client, ["task."], taskId, {
      status: done ? "done" : "open",
    });
    try {
      await (done ? complete : reopen).mutateAsync({ id: taskId });
    } catch (error) {
      rollback();
      throw error;
    }
    if (undoable) {
      toast.success(done ? "Task completed" : "Task reopened", {
        action: {
          label: "Undo",
          onClick: () =>
            void setDone(taskId, !done, false).catch((error: unknown) =>
              toast.error(error instanceof Error ? error.message : "Could not undo"),
            ),
        },
      });
    }
  };
  return {
    create: async (task) => {
      await create.mutateAsync({
        ...task,
        ...(object && id ? { links: [{ object, id }] } : {}),
      });
    },
    setDone: (taskId, done) => setDone(taskId, done),
    remove: async (taskId) => {
      await remove.mutateAsync({ id: taskId });
    },
    isPending: create.isPending || complete.isPending || reopen.isPending || remove.isPending,
  };
}

// --- Affiliations ---------------------------------------------------------------------------

export interface AffiliationItem {
  id: string;
  personId: string;
  personName: string | null;
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
 * A person's affiliations (job history) or an organisation's (its current and past people):
 * `affiliation.list`, current first (primary first), then newest start.
 */
export function useAffiliations(
  object: RecordObject,
  id: string,
  { limit }: { limit?: number } = {},
): AdapterResult<AffiliationItem[]> {
  const query = useOp("affiliation.list", {
    ...(object === "person" ? { personId: id } : { organisationId: id }),
    ...(limit ? { limit } : {}),
  });
  return {
    data: query.data?.items ?? [],
    isPending: query.isPending,
    error: query.error,
  };
}

/** A person's affiliations. */
export function usePersonAffiliations(personId: string): AdapterResult<AffiliationItem[]> {
  return useAffiliations("person", personId);
}

// --- History ----------------------------------------------------------------------------------

export interface HistoryEntry {
  /** Audit change id. */
  id: string;
  at: string;
  action: "create" | "update" | "delete" | "restore" | "erase" | "merge";
  operation: string;
  actor: "human" | "assistant" | "mcp" | "automation" | "extension";
  userName: string | null;
  diff: FieldDiff;
}

/** A record's change history (`audit.listForRecord`), newest first, page by page. */
export function useRecordHistory(
  object: RecordObject,
  id: string,
  { pageSize = 25 }: { pageSize?: number } = {},
): PagedResult<HistoryEntry[]> {
  const input = { object, recordId: id, limit: pageSize };
  const query = useInfiniteQuery({
    queryKey: opKey("audit.listForRecord", input),
    queryFn: ({ pageParam }) =>
      callOp("audit.listForRecord", { ...input, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 0,
  });
  const data = useMemo(
    () =>
      query.data?.pages.flatMap((page) =>
        page.items.map(
          (entry): HistoryEntry => ({
            id: String(entry.changeId),
            at: entry.at,
            action: entry.action as HistoryEntry["action"],
            operation: entry.operation,
            actor: entry.actor as HistoryEntry["actor"],
            userName: entry.userName,
            diff: entry.diff as FieldDiff,
          }),
        ),
      ) ?? [],
    [query.data],
  );
  return {
    data,
    isPending: query.isPending,
    error: query.error,
    hasMore: query.hasNextPage,
    loadMore: () => void query.fetchNextPage({ cancelRefetch: false }),
    isLoadingMore: query.isFetching,
    loadMoreFailed: query.isFetchNextPageError,
  };
}
