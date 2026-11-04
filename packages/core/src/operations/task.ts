// task.* operations: to-dos with a due date, an assignee and links to any records.
import type { CoreDatabase } from "@crm/db";
import type { Kysely } from "kysely";
import { z } from "zod";
import { NotFoundError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import { taskObject } from "../fields/task.ts";
import { newId } from "../ids.ts";
import { listInputSchema, pageSchema, runListQuery, selectFields } from "../list.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { jsonList } from "../records/common.ts";
import {
  assertLinkTargets,
  type LinkedRecord,
  linkedRecordSchema,
  linkKeys,
  loadLinks,
  recordRefSchema,
  uniqueRefs,
} from "../records/links.ts";
import { TRASH_RETENTION_DAYS } from "./person.ts";

// --- Schemas -----------------------------------------------------------------------------------

const taskId = z.string().startsWith("tsk_").max(64).describe("Task id (tsk_…)");
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar date (`YYYY-MM-DD`, kept as is) or an ISO timestamp (normalised to UTC). */
const dueSchema = z
  .union([
    z.iso.date(),
    z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString()),
  ])
  .describe("Due date (YYYY-MM-DD) or due time (ISO-8601)");

const taskWritableFields = {
  title: z.string().trim().min(1).max(500),
  notes: z.string().max(50_000).nullish().describe("Markdown"),
  dueAt: dueSchema.nullish(),
  assigneeId: z
    .string()
    .min(1)
    .max(64)
    .nullish()
    .describe("User id (usr_…). On create, defaults to you; null leaves it unassigned."),
  links: z
    .array(recordRefSchema)
    .max(50)
    .describe("Records the task is about (people, organisations); replaces the list"),
};

export const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  notes: z.string().nullable(),
  dueAt: z.string().nullable(),
  status: z.enum(["open", "done"]),
  completedAt: z.string().nullable(),
  completedBy: z.string().nullable(),
  assigneeId: z.string().nullable(),
  assigneeName: z.string().nullable(),
  links: z.array(linkedRecordSchema),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});
export type Task = z.infer<typeof taskSchema>;
const TASK_FIELDS = Object.keys(taskSchema.shape);

// --- Reading -----------------------------------------------------------------------------------

interface TaskRow {
  id: string;
  title: string;
  notes: string | null;
  due_at: string | null;
  status: "open" | "done";
  completed_at: string | null;
  completed_by?: string | null;
  assignee_id: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  deleted_at?: string | null;
}

async function toTasks(db: Kysely<CoreDatabase>, rows: TaskRow[]): Promise<Task[]> {
  const links = await loadLinks(
    db,
    "core_task_links",
    rows.map((r) => r.id),
  );
  const assigneeIds = [...new Set(rows.flatMap((r) => (r.assignee_id ? [r.assignee_id] : [])))];
  const users = assigneeIds.length
    ? await db
        .selectFrom("core_user")
        .select(["id", "name"])
        .where("id", "in", jsonList(assigneeIds))
        .execute()
    : [];
  const names = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    notes: row.notes,
    dueAt: row.due_at,
    status: row.status,
    completedAt: row.completed_at,
    completedBy: row.completed_by ?? null,
    assigneeId: row.assignee_id,
    assigneeName: row.assignee_id ? (names.get(row.assignee_id) ?? null) : null,
    links: links.get(row.id) ?? [],
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? null,
  }));
}

export async function loadTask(
  db: Kysely<CoreDatabase>,
  id: string,
  { includeDeleted = false } = {},
): Promise<Task | null> {
  let query = db.selectFrom("core_task").selectAll().where("id", "=", id);
  if (!includeDeleted) query = query.where("deleted_at", "is", null);
  const row = await query.executeTakeFirst();
  if (!row) return null;
  const [task] = await toTasks(db, [row]);
  return task ?? null;
}

async function requireTask(
  db: Kysely<CoreDatabase>,
  id: string,
  options?: { includeDeleted?: boolean },
): Promise<Task> {
  const task = await loadTask(db, id, options);
  if (!task) throw new NotFoundError("task", id);
  return task;
}

function taskSnapshot(
  task: Pick<Task, "title" | "notes" | "dueAt" | "status" | "assigneeId">,
  links: string[],
) {
  return {
    title: task.title,
    notes: task.notes,
    dueAt: task.dueAt,
    status: task.status,
    assigneeId: task.assigneeId,
    links,
  };
}

async function assertUserExists(db: Kysely<CoreDatabase>, id: string | null | undefined) {
  if (!id) return;
  const user = await db
    .selectFrom("core_user")
    .select("id")
    .where("id", "=", id)
    .executeTakeFirst();
  if (!user) throw new ValidationError(`No user with id ${id}`, { field: "assigneeId" });
}

function queueLinks(ctx: HandlerContext, taskId: string, refs: z.infer<typeof recordRefSchema>[]) {
  ctx.write(ctx.db.deleteFrom("core_task_links").where("task_id", "=", taskId));
  if (refs.length) {
    ctx.write(
      ctx.db
        .insertInto("core_task_links")
        .values(
          refs.map((ref) => ({ task_id: taskId, object_type: ref.object, record_id: ref.id })),
        ),
    );
  }
}

/** Activities about a task go on the task and on every record it links to. */
function timelineLinks(task: { id: string; links: LinkedRecord[] }) {
  return [{ object: "task", id: task.id }, ...task.links.map(({ object, id }) => ({ object, id }))];
}

// --- Due buckets -------------------------------------------------------------------------------

export const DUE_BUCKETS = ["overdue", "today", "thisWeek", "later", "none"] as const;
export type DueBucket = (typeof DUE_BUCKETS)[number];

/** The calendar date (`YYYY-MM-DD`) of `instant` in `timeZone`. */
export function localDate(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Which bucket a due value falls in, relative to `today` in `timeZone`: before today is overdue,
 * the rest of this week runs to Sunday (ISO weeks), and anything after is later. Due times are
 * compared by their local date.
 */
export function dueBucket(dueAt: string | null, today: string, timeZone: string): DueBucket {
  if (!dueAt) return "none";
  const due = DATE_RE.test(dueAt) ? dueAt : localDate(new Date(dueAt), timeZone);
  if (due < today) return "overdue";
  if (due === today) return "today";
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay() || 7; // Monday 1 … Sunday 7
  return due <= addDays(today, 7 - weekday) ? "thisWeek" : "later";
}

const timeZoneSchema = z
  .string()
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "Unknown IANA timezone")
  .describe("IANA timezone for 'today', e.g. Australia/Sydney. Default UTC.");

// --- Operations --------------------------------------------------------------------------------

export const taskCreate = defineOperation({
  name: "task.create",
  description:
    "Create an open task with a title and optional notes, due date (YYYY-MM-DD) or due time, " +
    "assignee (defaults to you) and links to the records it is about. Returns the task.",
  input: z.object({ ...taskWritableFields, links: taskWritableFields.links.optional() }),
  output: taskSchema,
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const assigneeId = input.assigneeId === undefined ? ctx.user.id : input.assigneeId;
    await assertUserExists(ctx.db, assigneeId);
    const links = uniqueRefs(input.links ?? []);
    await assertLinkTargets(ctx.db, links);
    const id = newId("task");
    const row = {
      id,
      title: input.title,
      notes: input.notes?.trim() ? input.notes : null,
      due_at: input.dueAt ?? null,
      status: "open" as const,
      assignee_id: assigneeId,
      created_at: ctx.now,
      created_by: ctx.user.id,
      updated_at: ctx.now,
    };
    ctx.write(ctx.db.insertInto("core_task").values(row));
    queueLinks(ctx, id, links);
    ctx.recordChange({
      object: "task",
      id,
      action: "create",
      after: taskSnapshot(
        { title: row.title, notes: row.notes, dueAt: row.due_at, status: "open", assigneeId },
        linkKeys(links),
      ),
    });
    return ctx.afterCommit(() => requireTask(ctx.db, id));
  },
});

export const taskGet = defineOperation({
  name: "task.get",
  description:
    "Get one task by id with its assignee and linked records. Deleted tasks are not found " +
    "unless includeDeleted is true. Read-only.",
  input: z.object({ id: taskId, includeDeleted: z.boolean().default(false) }),
  output: taskSchema,
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    return requireTask(ctx.db, input.id, { includeDeleted: input.includeDeleted });
  },
});

export const taskUpdate = defineOperation({
  name: "task.update",
  description:
    "Update a task's title, notes, due date, assignee or links. Only the fields you pass change; " +
    "pass null to clear notes, due date or assignee. links replaces the whole list. Use " +
    "task.complete and task.reopen to change the status. Returns the updated task.",
  input: z.object({
    id: taskId,
    title: taskWritableFields.title.optional(),
    notes: taskWritableFields.notes,
    dueAt: taskWritableFields.dueAt,
    assigneeId: taskWritableFields.assigneeId,
    links: taskWritableFields.links.optional(),
  }),
  output: taskSchema,
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const before = await requireTask(ctx.db, input.id);
    const after = { ...before };
    const set: Record<string, unknown> = { updated_at: ctx.now };
    if (input.title !== undefined) set.title = after.title = input.title;
    if (input.notes !== undefined)
      set.notes = after.notes = input.notes?.trim() ? input.notes : null;
    if (input.dueAt !== undefined) set.due_at = after.dueAt = input.dueAt ?? null;
    if (input.assigneeId !== undefined) {
      await assertUserExists(ctx.db, input.assigneeId);
      set.assignee_id = after.assigneeId = input.assigneeId ?? null;
    }
    const beforeLinks = linkKeys(before.links);
    let afterLinks = beforeLinks;
    if (input.links !== undefined) {
      const links = uniqueRefs(input.links);
      await assertLinkTargets(ctx.db, links);
      queueLinks(ctx, input.id, links);
      afterLinks = linkKeys(links);
    }
    ctx.write(ctx.db.updateTable("core_task").set(set).where("id", "=", input.id));
    ctx.recordChange({
      object: "task",
      id: input.id,
      action: "update",
      before: taskSnapshot(before, beforeLinks),
      after: taskSnapshot(after, afterLinks),
    });
    return ctx.afterCommit(() => requireTask(ctx.db, input.id));
  },
});

export const taskComplete = defineOperation({
  name: "task.complete",
  description:
    "Mark a task done. Posts a 'Task completed' system activity on the task and on every record " +
    "it links to. Completing a task that is already done changes nothing. Returns the task.",
  input: z.object({ id: taskId }),
  output: taskSchema,
  permission: "records:write",
  risk: "write",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const task = await requireTask(ctx.db, input.id);
    if (task.status === "done") return task;
    ctx.write(
      ctx.db
        .updateTable("core_task")
        .set({
          status: "done",
          completed_at: ctx.now,
          completed_by: ctx.user.id,
          updated_at: ctx.now,
        })
        .where("id", "=", input.id),
    );
    ctx.recordChange({
      object: "task",
      id: input.id,
      action: "update",
      diff: {
        status: { before: "open", after: "done" },
        completedAt: { before: null, after: ctx.now },
      },
    });
    ctx.postActivity({
      subject: `Task completed: ${task.title}`,
      payload: { kind: "task_completed", taskId: task.id, title: task.title },
      links: timelineLinks(task),
    });
    return ctx.afterCommit(() => requireTask(ctx.db, input.id));
  },
});

export const taskReopen = defineOperation({
  name: "task.reopen",
  description:
    "Reopen a done task (status back to open, completion cleared). Reopening an open task " +
    "changes nothing. Returns the task.",
  input: z.object({ id: taskId }),
  output: taskSchema,
  permission: "records:write",
  risk: "write",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const task = await requireTask(ctx.db, input.id);
    if (task.status === "open") return task;
    ctx.write(
      ctx.db
        .updateTable("core_task")
        .set({ status: "open", completed_at: null, completed_by: null, updated_at: ctx.now })
        .where("id", "=", input.id),
    );
    ctx.recordChange({
      object: "task",
      id: input.id,
      action: "update",
      diff: {
        status: { before: "done", after: "open" },
        completedAt: { before: task.completedAt, after: null },
      },
    });
    return ctx.afterCommit(() => requireTask(ctx.db, input.id));
  },
});

export const taskDelete = defineOperation({
  name: "task.delete",
  description:
    "Move a task to Trash (soft delete). It disappears from task lists and search, and can be " +
    `restored with task.restore for ${TRASH_RETENTION_DAYS} days.`,
  input: z.object({ id: taskId }),
  output: z.object({ id: z.string(), deletedAt: z.string(), restorableUntil: z.string() }),
  permission: "records:write",
  risk: "destructive",
  async handler(input, ctx) {
    await requireTask(ctx.db, input.id);
    ctx.write(
      ctx.db
        .updateTable("core_task")
        .set({ deleted_at: ctx.now, deleted_by: ctx.user.id, updated_at: ctx.now })
        .where("id", "=", input.id),
    );
    ctx.recordChange({
      object: "task",
      id: input.id,
      action: "delete",
      diff: { deletedAt: { before: null, after: ctx.now } },
    });
    const until = new Date(Date.parse(ctx.now) + TRASH_RETENTION_DAYS * 86_400_000);
    return { id: input.id, deletedAt: ctx.now, restorableUntil: until.toISOString() };
  },
});

export const taskRestore = defineOperation({
  name: "task.restore",
  description: "Restore a task from Trash. Returns the restored task.",
  input: z.object({ id: taskId }),
  output: taskSchema,
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const task = await requireTask(ctx.db, input.id, { includeDeleted: true });
    if (!task.deletedAt) throw new ValidationError("This task is not in Trash");
    ctx.write(
      ctx.db
        .updateTable("core_task")
        .set({ deleted_at: null, deleted_by: null, updated_at: ctx.now })
        .where("id", "=", input.id),
    );
    ctx.recordChange({
      object: "task",
      id: input.id,
      action: "restore",
      diff: { deletedAt: { before: task.deletedAt, after: null } },
    });
    return ctx.afterCommit(() => requireTask(ctx.db, input.id));
  },
});

export const taskList = defineOperation({
  name: "task.list",
  description:
    "List live tasks, one page at a time. Filter with structured filter JSON over task fields " +
    "(e.g. { and: [{ field: 'status', op: 'eq', value: 'open' }, { field: 'assigneeId', op: " +
    "'eq', value: 'usr_…' }, { field: 'dueAt', op: 'lt', value: '2026-12-01' }] }); " +
    "linkedRecordId finds tasks about a record. Sort by a sortable field (default dueAt). Pass " +
    "nextCursor back as cursor for the next page. For your own open tasks grouped by due date, " +
    "use task.listMine. Read-only.",
  input: listInputSchema,
  output: pageSchema(taskSchema.partial().required({ id: true })),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const page = await runListQuery(
      ctx.db.selectFrom("crm_tasks").selectAll(),
      getObject("task") ?? taskObject,
      input,
    );
    const items = await toTasks(ctx.db, page.rows);
    return { items: selectFields(items, input.fields, TASK_FIELDS), nextCursor: page.nextCursor };
  },
});

export const MY_TASKS_LIMIT = 500;

export const taskListMine = defineOperation({
  name: "task.listMine",
  description:
    "Your open tasks (assigned to you), grouped by due date: overdue, today, thisWeek (through " +
    "Sunday), later, and none (no due date). Pass your IANA timezone so 'today' is your today. " +
    `Each group is sorted by due date; at most ${MY_TASKS_LIMIT} tasks are returned. Read-only.`,
  input: z.object({ timezone: timeZoneSchema.default("UTC") }),
  output: z.object({
    today: z.string().describe("Today's date in the timezone"),
    buckets: z.object(
      Object.fromEntries(DUE_BUCKETS.map((b) => [b, z.array(taskSchema)])) as {
        [K in DueBucket]: z.ZodArray<typeof taskSchema>;
      },
    ),
    counts: z.object(
      Object.fromEntries(DUE_BUCKETS.map((b) => [b, z.number()])) as {
        [K in DueBucket]: z.ZodNumber;
      },
    ),
    truncated: z.boolean(),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const rows = await ctx.db
      .selectFrom("crm_tasks")
      .selectAll()
      .where("assignee_id", "=", ctx.user.id)
      .where("status", "=", "open")
      .orderBy("due_at", "asc")
      .orderBy("id", "asc")
      .limit(MY_TASKS_LIMIT + 1)
      .execute();
    const tasks = await toTasks(ctx.db, rows.slice(0, MY_TASKS_LIMIT));
    const today = localDate(new Date(ctx.now), input.timezone);
    const buckets = Object.fromEntries(DUE_BUCKETS.map((b) => [b, [] as Task[]])) as Record<
      DueBucket,
      Task[]
    >;
    for (const task of tasks) buckets[dueBucket(task.dueAt, today, input.timezone)].push(task);
    const counts = Object.fromEntries(DUE_BUCKETS.map((b) => [b, buckets[b].length])) as Record<
      DueBucket,
      number
    >;
    return { today, buckets, counts, truncated: rows.length > MY_TASKS_LIMIT };
  },
});

export const taskOperations = [
  taskCreate,
  taskGet,
  taskUpdate,
  taskComplete,
  taskReopen,
  taskDelete,
  taskRestore,
  taskList,
  taskListMine,
] as const;
