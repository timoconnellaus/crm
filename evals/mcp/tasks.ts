// The 20 natural-language CRM tasks of the stage 2 MCP eval (docs/stages/02-mcp.md, criterion 11).
//
// Each task creates its own fixture over the harness's setup connection, with names made unique
// per run by a generated word (fixture.suffix, e.g. "Varodin"), so the tasks do not depend on the
// seed data and repeated runs do not see each other's records. Grading is three-part: tool choice
// (expectTools / forbidTools / forbidSuccess, see lib/grading.ts), the reply (expectText,
// expectReason), and an outcome check that reads the CRM afterwards.
//
// Approval: these tasks assume the org preset is Balanced (the default). For MCP that means single
// creates and updates apply, while bulk writes, deletes and merges are queued for approval.

import { callMatches, succeeded } from "./lib/grading.ts";
import { addDays, type CheckContext, type EvalTask } from "./lib/harness.ts";

type Row = Record<string, unknown>;

const PENDING_TEXT = {
  pattern: /approv|pending|review|queued/i,
  why: "tell the user the change is waiting for approval",
};

const digits = (value: unknown) => String(value ?? "").replace(/\D/g, "");

async function activitiesOn(ctx: CheckContext, recordId: string, type: string): Promise<Row[]> {
  return ctx.sql(
    `SELECT a.id, a.type, a.subject, a.body, a.payload, a.occurred_at
       FROM crm_activities a JOIN crm_activity_links l ON l.activity_id = a.id
      WHERE l.record_id = ? AND a.type = ?`,
    [recordId, type],
  );
}

async function tasksOn(ctx: CheckContext, recordId: string): Promise<Row[]> {
  return ctx.sql(
    `SELECT t.* FROM crm_tasks t JOIN crm_task_links l ON l.task_id = t.id
      WHERE l.record_id = ?`,
    [recordId],
  );
}

async function personLive(ctx: CheckContext, id: string | undefined): Promise<boolean> {
  return (await ctx.sql("SELECT id FROM crm_people WHERE id = ?", [id])).length === 1;
}

interface ActionView {
  operation: string;
  status: string;
  input: Record<string, unknown>;
}

/** Pending actions for `operation` in the agent's own MCP session. */
async function pendingActions(ctx: CheckContext, operation: string): Promise<ActionView[]> {
  const { isError, data } = await ctx.agentCall("approval_status", {});
  if (isError) throw new Error(`approval_status failed: ${JSON.stringify(data)}`);
  const sets = (data as { changeSets?: { actions?: ActionView[] }[] }).changeSets ?? [];
  return sets
    .flatMap((s) => s.actions ?? [])
    .filter((a) => a.operation === operation && a.status === "pending");
}

/** Completes open tasks linked to `recordId`, so they do not pile up in the eval user's list. */
async function completeTasksOn(ctx: CheckContext, recordId: string | undefined) {
  if (!recordId) return;
  for (const task of await tasksOn(ctx, recordId)) {
    if (task.status === "open")
      await ctx.adminCall("task_complete", { id: task.id, reason: "eval cleanup" });
  }
}

const fail = (condition: boolean, message: string) => (condition ? [message] : []);

export const tasks: EvalTask[] = [
  {
    id: "search-before-create",
    title: "Search before creating: the contact already exists",
    covers: ["search-before-create", "no duplicates"],
    async setup(s) {
      const personId = await s.person({
        givenName: "Priya",
        familyName: s.suffix,
        emails: [{ email: `priya@${s.slug}.example` }],
        location: "Lisbon, Portugal",
      });
      return { personId };
    },
    prompts: (f) => [
      `Please add Priya ${f.suffix} to the CRM as a new contact. She's a procurement lead based in Lisbon.`,
    ],
    expectTools: [{ anyOf: ["search_global", "op:person.list", "query_sql", "person_get"] }],
    expectText: [
      { pattern: /already|existing|exists|found/i, why: "say Priya is already in the CRM" },
    ],
    async check(ctx) {
      const rows = await ctx.sql(
        "SELECT id FROM crm_people WHERE given_name = 'Priya' AND family_name = ?",
        [ctx.fixture.suffix],
      );
      return fail(
        rows.length !== 1,
        `expected exactly one Priya ${ctx.fixture.suffix}, found ${rows.length}`,
      );
    },
  },
  {
    id: "create-person",
    title: "Create a person with email, phone and location",
    covers: ["person.create"],
    prompts: (f) => [
      `Create a contact for Tomas ${f.suffix}: email tomas@${f.slug}-herrera.example, phone +34 911 234 567, based in Madrid, Spain.`,
    ],
    expectTools: ["person_create"],
    async check(ctx) {
      const rows = await ctx.sql("SELECT * FROM crm_people WHERE primary_email = ?", [
        `tomas@${ctx.fixture.slug}-herrera.example`,
      ]);
      const person = rows[0];
      if (rows.length !== 1 || !person)
        return [`expected one person with that email, found ${rows.length}`];
      return [
        ...fail(
          !String(person.display_name).includes(ctx.fixture.suffix as string),
          "name is wrong",
        ),
        ...fail(!/madrid/i.test(String(person.location)), `location is ${person.location}`),
        ...fail(
          !digits(person.primary_phone).endsWith("911234567"),
          `phone is ${person.primary_phone}`,
        ),
      ];
    },
  },
  {
    id: "update-person",
    title: "Update a person, giving a specific reason",
    covers: ["person.update", "reasons"],
    async setup(s) {
      const personId = await s.person({
        givenName: "Grace",
        familyName: s.suffix,
        location: "Mombasa, Kenya",
        phones: [{ number: "+254 41 200 0000", label: "mobile" }],
      });
      return { personId };
    },
    prompts: (f) => [
      `Grace ${f.suffix} emailed me on Monday to say she has moved to Nairobi and her new mobile is +254 20 765 4321. Please update her record.`,
    ],
    expectTools: ["person_update"],
    expectReason: [
      { tool: "person_update", pattern: /email/i, why: "say the change came from Grace's email" },
    ],
    async check(ctx) {
      const { data } = await ctx.adminCall("person_get", { id: ctx.fixture.personId });
      const person = data as { location?: string; phones?: { number: string }[] };
      return [
        ...fail(!/nairobi/i.test(person.location ?? ""), `location is ${person.location}`),
        ...fail(
          !(person.phones ?? []).some((p) => digits(p.number).endsWith("207654321")),
          "the new mobile number is missing",
        ),
      ];
    },
  },
  {
    id: "create-organisation",
    title: "Create an organisation with domain and industry",
    covers: ["organisation.create"],
    prompts: (f) => [
      `Add the company ${f.suffix} Biotics to the CRM. Their domain is ${f.slug}-biotics.example and they're in the biotech industry.`,
    ],
    expectTools: ["organisation_create"],
    async check(ctx) {
      const rows = await ctx.sql("SELECT * FROM crm_organisations WHERE name LIKE ?", [
        `%${ctx.fixture.suffix} Biotics%`,
      ]);
      const org = rows[0];
      if (rows.length !== 1 || !org) return [`expected one organisation, found ${rows.length}`];
      return [
        ...fail(
          org.primary_domain !== `${ctx.fixture.slug}-biotics.example`,
          `domain is ${org.primary_domain}`,
        ),
        ...fail(!/biotech/i.test(String(org.industry)), `industry is ${org.industry}`),
      ];
    },
  },
  {
    id: "change-job",
    title: "Record a job change",
    covers: ["person.changeJob"],
    async setup(s) {
      const oldOrgId = await s.organisation({ name: `${s.words[2]} Logistics` });
      const newOrgId = await s.organisation({ name: `${s.words[1]} Systems` });
      const personId = await s.person({ givenName: "Omar", familyName: s.suffix });
      await s.call("person_changeJob", {
        personId,
        organisationId: oldOrgId,
        title: "Senior Engineer",
      });
      return {
        personId,
        oldOrgId,
        newOrgId,
        newOrg: `${s.words[1]} Systems`,
        oldOrg: `${s.words[2]} Logistics`,
      };
    },
    prompts: (f) => [
      `Omar ${f.suffix} has left ${f.oldOrg}. He just started at ${f.newOrg} as Head of Platform. Please update the CRM.`,
    ],
    expectTools: ["op:person.changeJob"],
    async check(ctx) {
      const [person] = await ctx.sql("SELECT * FROM crm_people WHERE id = ?", [
        ctx.fixture.personId,
      ]);
      const old = await ctx.sql(
        "SELECT is_current FROM crm_affiliations WHERE person_id = ? AND organisation_id = ?",
        [ctx.fixture.personId, ctx.fixture.oldOrgId],
      );
      return [
        ...fail(
          person?.organisation_id !== ctx.fixture.newOrgId,
          "current organisation is not the new one",
        ),
        ...fail(
          !/head of platform/i.test(String(person?.job_title)),
          `job title is ${person?.job_title}`,
        ),
        ...fail(
          old.some((a) => a.is_current === 1),
          "the old job is still current",
        ),
      ];
    },
  },
  {
    id: "log-call",
    title: "Log a call with duration and content",
    covers: ["activity.log (call)"],
    async setup(s) {
      return { personId: await s.person({ givenName: "Lena", familyName: s.suffix }) };
    },
    prompts: (f) => [
      `I just got off a 20-minute call with Lena ${f.suffix}. She wants a quote for 50 seats by Friday. Log the call on her record.`,
    ],
    expectTools: ["activity_log"],
    async check(ctx) {
      const calls = await activitiesOn(ctx, ctx.fixture.personId as string, "call");
      const call = calls[0];
      if (!call) return ["no call activity linked to Lena"];
      const payload = JSON.parse(String(call.payload ?? "{}")) as { durationSeconds?: number };
      return [
        ...fail(
          !/50/.test(`${call.subject} ${call.body}`),
          "the call does not mention the 50 seats",
        ),
        ...fail(
          Math.abs((payload.durationSeconds ?? 0) - 1200) > 60,
          `durationSeconds is ${payload.durationSeconds}, expected 1200`,
        ),
      ];
    },
  },
  {
    id: "log-note-organisation",
    title: "Add a note to an organisation",
    covers: ["activity.log (note)"],
    async setup(s) {
      return { orgId: await s.organisation({ name: `${s.suffix} Freight` }) };
    },
    prompts: (f) => [
      `Add a note to ${f.suffix} Freight: they're moving to a new ERP in Q2 and want an integration demo before then.`,
    ],
    expectTools: ["activity_log"],
    async check(ctx) {
      const notes = await activitiesOn(ctx, ctx.fixture.orgId as string, "note");
      return fail(
        !notes.some((n) => /ERP/i.test(String(n.body))),
        "no note about the ERP on the organisation",
      );
    },
  },
  {
    id: "log-meeting",
    title: "Log yesterday's meeting with two people",
    covers: ["activity.log (meeting)", "multiple links", "relative dates"],
    async setup(s) {
      const orgId = await s.organisation({ name: `${s.suffix} Water` });
      const inesId = await s.person({ givenName: "Ines", familyName: s.words[1] });
      const kwameId = await s.person({ givenName: "Kwame", familyName: s.words[2] });
      for (const personId of [inesId, kwameId]) {
        await s.call("person_changeJob", { personId, organisationId: orgId, title: "Procurement" });
      }
      return { orgId, inesId, kwameId, ines: `Ines ${s.words[1]}`, kwame: `Kwame ${s.words[2]}` };
    },
    prompts: (f) => [
      `Log a meeting I had yesterday from 15:00 to 16:00 UTC with ${f.ines} and ${f.kwame} from ${f.suffix} Water about their contract renewal.`,
    ],
    expectTools: ["activity_log"],
    async check(ctx) {
      const yesterday = addDays(ctx.fixture.today as string, -1);
      const ines = await activitiesOn(ctx, ctx.fixture.inesId as string, "meeting");
      const kwame = await activitiesOn(ctx, ctx.fixture.kwameId as string, "meeting");
      const shared = ines.filter((a) => kwame.some((b) => b.id === a.id));
      const meeting = shared[0];
      if (!meeting) return ["no single meeting linked to both people"];
      const payload = JSON.parse(String(meeting.payload ?? "{}")) as { startsAt?: string };
      const when = `${meeting.occurred_at} ${payload.startsAt ?? ""}`;
      return fail(
        !when.includes(yesterday),
        `the meeting is not dated ${yesterday} (${when.trim()})`,
      );
    },
  },
  {
    id: "timeline",
    title: "Summarise a record's timeline",
    covers: ["activity.listForRecord"],
    async setup(s) {
      const personId = await s.person({ givenName: "Yuki", familyName: s.suffix });
      await s.call("activity_log", {
        type: "note",
        body: "Agreed to run a 6-week pilot in Rotterdam starting in January.",
        occurredAt: `${addDays(s.today, -3)}T10:00:00.000Z`,
        links: [{ object: "person", id: personId }],
      });
      await s.call("activity_log", {
        type: "call",
        subject: "Pricing questions about the enterprise tier",
        payload: { direction: "outbound", durationSeconds: 600 },
        links: [{ object: "person", id: personId }],
      });
      return { personId };
    },
    prompts: (f) => [
      `What's been happening with Yuki ${f.suffix}? Give me a quick summary of their timeline.`,
    ],
    expectTools: [{ anyOf: ["activity_listForRecord", "op:activity.list", "query_sql"] }],
    expectText: [{ pattern: /rotterdam/i, why: "mention the Rotterdam pilot from the timeline" }],
  },
  {
    id: "create-task",
    title: "Create a dated task linked to a person",
    covers: ["task.create"],
    async setup(s) {
      return {
        personId: await s.person({ givenName: "Felix", familyName: s.suffix }),
        due: addDays(s.today, 14),
      };
    },
    prompts: (f) => [`Remind me to send Felix ${f.suffix} the signed contract on ${f.due}.`],
    expectTools: ["task_create"],
    async check(ctx) {
      const tasks = await tasksOn(ctx, ctx.fixture.personId as string);
      const task = tasks.find((t) => t.status === "open");
      if (!task) return ["no open task linked to Felix"];
      return [
        ...fail(!String(task.due_at).startsWith(ctx.fixture.due as string), `due ${task.due_at}`),
        ...fail(task.assignee_id !== task.created_by, "the task is not assigned to the user"),
      ];
    },
    cleanup: (ctx) => completeTasksOn(ctx, ctx.fixture.personId),
  },
  {
    id: "complete-task",
    title: "Complete the right task",
    covers: ["task.complete"],
    async setup(s) {
      const personId = await s.person({ givenName: "Marta", familyName: s.suffix });
      const links = [{ object: "person", id: personId }];
      const target = await s.call("task_create", {
        title: `Send Marta ${s.suffix} the onboarding pack`,
        dueAt: s.today,
        links,
      });
      const other = await s.call("task_create", {
        title: `Book a follow-up call with Marta ${s.suffix}`,
        dueAt: addDays(s.today, 7),
        links,
      });
      return { personId, targetId: String(target.id), otherId: String(other.id) };
    },
    prompts: (f) => [
      `I've sent Marta ${f.suffix} the onboarding pack, so please tick that task off.`,
    ],
    expectTools: ["task_complete"],
    async check(ctx) {
      const rows = await ctx.sql("SELECT id, status FROM crm_tasks WHERE id IN (?, ?)", [
        ctx.fixture.targetId,
        ctx.fixture.otherId,
      ]);
      const status = (id: unknown) => rows.find((r) => r.id === id)?.status;
      return [
        ...fail(status(ctx.fixture.targetId) !== "done", "the onboarding-pack task is not done"),
        ...fail(status(ctx.fixture.otherId) !== "open", "the follow-up task was completed too"),
      ];
    },
    cleanup: (ctx) => completeTasksOn(ctx, ctx.fixture.personId),
  },
  {
    id: "my-tasks",
    title: "List my overdue and due-today tasks",
    covers: ["task.listMine (long tail)", "describe_operations / call_operation"],
    async setup(s) {
      const personId = await s.person({ givenName: "Ruth", familyName: s.suffix });
      const links = [{ object: "person", id: personId }];
      await s.call("task_create", {
        title: `Renew the ${s.suffix} insurance certificate`,
        dueAt: addDays(s.today, -2),
        links,
      });
      await s.call("task_create", {
        title: `Call Ruth ${s.suffix} about the pilot`,
        dueAt: s.today,
        links,
      });
      return { personId };
    },
    prompts: () => ["What's on my plate? List my open tasks that are overdue or due today."],
    expectTools: [{ anyOf: ["op:task.listMine", "task_list", "query_sql"] }],
    expectText: [
      { pattern: /insurance certificate/i, why: "list the overdue insurance-certificate task" },
      { pattern: /about the pilot/i, why: "list the call-about-the-pilot task due today" },
    ],
    cleanup: (ctx) => completeTasksOn(ctx, ctx.fixture.personId),
  },
  {
    id: "sql-aggregate",
    title: "Answer an aggregate question with query_sql",
    covers: ["query.sql"],
    async setup(s) {
      const orgId = await s.organisation({ name: `${s.suffix} Quarry` });
      const people: string[] = [];
      for (const given of ["Ana", "Ben", "Cara", "Dev"]) {
        const personId = await s.person({ givenName: given, familyName: s.suffix });
        await s.call("person_changeJob", { personId, organisationId: orgId, title: "Analyst" });
        people.push(personId);
      }
      const log = (type: string, personId: string | undefined, text: string) =>
        s.call("activity_log", {
          type,
          ...(type === "note"
            ? { body: text }
            : { subject: text, payload: { direction: "outbound" } }),
          links: [{ object: "person", id: personId }],
        });
      await log("note", people[0], "Interested in the analytics add-on");
      await log("note", people[0], "Asked for a security questionnaire");
      await log("call", people[1], "Intro call");
      await log("call", people[1], "Follow-up on pricing");
      await log("note", people[2], "Prefers email over phone");
      return { orgId };
    },
    prompts: (f) => [
      `How many people currently work at ${f.suffix} Quarry, and how many notes and calls in total have been logged against them?`,
    ],
    expectTools: ["query_sql"],
    expectText: [
      { pattern: /\b(4|four)\b/i, why: "give 4 current people" },
      { pattern: /\b(5|five)\b/i, why: "give 5 notes and calls" },
    ],
  },
  {
    id: "bulk-update",
    title: "Bulk update goes to approval",
    covers: ["person.updateMany (long tail)", "pending_approval", "telling the user"],
    async setup(s) {
      const ids: string[] = [];
      for (const given of ["Alma", "Bruno", "Chloe", "Dmitri", "Elif", "Farid"]) {
        ids.push(
          await s.person({
            givenName: given,
            familyName: s.suffix,
            location: "London, UK",
            tags: [`offsite-${s.slug}`],
          }),
        );
      }
      return { ids: ids.join(",") };
    },
    prompts: (f) => [
      `Everyone tagged offsite-${f.slug} has relocated to Berlin. Update their location to Berlin in one bulk change so it can be reviewed together.`,
    ],
    expectTools: ["op:person.updateMany"],
    expectText: [PENDING_TEXT],
    async check(ctx) {
      const ids = (ctx.fixture.ids as string).split(",");
      const pending = await pendingActions(ctx, "person.updateMany");
      const queued = new Set(pending.flatMap((a) => (a.input.ids as string[] | undefined) ?? []));
      const rows = await ctx.sql(
        `SELECT location FROM crm_people WHERE id IN (${ids.map(() => "?").join(",")})`,
        ids,
      );
      return [
        ...fail(
          !ids.every((id) => queued.has(id)),
          "not every tagged person is in a pending bulk update",
        ),
        ...fail(
          !rows.every((r) => /london/i.test(String(r.location))),
          "a location changed without approval",
        ),
      ];
    },
  },
  {
    id: "merge",
    title: "Merge duplicates (queued for approval)",
    covers: ["person.merge (long tail)", "pending_approval", "reasons"],
    async setup(s) {
      const survivorId = await s.person({
        givenName: "Daniel",
        familyName: s.suffix,
        emails: [{ email: `daniel@${s.slug}-a.example` }],
        location: "Seoul",
      });
      const mergedId = await s.person({
        givenName: "Dan",
        familyName: s.suffix,
        emails: [{ email: `dan@${s.slug}-b.example` }],
      });
      return { survivorId, mergedId };
    },
    prompts: (f) => [
      `Daniel ${f.suffix} and Dan ${f.suffix} are the same person. Merge them, keeping Daniel's record.`,
    ],
    expectTools: ["op:person.merge"],
    expectText: [PENDING_TEXT],
    expectReason: [
      {
        tool: "op:person.merge",
        pattern: /same|duplicate/i,
        why: "say the records are duplicates",
      },
    ],
    async check(ctx) {
      const pending = await pendingActions(ctx, "person.merge");
      const right = pending.some(
        (a) =>
          a.input.survivorId === ctx.fixture.survivorId &&
          a.input.mergedId === ctx.fixture.mergedId,
      );
      return [
        ...fail(!right, "no pending merge of Dan into Daniel"),
        ...fail(!(await personLive(ctx, ctx.fixture.mergedId)), "Dan was merged without approval"),
      ];
    },
  },
  {
    id: "trash-person",
    title: "Move a person to Trash via call_operation",
    covers: [
      "person.delete (long tail)",
      "describe_operations / call_operation",
      "pending_approval",
    ],
    async setup(s) {
      return { personId: await s.person({ givenName: "Hugo", familyName: s.suffix }) };
    },
    prompts: (f) => [`Hugo ${f.suffix} has left the industry. Move his record to the trash.`],
    expectTools: ["op:person.delete"],
    expectText: [PENDING_TEXT],
    async check(ctx) {
      const pending = await pendingActions(ctx, "person.delete");
      return [
        ...fail(
          !pending.some((a) => a.input.id === ctx.fixture.personId),
          "no pending delete for Hugo",
        ),
        ...fail(
          !(await personLive(ctx, ctx.fixture.personId)),
          "Hugo was deleted without approval",
        ),
      ];
    },
  },
  {
    id: "change-history",
    title: "Read a record's change history",
    covers: ["audit.listForRecord (long tail)"],
    async setup(s) {
      const personId = await s.person({
        givenName: "Zoe",
        familyName: s.suffix,
        location: "Oslo, Norway",
      });
      await s.call("person_update", { id: personId, location: "Bergen, Norway" });
      return { personId };
    },
    prompts: (f) => [
      `Zoe ${f.suffix}'s location looks different from what I remember. What was it before the last change, and when did it change?`,
    ],
    expectTools: [{ anyOf: ["op:audit.listForRecord", "op:audit.list", "activity_listForRecord"] }],
    expectText: [{ pattern: /oslo/i, why: "say the location used to be Oslo" }],
  },
  {
    id: "changeset",
    title: "Group a multi-step task in a change set",
    covers: ["changeset.begin", "changeset.commit", "person.create", "activity.log"],
    async setup(s) {
      return {
        ravi: `Ravi ${s.words[0]}`,
        sofia: `Sofia ${s.words[1]}`,
        liam: `Liam ${s.words[2]}`,
      };
    },
    prompts: (f) => [
      `I met three people at the ${f.suffix} Fintech Forum: ${f.ravi} (ravi@${f.slug}-pay.example), ${f.sofia} (sofia@${f.slug}-pay.example) and ${f.liam} (liam@${f.slug}-pay.example). Add them as contacts and log a note on each saying we met at the forum. Group all of it as one change set for review.`,
    ],
    expectTools: ["changeset_begin", "changeset_commit", "person_create", "activity_log"],
    async check(ctx) {
      const failures: string[] = [];
      for (const name of ["ravi", "sofia", "liam"]) {
        const [person] = await ctx.sql("SELECT id FROM crm_people WHERE primary_email = ?", [
          `${name}@${ctx.fixture.slug}-pay.example`,
        ]);
        if (!person) failures.push(`${name} was not created`);
        else if (!(await activitiesOn(ctx, person.id as string, "note")).length) {
          failures.push(`no note on ${name}`);
        }
      }
      const calls = ctx.run.calls.filter(succeeded);
      const index = (token: string) => calls.findIndex((c) => callMatches(token, c));
      const lastIndex = (token: string) => calls.findLastIndex((c) => callMatches(token, c));
      const lastWrite = Math.max(lastIndex("person_create"), lastIndex("activity_log"));
      if (index("changeset_begin") > index("person_create")) {
        failures.push("changeset_begin came after the first person_create");
      }
      if (lastIndex("changeset_commit") < lastWrite)
        failures.push("changeset_commit came before the last write");
      const begin = calls.find((c) => c.name === "changeset_begin");
      if (begin && !/forum|fintech/i.test(String(begin.input.title))) {
        failures.push(`change set title "${begin.input.title}" does not name the forum`);
      }
      return failures;
    },
  },
  {
    id: "approval-follow-up",
    title: "Follow up on a queued change with approval_status",
    covers: ["organisation.delete (long tail)", "approval.status", "multi-turn"],
    async setup(s) {
      return {
        orgId: await s.organisation({ name: `${s.suffix} Holdings`, description: "Test record" }),
      };
    },
    prompts: (f) => [
      `Please delete the organisation ${f.suffix} Holdings. It was a test record.`,
      "Has that deletion gone through yet?",
    ],
    expectTools: ["op:organisation.delete", "approval_status"],
    expectText: [
      {
        pattern: /not yet|pending|waiting|awaiting|hasn.t|has not/i,
        why: "say it is still waiting for approval",
      },
    ],
    async check(ctx) {
      const followedUp = ctx.run.calls.some(
        (c) => c.promptIndex === 1 && c.name === "approval_status" && !c.isError,
      );
      const live = await ctx.sql("SELECT id FROM crm_organisations WHERE id = ?", [
        ctx.fixture.orgId,
      ]);
      return [
        ...fail(!followedUp, "approval_status was not checked when the user asked"),
        ...fail(live.length !== 1, "the organisation was deleted without approval"),
      ];
    },
  },
  {
    id: "hidden-erase",
    title: "A hidden operation (erase) cannot be done over MCP",
    covers: ["hidden operations", "refusal"],
    async setup(s) {
      return {
        personId: await s.person({
          givenName: "Nora",
          familyName: s.suffix,
          emails: [{ email: `nora@${s.slug}.example` }],
        }),
      };
    },
    prompts: (f) => [
      `Nora ${f.suffix} has sent a GDPR erasure request. Permanently erase all of her data from the CRM now.`,
    ],
    forbidSuccess: ["op:person.erase"],
    forbidTools: ["op:person.delete"],
    expectText: [
      {
        pattern:
          /can(no|['’])t|unable|not (available|able|possible|permitted|allowed|exposed)|admin|in the (app|CRM)/i,
        why: "explain that erasure has to be done by a person in the CRM",
      },
    ],
    async check(ctx) {
      const pending = [
        ...(await pendingActions(ctx, "person.erase")),
        ...(await pendingActions(ctx, "person.delete")),
      ];
      return [
        ...fail(!(await personLive(ctx, ctx.fixture.personId)), "Nora is no longer live"),
        ...fail(pending.length > 0, "an erase or delete was queued"),
      ];
    },
  },
];
