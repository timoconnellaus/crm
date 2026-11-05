// setup.* and sample.* operations: the first-run setup wizard (ADR 0167).
//
// The wizard's state is one row (core_setup, migration 0161): pending on a fresh install, then
// in_progress with the step reached and the answers so far (resumable), then completed or skipped.
// Each step's real change goes through its own operation (settings.update, policy.update, …);
// these operations only track progress, and install or remove the sample data.
//
// Sample data is created through the ordinary record operations (so it is audited and searchable
// like anything else) and remembered in core_sample_records, so "Remove sample data" erases
// exactly those records and nothing a person added.
import { z } from "zod";
import { ConflictError } from "../errors.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";

export const SETUP_STEPS = ["admin", "organisation", "ai", "policy", "connect", "sample"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

const statusSchema = z.enum(["pending", "in_progress", "completed", "skipped"]);
const setupOutput = z.object({
  status: statusSchema,
  step: z.enum(SETUP_STEPS),
  /** Answers so far (non-secret), e.g. { organisation: true, policy: "balanced" }. */
  data: z.record(z.string(), z.unknown()),
  /** True while the wizard should open on an admin's first visit. */
  open: z.boolean(),
  sampleRecords: z
    .number()
    .int()
    .describe("Records 'Install sample data' created that still exist"),
});

async function loadSetup(ctx: Pick<HandlerContext, "db">) {
  const row = await ctx.db
    .selectFrom("core_setup")
    .selectAll()
    .where("id", "=", 1)
    .executeTakeFirst();
  const samples = await ctx.db
    .selectFrom("core_sample_records")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .executeTakeFirst();
  const status = row?.status ?? "skipped";
  let data: Record<string, unknown> = {};
  try {
    data = row ? (JSON.parse(row.data) as Record<string, unknown>) : {};
  } catch {}
  const step = (SETUP_STEPS as readonly string[]).includes(row?.step ?? "")
    ? (row?.step as SetupStep)
    : "admin";
  return {
    status,
    step,
    data,
    open: status === "pending" || status === "in_progress",
    sampleRecords: Number(samples?.n ?? 0),
  };
}

function writeSetup(
  ctx: HandlerContext,
  values: { status: z.infer<typeof statusSchema>; step: SetupStep; data: Record<string, unknown> },
) {
  const row = {
    status: values.status,
    step: values.step,
    data: JSON.stringify(values.data),
    updated_at: ctx.now,
    updated_by: ctx.user.id,
    completed_at: values.status === "completed" || values.status === "skipped" ? ctx.now : null,
  };
  ctx.write(
    ctx.db
      .insertInto("core_setup")
      .values({ id: 1, ...row })
      .onConflict((oc) => oc.column("id").doUpdateSet(row)),
  );
}

export const setupStatus = defineOperation({
  name: "setup.status",
  description:
    "The first-run setup wizard's progress: pending, in progress (with the step reached), " +
    "completed or skipped, and how many sample records are installed. Read-only.",
  input: z.object({}),
  output: setupOutput,
  permission: "records:read",
  risk: "read",
  mcp: { expose: false },
  async handler(_input, ctx) {
    return loadSetup(ctx);
  },
});

export const setupSave = defineOperation({
  name: "setup.save",
  description:
    "Record the wizard's progress: the step reached and non-secret answers so far, so it can be " +
    "resumed later. Human admins only.",
  input: z.object({
    step: z.enum(SETUP_STEPS),
    data: z.record(z.string(), z.unknown()).optional(),
  }),
  output: setupOutput,
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  bookkeeping: true,
  async handler(input, ctx) {
    const before = await loadSetup(ctx);
    const data = { ...before.data, ...(input.data ?? {}) };
    if (JSON.stringify(data).length > 20_000)
      throw new ConflictError("Setup answers are too large");
    const status: z.infer<typeof statusSchema> =
      before.status === "completed" ? "completed" : "in_progress";
    writeSetup(ctx, { status, step: input.step, data });
    return { ...before, status, step: input.step, data, open: status === "in_progress" };
  },
});

export const setupFinish = defineOperation({
  name: "setup.finish",
  description:
    "Close the setup wizard: completed (every step done) or skipped (the admin chose to set up " +
    "later; Settings → General can reopen it). Human admins only.",
  input: z.object({ outcome: z.enum(["completed", "skipped"]) }),
  output: setupOutput,
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const before = await loadSetup(ctx);
    writeSetup(ctx, { status: input.outcome, step: before.step, data: before.data });
    ctx.recordChange({
      object: "settings",
      id: "setup",
      action: "update",
      before: { status: before.status },
      after: { status: input.outcome },
    });
    return { ...before, status: input.outcome, open: false };
  },
});

export const setupRestart = defineOperation({
  name: "setup.restart",
  description:
    "Open the setup wizard again from the first step, keeping earlier answers. Human admins only.",
  input: z.object({}),
  output: setupOutput,
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(_input, ctx) {
    const before = await loadSetup(ctx);
    writeSetup(ctx, { status: "in_progress", step: "admin", data: before.data });
    return { ...before, status: "in_progress" as const, step: "admin" as const, open: true };
  },
});

// --- Sample data ---------------------------------------------------------------------------------

const SAMPLE_ORGANISATIONS = [
  {
    key: "acme",
    name: "Acme Robotics (sample)",
    domain: "acme-robotics.example",
    industry: "Manufacturing",
  },
  {
    key: "globex",
    name: "Globex Logistics (sample)",
    domain: "globex.example",
    industry: "Logistics",
  },
  {
    key: "initech",
    name: "Initech Software (sample)",
    domain: "initech.example",
    industry: "Software",
  },
] as const;

const SAMPLE_PEOPLE = [
  { given: "Ada", family: "Moreno", org: "acme", title: "Head of Operations" },
  { given: "Ben", family: "Okafor", org: "acme", title: "Procurement Lead" },
  { given: "Chloe", family: "Tanaka", org: "globex", title: "COO" },
  { given: "Dev", family: "Patel", org: "globex", title: "Fleet Manager" },
  { given: "Elena", family: "Novak", org: "initech", title: "CTO" },
  { given: "Femi", family: "Adeyemi", org: "initech", title: "Engineering Manager" },
] as const;

const SAMPLE_TASKS = [
  { title: "Send Acme the pilot proposal (sample)", person: 0, days: 2 },
  { title: "Book a demo with Globex (sample)", person: 2, days: 5 },
  { title: "Follow up with Elena about security review (sample)", person: 4, days: 7 },
] as const;

export const sampleInstall = defineOperation({
  name: "sample.install",
  description:
    "Add a small set of sample organisations, people and tasks (marked '(sample)') to explore " +
    "the CRM with. sample.remove deletes exactly these. Human admins only.",
  input: z.object({}),
  output: z.object({ organisations: z.number(), people: z.number(), tasks: z.number() }),
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(_input, ctx) {
    const existing = await loadSetup(ctx);
    if (existing.sampleRecords > 0) throw new ConflictError("Sample data is already installed");
    const nested = { actor: ctx.actor, user: ctx.user, origin: ctx.origin };
    const created: { object: string; id: string }[] = [];
    const orgIds = new Map<string, string>();
    for (const org of SAMPLE_ORGANISATIONS) {
      const result = (await ctx.pipeline.invoke(
        "organisation.create",
        { name: org.name, domains: [{ domain: org.domain }], industry: org.industry },
        nested,
      )) as { id: string };
      orgIds.set(org.key, result.id);
      created.push({ object: "organisation", id: result.id });
    }
    const personIds: string[] = [];
    for (const person of SAMPLE_PEOPLE) {
      const domain = SAMPLE_ORGANISATIONS.find((o) => o.key === person.org)?.domain;
      const result = (await ctx.pipeline.invoke(
        "person.create",
        {
          givenName: person.given,
          familyName: person.family,
          emails: [{ email: `${person.given.toLowerCase()}@${domain}` }],
          description: "Sample data: remove it from Settings → General → Sample data.",
        },
        nested,
      )) as { id: string };
      personIds.push(result.id);
      created.push({ object: "person", id: result.id });
      await ctx.pipeline.invoke(
        "affiliation.create",
        { personId: result.id, organisationId: orgIds.get(person.org), title: person.title },
        nested,
      );
    }
    const today = new Date(ctx.now);
    for (const task of SAMPLE_TASKS) {
      const due = new Date(today.getTime() + task.days * 86_400_000).toISOString().slice(0, 10);
      const result = (await ctx.pipeline.invoke(
        "task.create",
        {
          title: task.title,
          dueAt: due,
          links: [{ object: "person", id: personIds[task.person] }],
        },
        nested,
      )) as { id: string };
      created.push({ object: "task", id: result.id });
    }
    for (const record of created) {
      ctx.write(
        ctx.db
          .insertInto("core_sample_records")
          .values({ object_type: record.object, record_id: record.id, created_at: ctx.now }),
      );
    }
    return {
      organisations: SAMPLE_ORGANISATIONS.length,
      people: SAMPLE_PEOPLE.length,
      tasks: SAMPLE_TASKS.length,
    };
  },
});

export const sampleRemove = defineOperation({
  name: "sample.remove",
  description:
    "Permanently delete the sample data sample.install added (and nothing else), with whatever " +
    "was linked only to it. Human admins only.",
  input: z.object({}),
  output: z.object({ removed: z.number() }),
  permission: "settings:manage",
  risk: "destructive",
  actors: ["human"],
  mcp: { expose: false },
  async handler(_input, ctx) {
    const rows = await ctx.db.selectFrom("core_sample_records").selectAll().execute();
    const nested = { actor: ctx.actor, user: ctx.user, origin: ctx.origin };
    const live = async (table: "core_person" | "core_organisation" | "core_task", id: string) =>
      Boolean(await ctx.db.selectFrom(table).select("id").where("id", "=", id).executeTakeFirst());
    let removed = 0;
    // Tasks first (a person's erase may take its tasks with it), then people, then organisations.
    for (const row of rows.filter((r) => r.object_type === "task")) {
      if (await live("core_task", row.record_id)) {
        const task = await ctx.db
          .selectFrom("core_task")
          .select("deleted_at")
          .where("id", "=", row.record_id)
          .executeTakeFirst();
        if (!task?.deleted_at)
          await ctx.pipeline.invoke("task.delete", { id: row.record_id }, nested);
        removed += 1;
      }
    }
    for (const row of rows.filter((r) => r.object_type === "person")) {
      if (await live("core_person", row.record_id)) {
        await ctx.pipeline.invoke("person.erase", { id: row.record_id }, nested);
        removed += 1;
      }
    }
    for (const row of rows.filter((r) => r.object_type === "organisation")) {
      if (await live("core_organisation", row.record_id)) {
        await ctx.pipeline.invoke("organisation.erase", { id: row.record_id }, nested);
        removed += 1;
      }
    }
    ctx.write(ctx.db.deleteFrom("core_sample_records"));
    return { removed };
  },
});

export const setupOperations = [
  setupStatus,
  setupSave,
  setupFinish,
  setupRestart,
  sampleInstall,
  sampleRemove,
] as const;
