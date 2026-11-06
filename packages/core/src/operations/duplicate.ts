// duplicate.* operations (stage 16, ADR 0247): the creation check, the scan's suggestions, review
// (list, dismiss) and bulk merge. Duplicates are found by plain rules with a stated reason, never
// by a score; merging always goes through person.merge / organisation.merge.
import type { CoreDatabase } from "@relationship-os/db";
import { type Kysely, type SqlBool, sql } from "kysely";
import { z } from "zod";
import {
  checkOrganisation,
  checkPerson,
  organisationCheckValuesSchema,
  personCheckValuesSchema,
} from "../duplicates/check.ts";
import {
  DUPLICATE_SETTINGS_KEY,
  type DuplicateObject,
  type DuplicateRule,
  duplicateMatchSchema,
  duplicateObjectSchema,
  duplicateRuleSchema,
  duplicateSettingsSchema,
  isNameOnly,
  loadDuplicateSettings,
  type PairDetails,
  pairReasons,
  sortRules,
} from "../duplicates/rules.ts";
import { loadScanState, runScan, scanPending } from "../duplicates/scan.ts";
import {
  ForbiddenError,
  OperationError,
  PendingApprovalError,
  ValidationError,
} from "../errors.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { roleHasPermission } from "../principals.ts";
import { jsonList } from "../records/common.ts";

const recordId = z
  .string()
  .regex(/^(per|org)_/)
  .max(64)
  .describe("Person (per_…) or organisation (org_…) id");

const prefix = (object: DuplicateObject) => (object === "person" ? "per_" : "org_");
function assertObjectIds(object: DuplicateObject, ids: readonly string[]) {
  const bad = ids.find((id) => !id.startsWith(prefix(object)));
  if (bad) throw new ValidationError(`${bad} is not a ${object} id`, { id: bad });
}

// --- Check -------------------------------------------------------------------------------------

export const duplicateCheck = defineOperation({
  name: "duplicate.check",
  description:
    "Check whether a person or organisation you are about to create already exists, by plain " +
    "rules (no score). Returns conflicts, which would block the create (a live email or domain " +
    "already belongs to that record), and warnings, which do not block (people: same name and " +
    "same organisation, same name and same email domain, same phone number, same name only; " +
    "organisations: same name, or a website at a domain another organisation holds). Each " +
    "comes with the existing record's id, name and reasons, at most 5 of each. Pass exceptId " +
    "when checking an existing record's new values. Read-only.",
  input: z.discriminatedUnion("object", [
    z.object({
      object: z.literal("person"),
      values: personCheckValuesSchema,
      exceptId: z.string().startsWith("per_").max(64).optional(),
    }),
    z.object({
      object: z.literal("organisation"),
      values: organisationCheckValuesSchema,
      exceptId: z.string().startsWith("org_").max(64).optional(),
    }),
  ]),
  output: z.object({
    conflicts: z.array(duplicateMatchSchema),
    warnings: z.array(duplicateMatchSchema),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const options = input.exceptId ? { exceptId: input.exceptId } : {};
    return input.object === "person"
      ? checkPerson(ctx.db, input.values, options)
      : checkOrganisation(ctx.db, input.values, options);
  },
});

// --- Review ------------------------------------------------------------------------------------

/** Open pairs read for one listing; beyond it the page says so and a person narrows by rule. */
export const PAIR_READ_MAX = 2000;

interface PairRow {
  a_id: string;
  b_id: string;
  rules: DuplicateRule[];
  details: PairDetails;
}

/** Open pairs whose two records are both live. */
async function loadOpenPairs(
  db: Kysely<CoreDatabase>,
  object: DuplicateObject,
  limit: number,
): Promise<PairRow[]> {
  const live = (column: "p.a_id" | "p.b_id") =>
    object === "person"
      ? sql<SqlBool>`EXISTS (SELECT 1 FROM core_person WHERE id = ${sql.ref(column)} AND deleted_at IS NULL)`
      : sql<SqlBool>`EXISTS (SELECT 1 FROM core_organisation WHERE id = ${sql.ref(column)} AND deleted_at IS NULL)`;
  const rows = await db
    .selectFrom("core_duplicate_pair as p")
    .select(["p.a_id", "p.b_id", "p.rules", "p.details"])
    .where("p.object", "=", object)
    .where("p.status", "=", "open")
    .where(live("p.a_id"))
    .where(live("p.b_id"))
    .orderBy("p.a_id")
    .orderBy("p.b_id")
    .limit(limit)
    .execute();
  return rows.map((r) => ({
    a_id: r.a_id,
    b_id: r.b_id,
    rules: sortRules(JSON.parse(r.rules) as DuplicateRule[]),
    details: JSON.parse(r.details) as PairDetails,
  }));
}

const memberSchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
  activityCount: z.number(),
  fields: z
    .array(z.object({ field: z.string(), label: z.string(), value: z.string().nullable() }))
    .describe("Values to compare side by side"),
});

const groupSchema = z.object({
  id: z.string().describe("Stable for these members: the kind and the first member id"),
  kind: z
    .enum(["likely", "nameOnly"])
    .describe("nameOnly groups share only a name; they are listed separately"),
  members: z.array(memberSchema),
  pairs: z.array(
    z.object({
      aId: z.string(),
      bId: z.string(),
      rules: z.array(duplicateRuleSchema),
      reasons: z.array(z.string()),
    }),
  ),
  rules: z.array(duplicateRuleSchema),
  reasons: z.array(z.string()),
  survivorId: z.string().describe("Proposed survivor: more linked activities, then the older"),
  survivorReason: z.string(),
  differingFields: z.array(z.string()).describe("Fields whose values differ between members"),
  preselected: z.boolean().describe("Pre-selected for bulk merge (never for name only)"),
});

/** Union-find over pairs: groups of more than two (A, B and C) become one group. */
function groupPairs(pairs: PairRow[]): PairRow[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    parent.set(x, root);
    return root;
  };
  for (const p of pairs) {
    if (!parent.has(p.a_id)) parent.set(p.a_id, p.a_id);
    if (!parent.has(p.b_id)) parent.set(p.b_id, p.b_id);
    const ra = find(p.a_id);
    const rb = find(p.b_id);
    // The smaller id becomes the root (ids are strings, so no Math.min).
    if (ra < rb) parent.set(rb, ra);
    else if (rb < ra) parent.set(ra, rb);
  }
  const groups = new Map<string, PairRow[]>();
  for (const p of pairs) {
    const root = find(p.a_id);
    groups.set(root, [...(groups.get(root) ?? []), p]);
  }
  return [...groups.values()];
}

type Member = z.infer<typeof memberSchema>;

async function loadMembers(
  db: Kysely<CoreDatabase>,
  object: DuplicateObject,
  ids: string[],
): Promise<Map<string, Member>> {
  const out = new Map<string, Member>();
  if (!ids.length) return out;
  const list = jsonList(ids);
  const counts = await db
    .selectFrom("core_activity_links")
    .select(["record_id", (eb) => eb.fn.countAll<number>().as("n")])
    .where("object_type", "=", object)
    .where("record_id", "in", list)
    .groupBy("record_id")
    .execute();
  const activity = new Map(counts.map((c) => [c.record_id, Number(c.n)]));
  if (object === "person") {
    const rows = await db
      .selectFrom("crm_people")
      .select([
        "id",
        "display_name",
        "emails",
        "primary_phone",
        "organisation_name",
        "job_title",
        "location",
        "created_at",
      ])
      .where("id", "in", list)
      .execute();
    for (const r of rows) {
      out.set(r.id, {
        id: r.id,
        title: r.display_name,
        createdAt: r.created_at,
        activityCount: activity.get(r.id) ?? 0,
        fields: [
          { field: "displayName", label: "Name", value: r.display_name },
          {
            field: "emails",
            label: "Emails",
            value: (JSON.parse(r.emails) as string[]).join(", ") || null,
          },
          { field: "phone", label: "Phone", value: r.primary_phone },
          { field: "organisation", label: "Organisation", value: r.organisation_name },
          { field: "jobTitle", label: "Job title", value: r.job_title },
          { field: "location", label: "Location", value: r.location },
        ],
      });
    }
  } else {
    const rows = await db
      .selectFrom("crm_organisations")
      .select([
        "id",
        "name",
        "domains",
        "website",
        "industry",
        "parent_name",
        "current_people_count",
        "created_at",
      ])
      .where("id", "in", list)
      .execute();
    for (const r of rows) {
      out.set(r.id, {
        id: r.id,
        title: r.name,
        createdAt: r.created_at,
        activityCount: activity.get(r.id) ?? 0,
        fields: [
          { field: "name", label: "Name", value: r.name },
          {
            field: "domains",
            label: "Domains",
            value: (JSON.parse(r.domains) as string[]).join(", ") || null,
          },
          { field: "website", label: "Website", value: r.website },
          { field: "industry", label: "Industry", value: r.industry },
          { field: "parent", label: "Parent", value: r.parent_name },
          { field: "people", label: "People", value: String(r.current_people_count ?? 0) },
        ],
      });
    }
  }
  return out;
}

/** The proposed survivor: more linked activities, then the older record. */
export function proposeSurvivor(members: Pick<Member, "id" | "createdAt" | "activityCount">[]): {
  id: string;
  reason: string;
} {
  const sorted = [...members].sort(
    (a, b) =>
      b.activityCount - a.activityCount ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
  const first = sorted[0];
  const second = sorted[1];
  if (!first) throw new ValidationError("A group needs members");
  const reason =
    second && first.activityCount > second.activityCount
      ? `It has more activities (${first.activityCount})`
      : "It was created first";
  return { id: first.id, reason };
}

export const duplicateList = defineOperation({
  name: "duplicate.list",
  description:
    "List likely duplicate people or organisations found by the scan, for review, grouped (A, " +
    "B and C sharing a name and organisation are one group). Each group has its members side " +
    "by side, the rules matched with a plain reason per pair, the proposed survivor (more " +
    "linked activities, then the older record) and the fields that differ. Groups that share " +
    "only a name come last (kind nameOnly) and are never pre-selected. Filter by rule. " +
    "Dismissed pairs are not listed. Merge with duplicate.mergeMany. Read-only.",
  input: z.object({
    object: duplicateObjectSchema,
    rule: duplicateRuleSchema.optional().describe("Only pairs matching this rule"),
    kind: z.enum(["likely", "nameOnly"]).optional(),
    limit: z.number().int().min(1).max(100).default(50).describe("Groups per call"),
  }),
  output: z.object({
    groups: z.array(groupSchema),
    total: z.number().describe("Groups matching, before the limit"),
    truncated: z
      .boolean()
      .describe(`More than ${PAIR_READ_MAX} open pairs: narrow by rule to see the rest`),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    let pairs = await loadOpenPairs(ctx.db, input.object, PAIR_READ_MAX + 1);
    const truncated = pairs.length > PAIR_READ_MAX;
    pairs = pairs.slice(0, PAIR_READ_MAX);
    const rule = input.rule;
    if (rule) pairs = pairs.filter((p) => p.rules.includes(rule));
    const likely = groupPairs(pairs.filter((p) => !isNameOnly(p.rules)));
    const nameOnly = groupPairs(pairs.filter((p) => isNameOnly(p.rules)));
    const all = [
      ...(input.kind === "nameOnly" ? [] : likely.map((g) => ({ kind: "likely" as const, g }))),
      ...(input.kind === "likely" ? [] : nameOnly.map((g) => ({ kind: "nameOnly" as const, g }))),
    ];
    const page = all.slice(0, input.limit);
    const ids = [...new Set(page.flatMap(({ g }) => g.flatMap((p) => [p.a_id, p.b_id])))];
    const members = await loadMembers(ctx.db, input.object, ids);
    const groups = page.flatMap(({ kind, g }) => {
      const memberIds = [...new Set(g.flatMap((p) => [p.a_id, p.b_id]))].sort();
      const list = memberIds.map((id) => members.get(id)).filter((m): m is Member => !!m);
      if (list.length < 2) return [];
      const survivor = proposeSurvivor(list);
      const rules = sortRules(g.flatMap((p) => p.rules));
      const pairViews = g.map((p) => ({
        aId: p.a_id,
        bId: p.b_id,
        rules: p.rules,
        reasons: pairReasons(p.rules, p.details),
      }));
      const differing = (list[0]?.fields ?? [])
        .map((f) => f.field)
        .filter(
          (field) =>
            new Set(list.map((m) => m.fields.find((f) => f.field === field)?.value ?? null)).size >
            1,
        );
      return [
        {
          id: `${kind}:${memberIds[0]}`,
          kind,
          members: list,
          pairs: pairViews,
          rules,
          reasons: [...new Set(pairViews.flatMap((p) => p.reasons))],
          survivorId: survivor.id,
          survivorReason: survivor.reason,
          differingFields: differing,
          preselected: kind === "likely",
        },
      ];
    });
    return { groups, total: all.length, truncated };
  },
});

/** Open pairs with both records live, counted up to a cap (the sidebar shows "999+"). */
export const OPEN_COUNT_CAP = 1000;

export async function countOpenPairs(
  db: Kysely<CoreDatabase>,
  object: DuplicateObject,
): Promise<number> {
  return (await loadOpenPairs(db, object, OPEN_COUNT_CAP)).length;
}

export const duplicateCount = defineOperation({
  name: "duplicate.count",
  description:
    `How many open duplicate pairs await review, for people and organisations (counted up to ` +
    `${OPEN_COUNT_CAP}). Read-only.`,
  input: z.object({}),
  output: z.object({ person: z.number(), organisation: z.number(), total: z.number() }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(_input, ctx) {
    const [person, organisation] = await Promise.all([
      countOpenPairs(ctx.db, "person"),
      countOpenPairs(ctx.db, "organisation"),
    ]);
    return { person, organisation, total: person + organisation };
  },
});

export const duplicateDismiss = defineOperation({
  name: "duplicate.dismiss",
  description:
    "Mark suggested duplicates as not duplicates: every open pair among the given records " +
    "(two ids for one pair; a whole group's ids to dismiss all in the group). A dismissed pair " +
    "is never suggested again. Records are not changed. Returns how many pairs were dismissed.",
  input: z.object({
    object: duplicateObjectSchema,
    ids: z.array(recordId).min(2).max(50).describe("The records that are not duplicates"),
  }),
  output: z.object({ dismissed: z.number() }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    assertObjectIds(input.object, input.ids);
    const ids = [...new Set(input.ids)];
    const open = await ctx.db
      .selectFrom("core_duplicate_pair")
      .select(["a_id", "b_id"])
      .where("object", "=", input.object)
      .where("status", "=", "open")
      .where("a_id", "in", jsonList(ids))
      .where("b_id", "in", jsonList(ids))
      .execute();
    if (open.length) {
      ctx.write(
        ctx.db
          .updateTable("core_duplicate_pair")
          .set({
            status: "dismissed",
            decided_at: ctx.now,
            decided_by: ctx.user.id,
            updated_at: ctx.now,
          })
          .where("object", "=", input.object)
          .where("status", "=", "open")
          .where("a_id", "in", jsonList(ids))
          .where("b_id", "in", jsonList(ids)),
      );
    }
    return { dismissed: open.length };
  },
  auditSummary: (output, input) => ({ object: input.object, ids: input.ids, ...output }),
});

// --- Bulk merge --------------------------------------------------------------------------------

export const MERGE_MANY_GROUPS = 50;
export const MERGE_MANY_RECORDS = 200;

const mergeOutcomeSchema = z.object({
  survivorId: z.string(),
  merged: z.array(z.string()).describe("Merged into the survivor"),
  queued: z
    .array(z.object({ id: z.string(), pendingActionId: z.string() }))
    .describe("Waiting for review in the change set"),
  failed: z.array(z.object({ id: z.string(), code: z.string(), message: z.string() })),
});

function mergeTitle(object: DuplicateObject, count: number): string {
  const noun =
    object === "person"
      ? count === 1
        ? "duplicate person"
        : "duplicate people"
      : count === 1
        ? "duplicate organisation"
        : "duplicate organisations";
  return `Merge ${count} ${noun}`;
}

async function nested(ctx: HandlerContext, name: string, input: unknown): Promise<unknown> {
  return ctx.pipeline.invoke(name, input, {
    actor: ctx.actor,
    user: ctx.user,
    origin: ctx.origin,
    grantedPermissions: ctx.grantedPermissions,
    reason: ctx.reason ?? "Merging duplicates",
  });
}

export const duplicateMergeMany = defineOperation({
  name: "duplicate.mergeMany",
  description:
    "Merge groups of duplicates: for each group, every id in mergedIds is merged into " +
    "survivorId by calling person.merge or organisation.merge once per duplicate, as you, so " +
    "each merge is gated, simulated and audited exactly like a single merge (the survivor keeps " +
    "its values, empty ones are filled from the duplicate). At most " +
    `${MERGE_MANY_GROUPS} groups and ${MERGE_MANY_RECORDS} records per call. A failure in one ` +
    "merge does not stop the others; each group reports what merged, what failed and why, and " +
    "what is waiting for review. When the merges need review (AI clients usually do), they go " +
    "into one titled change set, e.g. 'Merge 12 duplicate people', reviewed whole or per item.",
  input: z.object({
    object: duplicateObjectSchema,
    groups: z
      .array(
        z.object({
          survivorId: recordId.describe("The record that remains"),
          mergedIds: z.array(recordId).min(1).max(50).describe("Duplicates merged into it"),
        }),
      )
      .min(1)
      .max(MERGE_MANY_GROUPS),
  }),
  output: z.object({
    results: z.array(mergeOutcomeSchema),
    merged: z.number(),
    queued: z.number(),
    failed: z.number(),
    changeSetId: z.string().nullable(),
  }),
  permission: "records:write",
  risk: "write",
  // Each merge is gated on its own (they are destructive and usually reviewed for AI clients),
  // so the call that runs them is never itself queued.
  bookkeeping: true,
  async handler(input, ctx) {
    const all = input.groups.flatMap((g) => [g.survivorId, ...g.mergedIds]);
    assertObjectIds(input.object, all);
    const mergedTotal = input.groups.reduce((n, g) => n + g.mergedIds.length, 0);
    if (mergedTotal + input.groups.length > MERGE_MANY_RECORDS) {
      throw new ValidationError(`At most ${MERGE_MANY_RECORDS} records per call`);
    }
    const seen = new Set<string>();
    for (const id of all) {
      if (seen.has(id)) throw new ValidationError(`${id} appears twice`, { id });
      seen.add(id);
    }

    // An AI actor's merges are reviewed as one titled change set.
    let changeSetId: string | null = null;
    if (ctx.actor !== "human") {
      const begun = (await nested(ctx, "changeset.begin", {
        title: mergeTitle(input.object, mergedTotal),
      })) as { changeSetId: string };
      changeSetId = begun.changeSetId;
    }

    const operation = `${input.object}.merge`;
    const results: z.infer<typeof mergeOutcomeSchema>[] = [];
    for (const group of input.groups) {
      const outcome: z.infer<typeof mergeOutcomeSchema> = {
        survivorId: group.survivorId,
        merged: [],
        queued: [],
        failed: [],
      };
      for (const mergedId of group.mergedIds) {
        try {
          await nested(ctx, operation, { survivorId: group.survivorId, mergedId });
          outcome.merged.push(mergedId);
        } catch (error) {
          if (error instanceof PendingApprovalError) {
            outcome.queued.push({ id: mergedId, pendingActionId: error.pending.actionId });
          } else {
            const typed =
              error instanceof OperationError
                ? error
                : new OperationError("internal", String(error));
            outcome.failed.push({ id: mergedId, code: typed.code, message: typed.message });
          }
        }
      }
      results.push(outcome);
    }

    if (changeSetId) {
      try {
        await nested(ctx, "changeset.commit", { changeSetId });
      } catch {
        // Nothing was queued (the policy applied every merge): the empty set stays open and
        // is committed by the session's next change set.
      }
    }
    const count = (key: "merged" | "queued" | "failed") =>
      results.reduce((n, r) => n + r[key].length, 0);
    return {
      results,
      merged: count("merged"),
      queued: count("queued"),
      failed: count("failed"),
      changeSetId,
    };
  },
  auditSummary: (output, input) => ({
    object: input.object,
    merged: output.merged,
    queued: output.queued,
    failed: output.failed,
    changeSetId: output.changeSetId,
  }),
});

// --- Scan and settings -------------------------------------------------------------------------

const scanStatusSchema = z.object({
  backfillDone: z.boolean(),
  fullScanRunning: z.boolean(),
  pending: z.boolean().describe("More work is waiting (the backfill, a full scan or a backlog)"),
  lastFullAt: z.string().nullable(),
  lastIncrementalAt: z.string().nullable(),
});

export const duplicateScan = defineOperation({
  name: "duplicate.scan",
  description:
    "Look for duplicates and store them for review (duplicate.list). incremental looks only at " +
    "records created or changed since the last scan (it runs nightly and after an import); " +
    "full (admins) looks at every record; continue carries on work in progress. Each call does " +
    "a bounded amount of work: call again while done is false. Records are not changed.",
  input: z.object({ mode: z.enum(["incremental", "full", "continue"]).default("incremental") }),
  output: z.object({
    ran: z.array(z.enum(["backfill", "full", "incremental"])),
    found: z.number().describe("Pairs found or confirmed in this call"),
    changed: z.number().describe("Changed records looked at in this call"),
    done: z.boolean(),
    status: scanStatusSchema,
  }),
  permission: "records:write",
  risk: "write",
  // It stores suggestions, never changes records.
  bookkeeping: true,
  async handler(input, ctx) {
    if (input.mode === "full" && !roleHasPermission(ctx.user.role, "settings:manage")) {
      throw new ForbiddenError("Only admins can run a full duplicate scan", {
        permission: "settings:manage",
      });
    }
    const result = await runScan(ctx, input.mode);
    return {
      ran: result.ran,
      found: result.found,
      changed: result.changed,
      done: result.done,
      status: statusOf(result.state),
    };
  },
});

function statusOf(state: Awaited<ReturnType<typeof loadScanState>>) {
  return {
    backfillDone: state.backfill.done,
    fullScanRunning: state.full !== null,
    pending: scanPending(state),
    lastFullAt: state.lastFullAt,
    lastIncrementalAt: state.lastIncrementalAt,
  };
}

export const duplicateSettings = defineOperation({
  name: "duplicate.settings",
  description:
    "The duplicate settings (how many people may share a phone number before it stops counting " +
    "as a match) and the scan's status: last full and incremental scans, and whether work is " +
    "in progress. Read-only.",
  input: z.object({}),
  output: z.object({ settings: duplicateSettingsSchema, status: scanStatusSchema }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(_input, ctx) {
    const [settings, state] = await Promise.all([
      loadDuplicateSettings(ctx.db),
      loadScanState(ctx.db),
    ]);
    return { settings, status: statusOf(state) };
  },
});

export const duplicateUpdateSettings = defineOperation({
  name: "duplicate.updateSettings",
  description:
    "Change the duplicate settings (admins): phoneShareLimit is how many people may hold the " +
    "same phone number before it stops counting for the same phone number rule (default 3), " +
    "so a shared office line does not flood suggestions. Takes effect at the next scan.",
  input: z.object({ phoneShareLimit: duplicateSettingsSchema.shape.phoneShareLimit.unwrap() }),
  output: duplicateSettingsSchema,
  permission: "settings:manage",
  risk: "write",
  async handler(input, ctx) {
    const before = await loadDuplicateSettings(ctx.db);
    const after = { ...before, phoneShareLimit: input.phoneShareLimit };
    const value = JSON.stringify(after);
    ctx.write(
      ctx.db
        .insertInto("core_settings")
        .values({
          key: DUPLICATE_SETTINGS_KEY,
          value,
          updated_at: ctx.now,
          updated_by: ctx.user.id,
        })
        .onConflict((oc) =>
          oc.column("key").doUpdateSet({ value, updated_at: ctx.now, updated_by: ctx.user.id }),
        ),
    );
    ctx.recordChange({
      object: "settings",
      id: DUPLICATE_SETTINGS_KEY,
      action: "update",
      before,
      after,
    });
    return after;
  },
});

export const duplicateOperations = [
  duplicateCheck,
  duplicateList,
  duplicateCount,
  duplicateDismiss,
  duplicateMergeMany,
  duplicateScan,
  duplicateSettings,
  duplicateUpdateSettings,
] as const;
