// memory.* and teamMemory.* operations (ADR 0342): what each person's assistant remembers, and
// what the team's assistants share. The assistant saves lines inline from the chat with
// `memory.propose` (and `teamMemory.propose`), checked by the judge's `memory.write` and
// `memory.condition` placements; the person edits them on "What your assistant remembers".
//
// Memory is the person's own preferences, not records, so these never queue for review
// (`bookkeeping`): a save is undone with one tap instead. Only the chat can write: an assistant
// call without a chat turn (an agent) is refused, so agents read memory and cannot change it.
// Customer facts are refused here and go on the record as a note (`activity.proposeNote`).
import { z } from "zod";
import {
  customersNamedIn,
  DEFAULT_TEAM_GOVERNANCE,
  describeCondition,
  duplicateOf,
  idOrEmailIn,
  lineFromRow,
  MEMORY_MAX_LINES,
  MEMORY_TEXT_MAX,
  type MemoryCondition,
  type MemoryHistoryEntry,
  type MemoryKind,
  type MemoryLine,
  type MemoryRow,
  memoryConditionSchema,
  memoryLineSchema,
  memoryPaused,
  memoryRefs,
  memoryRow,
  memoryRows,
  PERSONAL_KINDS,
  queueDeleteMemory,
  queueMemoryRefs,
  TEAM_GOVERNANCE,
  TEAM_GOVERNANCE_SETTING,
  TEAM_MEMORY_MAX_LINES,
  type TeamGovernance,
  teamGovernance,
} from "../assistant/memory.ts";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { askMemoryCondition, memoryConditionState } from "../judge/questions/memory-condition.ts";
import { askMemoryWrite, memoryWriteState } from "../judge/questions/memory-write.ts";
import type { Judge } from "../judge/types.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { roleHasPermission } from "../principals.ts";

const memoryId = z
  .string()
  .regex(/^mem_[0-9A-Za-z]{10,40}$/)
  .describe("A memory line's id (mem_…)");

const lineText = z
  .string()
  .trim()
  .min(1)
  .max(MEMORY_TEXT_MAX)
  .describe("The line, in the person's own terms, as one short sentence");

/** What became of a line the assistant wanted to save. */
export const MEMORY_RESULTS = [
  /** Saved: "Saved to memory · undo" shows under the reply. */
  "saved",
  /** Kept as proposed, read back under the reply for the person to save or cancel. */
  "confirm",
  /** A team line, waiting for a permitted person to approve it. */
  "awaiting_approval",
  /** About a customer: never memory. The assistant offers a note on the record. */
  "customer",
  /** Already in memory: nothing saved. */
  "duplicate",
  /** The filter does not match what the person said: nothing saved. */
  "mismatch",
  /** The person has paused memory: nothing saved. */
  "paused",
] as const;
export type MemoryResult = (typeof MEMORY_RESULTS)[number];

const proposeOutput = z.object({
  result: z.enum(MEMORY_RESULTS),
  line: memoryLineSchema.nullable(),
  /** The condition in words, and whether the judge checked it, for the read-back card. */
  checked: z.enum(["judge", "deterministic", "person"]),
  /** What the assistant should do next. */
  message: z.string(),
});
type ProposeOutput = z.infer<typeof proposeOutput>;

const MESSAGES: Record<MemoryResult, (detail: string) => string> = {
  saved: () =>
    'Saved. The person sees "Saved to memory" with Undo under your reply. Acknowledge it in a few words; do not ask them to confirm.',
  confirm: () =>
    "Not saved yet. It is read back under your reply with Save and Cancel, and is saved when the person taps Save. Ask them to check it.",
  awaiting_approval: () =>
    "Proposed for the team. It takes effect when someone who can approve team memory approves it. Say so.",
  customer: (detail) =>
    `Not saved: ${detail}. Customer facts belong on the record, where the whole team can see them. Find the record, then offer it as a note with call_operation activity.proposeNote. Do not try to save it to memory in other words.`,
  duplicate: (detail) => `Already in memory${detail}. Nothing was saved. Do not save it again.`,
  mismatch: (detail) =>
    `Not saved: the filter does not match what the person said. It reads: ${detail}. Rewrite the condition and propose it again, or ask which records they mean.`,
  paused: () =>
    "Not saved: the person has paused memory (Settings, What your assistant remembers). Tell them.",
};

function result(
  kind: MemoryResult,
  checked: ProposeOutput["checked"],
  line: MemoryLine | null = null,
  detail = "",
): ProposeOutput {
  return { result: kind, line, checked, message: MESSAGES[kind](detail) };
}

/** The assistant writes memory only from a chat turn: agents read it and cannot change it. */
function assertChat(ctx: HandlerContext) {
  if (ctx.actor === "assistant" && !ctx.assistantTurn) {
    throw new ForbiddenError(
      "Agents can read memory but not change it. Only the person's chat saves memory lines.",
    );
  }
}

function sourceOf(ctx: HandlerContext) {
  return ctx.assistantTurn
    ? {
        source_thread_id: ctx.assistantTurn.threadId,
        source_message_seq: ctx.assistantTurn.messageSeq,
      }
    : { source_thread_id: null, source_message_seq: null };
}

interface LineCheck {
  decision: "save" | "confirm" | "customer" | "duplicate" | "mismatch";
  checked: ProposeOutput["checked"];
  detail: string;
  /** What checked it, stored with the line. */
  record: Record<string, unknown>;
}

/**
 * The checks before a line is saved (ADR 0342 decisions 2 and 5, spec "When the judge is off").
 * Always: no record id or email in the line, and no line already saying the same. A person typing
 * on the memory page needs no more. For the assistant, the `memory.write` and `memory.condition`
 * placements decide; when either has no answer, the customer-name check runs and the person
 * confirms the read-back (fails closed: nothing unseen is saved). A conditional line is always
 * confirmed by the person.
 */
async function checkLine(
  ctx: HandlerContext,
  line: {
    text: string;
    kind: MemoryKind;
    condition?: { label: string } | undefined;
    existing: readonly { text: string }[];
  },
): Promise<LineCheck> {
  const named = idOrEmailIn(line.text);
  if (named) {
    if (ctx.actor === "human") {
      throw new ValidationError("Memory lines can't hold record ids or email addresses", {
        field: "text",
      });
    }
    return {
      decision: "customer",
      checked: "deterministic",
      detail: "it holds a record id or an email address",
      record: { by: "deterministic", found: "id-or-email" },
    };
  }
  const same = duplicateOf(line.text, line.existing);
  if (same) {
    return {
      decision: "duplicate",
      checked: "deterministic",
      detail: `: "${same.text}"`,
      record: { by: "deterministic", found: "duplicate" },
    };
  }
  if (ctx.actor === "human") {
    return { decision: "save", checked: "person", detail: "", record: { by: "person" } };
  }

  const judge: Judge | undefined = ctx.judge;
  const said = ctx.assistantTurn?.text ?? "";
  const asked = judge
    ? await askMemoryWrite(
        judge,
        memoryWriteState({
          said,
          line: line.text,
          kind: line.kind,
          memory: line.existing.map((l) => l.text),
        }),
      )
    : ({ status: "failed", reason: "off" } as const);

  if (asked.status !== "answered") {
    const customers = await customersNamedIn(ctx.db, line.text, ctx.user.name);
    if (customers.names.length) {
      return {
        decision: "customer",
        checked: "deterministic",
        detail: `it names ${customers.names.join(", ")}`,
        record: { by: "deterministic", found: "customer-name" },
      };
    }
    return {
      decision: "confirm",
      checked: "deterministic",
      detail: "",
      record: { by: "deterministic", judge: asked.reason },
    };
  }
  const record = {
    by: "judge",
    model: asked.model,
    about: asked.about,
    already: asked.already,
    source: asked.source,
  };
  if (asked.customer) {
    return { decision: "customer", checked: "judge", detail: "it is about a customer", record };
  }
  if (asked.duplicate) {
    return { decision: "duplicate", checked: "judge", detail: "", record };
  }
  if (!line.condition) {
    return { decision: asked.notSaid ? "confirm" : "save", checked: "judge", detail: "", record };
  }
  const condition = await askMemoryCondition(
    judge as Judge,
    memoryConditionState({ said, condition: line.condition.label, line: line.text }),
  );
  if (condition.status !== "answered") {
    return {
      decision: "confirm",
      checked: "deterministic",
      detail: "",
      record: { ...record, condition: condition.reason },
    };
  }
  const checked = { ...record, condition: condition.probabilities };
  return condition.matches
    ? { decision: "confirm", checked: "judge", detail: "", record: checked }
    : { decision: "mismatch", checked: "judge", detail: line.condition.label, record: checked };
}

function historyEntry(
  ctx: HandlerContext,
  action: MemoryHistoryEntry["action"],
  text: string,
): MemoryHistoryEntry {
  return { at: ctx.now, by: ctx.user.id, action, text };
}

const historyOf = (row: Pick<MemoryRow, "history">): MemoryHistoryEntry[] =>
  row.history ? (JSON.parse(row.history) as MemoryHistoryEntry[]) : [];

async function ownLine(ctx: HandlerContext, id: string): Promise<MemoryRow> {
  const row = await memoryRow(ctx.db, id);
  if (!row || row.user_id !== ctx.user.id) throw new NotFoundError("memory line", id);
  return row;
}

async function teamLine(ctx: HandlerContext, id: string): Promise<MemoryRow> {
  const row = await memoryRow(ctx.db, id);
  if (!row || row.kind !== "team") throw new NotFoundError("team memory line", id);
  return row;
}

const canManageTeam = (ctx: HandlerContext) => roleHasPermission(ctx.user.role, "settings:manage");

/** May this person edit team lines directly, under this governance? */
const canEditTeam = (ctx: HandlerContext, governance: TeamGovernance) =>
  governance === "open" || canManageTeam(ctx);

async function assertCanEditTeam(ctx: HandlerContext) {
  const governance = await teamGovernance(ctx.db);
  if (!canEditTeam(ctx, governance)) {
    throw new ForbiddenError("Only people who manage team memory can do that here");
  }
}

function lineFor(ctx: HandlerContext, row: MemoryRow): MemoryLine {
  return lineFromRow(row, row.author_id === ctx.user.id ? ctx.user.name : null);
}

const replacedBy = (row: MemoryRow): string | null => {
  const checked = row.checked ? (JSON.parse(row.checked) as { replaces?: unknown }) : null;
  return typeof checked?.replaces === "string" ? checked.replaces : null;
};

export const memoryPropose = defineOperation({
  name: "memory.propose",
  description:
    "Save a line to your memory of the person, during the chat, when they tell you a preference, " +
    "a habit, how they like their writing, what they mean by a phrase, or a rule for how to help " +
    "them. Never for facts about customers, deals or other records: those are refused and go on " +
    "the record as a note. kind: personal (default), shortcut (\"when I say 'the pipeline' I mean " +
    'my open deals over $5k"), style (how they like their writing, such as "no exclamation ' +
    'marks"), or conditional (holds only on some records: give condition { object, filter } with ' +
    "the filter shape views use, from what they said, and the line is read back for them to " +
    "confirm). To change what you remember, pass the old line's id as replaces (memory.list gives " +
    "ids). Follow the message in the result: it says whether the line was saved.",
  input: z.object({
    text: lineText,
    kind: z.enum(PERSONAL_KINDS).default("personal"),
    condition: memoryConditionSchema
      .optional()
      .describe("For kind conditional: the records the line holds on"),
    replaces: memoryId.optional().describe("A line this one replaces, deleted when this is saved"),
    sourceSeq: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Set by the app when the person restores a line with Redo"),
  }),
  output: proposeOutput,
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human", "assistant"],
  mcp: { curated: true, title: "Save to memory" },
  async handler(input, ctx) {
    assertChat(ctx);
    if ((input.kind === "conditional") !== Boolean(input.condition)) {
      throw new ValidationError("A conditional line needs a condition, and only it has one", {
        field: "condition",
      });
    }
    const label = input.condition ? describeCondition(input.condition) : null;
    if (await memoryPaused(ctx.db, ctx.user.id)) return result("paused", "deterministic");
    const { personal, team } = await memoryRows(ctx.db, ctx.user.id);
    if (input.replaces && !personal.some((r) => r.id === input.replaces)) {
      throw new NotFoundError("memory line", input.replaces);
    }
    if (personal.length >= MEMORY_MAX_LINES) {
      throw new ValidationError(
        `Memory is full (${MEMORY_MAX_LINES} lines). Delete some on What your assistant remembers.`,
      );
    }
    const check = await checkLine(ctx, {
      text: input.text,
      kind: input.kind,
      condition: label ? { label } : undefined,
      existing: [...personal.filter((r) => r.id !== input.replaces), ...team],
    });
    if (check.decision !== "save" && check.decision !== "confirm") {
      return result(check.decision, check.checked, null, check.detail);
    }
    const confirmed =
      check.decision === "save" && (input.kind !== "conditional" || ctx.actor === "human");
    const row: MemoryRow = {
      id: newId("memory"),
      user_id: ctx.user.id,
      kind: input.kind,
      text: input.text,
      condition: input.condition ? JSON.stringify(input.condition) : null,
      condition_label: label,
      status: confirmed ? "active" : "proposed",
      ...sourceOf(ctx),
      checked: JSON.stringify({
        ...check.record,
        ...(input.replaces ? { replaces: input.replaces } : {}),
      }),
      author_id: ctx.user.id,
      history: null,
      active_since: confirmed ? ctx.now : null,
      created_at: ctx.now,
      updated_at: ctx.now,
    };
    if (ctx.actor === "human" && input.sourceSeq) {
      const thread = await ctx.db
        .selectFrom("core_assistant_thread")
        .select("id")
        .where("user_id", "=", ctx.user.id)
        .executeTakeFirst();
      if (thread) {
        row.source_thread_id = thread.id;
        row.source_message_seq = input.sourceSeq;
      }
    }
    ctx.write(ctx.db.insertInto("core_memory").values(row));
    queueMemoryRefs(
      ctx,
      row.id,
      await memoryRefs(ctx.db, row.text, input.condition, ctx.user.name),
    );
    if (confirmed && input.replaces) queueDeleteMemory(ctx, [input.replaces]);
    return result(confirmed ? "saved" : "confirm", check.checked, lineFor(ctx, row));
  },
});

export const memoryUpdate = defineOperation({
  name: "memory.update",
  description:
    "Change one of your memory lines: its words, its condition, or save a line that was read " +
    "back (confirm). The assistant reads the change from its next turn.",
  input: z.object({
    id: memoryId,
    text: lineText.optional(),
    condition: memoryConditionSchema.optional().describe("A conditional line's new condition"),
    confirm: z.literal(true).optional().describe("Save a line that is waiting to be confirmed"),
  }),
  output: memoryLineSchema,
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const row = await ownLine(ctx, input.id);
    if (input.condition && row.kind !== "conditional") {
      throw new ValidationError("Only a conditional line has a condition", { field: "condition" });
    }
    const text = input.text ?? row.text;
    if (input.text && idOrEmailIn(input.text)) {
      throw new ValidationError("Memory lines can't hold record ids or email addresses", {
        field: "text",
      });
    }
    const condition = input.condition ? JSON.stringify(input.condition) : row.condition;
    const label = input.condition ? describeCondition(input.condition) : row.condition_label;
    const status = input.confirm && row.status === "proposed" ? "active" : row.status;
    const changed = text !== row.text || condition !== row.condition;
    const nowActive = status === "active" && (changed || row.status !== "active");
    const next: MemoryRow = {
      ...row,
      text,
      condition,
      condition_label: label,
      status,
      active_since: nowActive ? ctx.now : row.active_since,
      updated_at: ctx.now,
    };
    ctx.write(
      ctx.db
        .updateTable("core_memory")
        .set({
          text: next.text,
          condition: next.condition,
          condition_label: next.condition_label,
          status: next.status,
          active_since: next.active_since,
          updated_at: ctx.now,
        })
        .where("id", "=", row.id),
    );
    if (changed) {
      const parsed = condition ? (JSON.parse(condition) as MemoryCondition) : null;
      queueMemoryRefs(ctx, row.id, await memoryRefs(ctx.db, text, parsed, ctx.user.name));
    }
    const replaces = input.confirm ? replacedBy(row) : null;
    if (replaces) {
      const old = await memoryRow(ctx.db, replaces);
      if (old?.user_id === ctx.user.id) queueDeleteMemory(ctx, [replaces]);
    }
    return lineFor(ctx, next);
  },
});

export const memoryDelete = defineOperation({
  name: "memory.delete",
  description:
    "Delete a memory line when the person asks you to forget it. It stops being sent at once. " +
    "Their own lines only: team lines change on What your assistant remembers.",
  input: z.object({ id: memoryId }),
  output: z.object({ id: z.string(), deleted: z.literal(true) }),
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human", "assistant"],
  mcp: { title: "Forget a memory line" },
  async handler(input, ctx) {
    assertChat(ctx);
    const row = await memoryRow(ctx.db, input.id);
    if (!row) throw new NotFoundError("memory line", input.id);
    if (row.kind === "team") {
      if (ctx.actor !== "human") {
        throw new ForbiddenError("The assistant can't delete team memory");
      }
      await assertCanEditTeam(ctx);
    } else if (row.user_id !== ctx.user.id) {
      throw new NotFoundError("memory line", input.id);
    }
    queueDeleteMemory(ctx, [input.id]);
    return { id: input.id, deleted: true as const };
  },
});

export const memoryPause = defineOperation({
  name: "memory.pause",
  description:
    "Pause or resume your assistant's memory: one line (give id) or all of it. While all of it is " +
    "paused, nothing is read or saved; the lines are kept.",
  input: z.object({
    id: memoryId.optional().describe("One line; all of your memory when absent"),
    paused: z.boolean(),
  }),
  output: z.object({ paused: z.boolean(), line: memoryLineSchema.nullable() }),
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    if (!input.id) {
      const paused = input.paused ? 1 : 0;
      ctx.write(
        ctx.db
          .insertInto("core_memory_settings")
          .values({ user_id: ctx.user.id, paused, updated_at: ctx.now })
          .onConflict((oc) => oc.column("user_id").doUpdateSet({ paused, updated_at: ctx.now })),
      );
      return { paused: input.paused, line: null };
    }
    const row = await ownLine(ctx, input.id);
    if (row.status === "proposed") {
      throw new ValidationError("Save this line before pausing it");
    }
    const status = input.paused ? ("paused" as const) : ("active" as const);
    const active_since = status === row.status || input.paused ? row.active_since : ctx.now;
    ctx.write(
      ctx.db
        .updateTable("core_memory")
        .set({ status, active_since, updated_at: ctx.now })
        .where("id", "=", row.id),
    );
    return {
      paused: input.paused,
      line: lineFor(ctx, { ...row, status, active_since, updated_at: ctx.now }),
    };
  },
});

export const memoryReset = defineOperation({
  name: "memory.reset",
  description:
    "Delete everything your assistant remembers about you: all of your own lines, including " +
    "writing style. Team lines stay. This cannot be undone.",
  input: z.object({}),
  output: z.object({ deleted: z.number() }),
  permission: "records:read",
  risk: "destructive",
  bookkeeping: true,
  actors: ["human"],
  mcp: { expose: false },
  async handler(_input, ctx) {
    const { personal } = await memoryRows(ctx.db, ctx.user.id);
    queueDeleteMemory(
      ctx,
      personal.map((r) => r.id),
    );
    return { deleted: personal.length };
  },
});

export const memoryList = defineOperation({
  name: "memory.list",
  description:
    "What your assistant remembers: your lines with their conditions, source messages and dates, " +
    "the team's lines, whether memory is paused, and how team memory is governed. Read-only.",
  input: z.object({}),
  output: z.object({
    paused: z.boolean(),
    lines: z.array(memoryLineSchema),
    team: z.array(memoryLineSchema),
    governance: z.enum(TEAM_GOVERNANCE),
    canManageTeam: z.boolean(),
    canEditTeam: z.boolean(),
  }),
  permission: "records:read",
  risk: "read",
  actors: ["human", "assistant"],
  mcp: { title: "List memory lines" },
  async handler(_input, ctx) {
    const [{ personal, team }, paused, governance] = await Promise.all([
      memoryRows(ctx.db, ctx.user.id),
      memoryPaused(ctx.db, ctx.user.id),
      teamGovernance(ctx.db),
    ]);
    const authors = [...new Set(team.flatMap((r) => (r.author_id ? [r.author_id] : [])))];
    const names = new Map(
      authors.length
        ? (
            await ctx.db
              .selectFrom("core_user")
              .select(["id", "name"])
              .where("id", "in", authors)
              .execute()
          ).map((u) => [u.id, u.name])
        : [],
    );
    return {
      paused,
      lines: personal.map((r) => lineFor(ctx, r)),
      team: team.map((r) => lineFromRow(r, r.author_id ? (names.get(r.author_id) ?? null) : null)),
      governance,
      canManageTeam: canManageTeam(ctx),
      canEditTeam: canEditTeam(ctx, governance),
    };
  },
});

export const teamMemoryPropose = defineOperation({
  name: "teamMemory.propose",
  description:
    "Save a line every assistant in the workspace reads, when the person says something holds for " +
    "the whole team (how the team works, shared terms). Never customer facts. Whether it applies " +
    "at once, waits for approval or is refused depends on the workspace's team memory setting: " +
    "follow the message in the result.",
  input: z.object({ text: lineText }),
  output: proposeOutput,
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human", "assistant"],
  mcp: { title: "Propose a team memory line" },
  async handler(input, ctx) {
    assertChat(ctx);
    const governance = await teamGovernance(ctx.db);
    if (governance === "restricted" && !canManageTeam(ctx)) {
      throw new ForbiddenError("Only people who manage team memory can add team lines here");
    }
    const { personal, team } = await memoryRows(ctx.db, ctx.user.id);
    if (team.length >= TEAM_MEMORY_MAX_LINES) {
      throw new ValidationError(`Team memory is full (${TEAM_MEMORY_MAX_LINES} lines)`);
    }
    const check = await checkLine(ctx, {
      text: input.text,
      kind: "team",
      existing: [...team, ...personal],
    });
    if (check.decision !== "save" && check.decision !== "confirm") {
      return result(check.decision, check.checked, null, check.detail);
    }
    const direct = canEditTeam(ctx, governance);
    const active = check.decision === "save" && direct;
    const row: MemoryRow = {
      id: newId("memory"),
      user_id: null,
      kind: "team",
      text: input.text,
      condition: null,
      condition_label: null,
      status: active ? "active" : "proposed",
      ...sourceOf(ctx),
      checked: JSON.stringify(check.record),
      author_id: ctx.user.id,
      history: JSON.stringify([historyEntry(ctx, active ? "added" : "proposed", input.text)]),
      active_since: active ? ctx.now : null,
      created_at: ctx.now,
      updated_at: ctx.now,
    };
    ctx.write(ctx.db.insertInto("core_memory").values(row));
    queueMemoryRefs(ctx, row.id, await memoryRefs(ctx.db, row.text, null, ctx.user.name));
    return result(
      active ? "saved" : direct ? "confirm" : "awaiting_approval",
      check.checked,
      lineFor(ctx, row),
    );
  },
});

export const teamMemoryApprove = defineOperation({
  name: "teamMemory.approve",
  description:
    "Approve a proposed team line, which every assistant in the workspace then reads, or reject " +
    "it, which deletes it. Needs permission to manage team memory, unless the workspace is open.",
  input: z.object({ id: memoryId, approve: z.boolean() }),
  output: z.object({ line: memoryLineSchema.nullable() }),
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    await assertCanEditTeam(ctx);
    const row = await teamLine(ctx, input.id);
    if (row.status !== "proposed") throw new ValidationError("This line is not waiting");
    if (!input.approve) {
      queueDeleteMemory(ctx, [row.id]);
      return { line: null };
    }
    const history = JSON.stringify([...historyOf(row), historyEntry(ctx, "approved", row.text)]);
    ctx.write(
      ctx.db
        .updateTable("core_memory")
        .set({ status: "active", active_since: ctx.now, history, updated_at: ctx.now })
        .where("id", "=", row.id),
    );
    return {
      line: lineFromRow({
        ...row,
        status: "active",
        active_since: ctx.now,
        history,
        updated_at: ctx.now,
      }),
    };
  },
});

export const teamMemoryUpdate = defineOperation({
  name: "teamMemory.update",
  description:
    "Change a team line's words, or pause or resume it. Each change is kept in the line's " +
    "history. Who may do this follows the workspace's team memory setting.",
  input: z.object({
    id: memoryId,
    text: lineText.optional(),
    paused: z.boolean().optional(),
  }),
  output: memoryLineSchema,
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    await assertCanEditTeam(ctx);
    const row = await teamLine(ctx, input.id);
    if (input.text && idOrEmailIn(input.text)) {
      throw new ValidationError("Memory lines can't hold record ids or email addresses", {
        field: "text",
      });
    }
    const text = input.text ?? row.text;
    const status =
      input.paused === undefined || row.status === "proposed"
        ? row.status
        : input.paused
          ? ("paused" as const)
          : ("active" as const);
    const entries: MemoryHistoryEntry[] = [];
    if (text !== row.text) entries.push(historyEntry(ctx, "edited", text));
    if (status !== row.status) {
      entries.push(historyEntry(ctx, status === "paused" ? "paused" : "resumed", text));
    }
    const active_since = status === "active" && entries.length ? ctx.now : row.active_since;
    const history = JSON.stringify([...historyOf(row), ...entries]);
    ctx.write(
      ctx.db
        .updateTable("core_memory")
        .set({ text, status, active_since, history, updated_at: ctx.now })
        .where("id", "=", row.id),
    );
    if (text !== row.text) {
      queueMemoryRefs(ctx, row.id, await memoryRefs(ctx.db, text, null, ctx.user.name));
    }
    return lineFromRow({ ...row, text, status, active_since, history, updated_at: ctx.now });
  },
});

export const teamMemorySetGovernance = defineOperation({
  name: "teamMemory.setGovernance",
  description:
    "Set who can change team memory: open (anyone edits), approval (anyone proposes, people who " +
    "manage settings approve) or restricted (only they propose and edit).",
  input: z.object({ governance: z.enum(TEAM_GOVERNANCE) }),
  output: z.object({ governance: z.enum(TEAM_GOVERNANCE) }),
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const value = JSON.stringify(input.governance);
    ctx.write(
      ctx.db
        .insertInto("core_settings")
        .values({
          key: TEAM_GOVERNANCE_SETTING,
          value,
          updated_at: ctx.now,
          updated_by: ctx.user.id,
        })
        .onConflict((oc) =>
          oc.column("key").doUpdateSet({ value, updated_at: ctx.now, updated_by: ctx.user.id }),
        ),
    );
    return { governance: input.governance };
  },
});

export { DEFAULT_TEAM_GOVERNANCE };

export const memoryOperations = [
  memoryPropose,
  memoryUpdate,
  memoryDelete,
  memoryPause,
  memoryReset,
  memoryList,
  teamMemoryPropose,
  teamMemoryApprove,
  teamMemoryUpdate,
  teamMemorySetGovernance,
] as const;
