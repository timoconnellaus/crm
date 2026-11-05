// Embeddings (ADR 0154): queued in the same batch as a change, embedded only when the text's hash
// changes, deleted when the record is deleted, made private or erased (ADR 0019), and never made
// for private or metadata-only synced activities. Similar records and the post-commit hook.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type AutomationQueueMessage,
  backfillEmbeddingQueue,
  type CommitEvent,
  drainAllEmbeddings,
  drainEmbeddingQueue,
  EMBEDDING_BACKFILL_SETTING,
  embedRecordEvents,
  invoke,
  type ModelRunner,
  memoryVectorStore,
  newId,
  vectorId,
} from "../src/index.ts";
import { testRunner } from "./ai-helpers.ts";
import { context, createUser, db, unique } from "./helpers.ts";

let member: ActingUser;
let admin: ActingUser;
let vectors: ReturnType<typeof memoryVectorStore>;
let models: ModelRunner;
let embedCalls: string[];

beforeEach(async () => {
  member = await createUser("member");
  admin = await createUser("admin");
  vectors = memoryVectorStore();
  const runner = testRunner().models;
  embedCalls = [];
  models = {
    ...runner,
    run: runner.run,
    roles: runner.roles,
    async embed(texts) {
      embedCalls.push(...texts);
      return (runner.embed as NonNullable<ModelRunner["embed"]>)(texts);
    },
  };
  // Each test starts with an empty queue (earlier files' writes queue records too).
  await env.DB.prepare("DELETE FROM core_embedding_queue").run();
});

const deps = () => ({ db, models, vectors });
const queued = async () =>
  (
    await env.DB.prepare("SELECT object_type, record_id FROM core_embedding_queue").all<{
      object_type: string;
      record_id: string;
    }>()
  ).results;

describe("the queue and the hash", () => {
  it("queues a created record in the same batch and embeds it once", async () => {
    const person = await invoke(
      "person.create",
      { displayName: `Queue ${unique()}`, location: "Oslo" },
      context(member),
    );
    expect(await queued()).toContainEqual({ object_type: "person", record_id: person.id });
    const first = await drainEmbeddingQueue(deps());
    expect(first).toMatchObject({ embedded: 1, deleted: 0, failed: 0 });
    expect(vectors.ids()).toContain(await vectorId("person", person.id));
    expect(await queued()).toEqual([]);
  });

  it("does not re-embed when the text is unchanged, and does when it changes", async () => {
    const person = await invoke(
      "person.create",
      { displayName: `Hash ${unique()}` },
      context(member),
    );
    await drainEmbeddingQueue(deps());
    expect(embedCalls).toHaveLength(1);

    // A change to a field that is not embedded is not even queued.
    await invoke("person.update", { id: person.id, timezone: "Europe/Oslo" }, context(member));
    expect(await queued()).toEqual([]);

    // Re-queued with identical text (e.g. a no-op save): the hash matches, nothing is sent.
    await env.DB.prepare(
      "INSERT INTO core_embedding_queue (object_type, record_id, queued_at) VALUES ('person', ?, ?)",
    )
      .bind(person.id, new Date().toISOString())
      .run();
    const again = await drainEmbeddingQueue(deps());
    expect(again).toMatchObject({ taken: 1, embedded: 0, unchanged: 1 });
    expect(embedCalls).toHaveLength(1);

    await invoke("person.update", { id: person.id, location: "Bergen" }, context(member));
    const changed = await drainEmbeddingQueue(deps());
    expect(changed.embedded).toBe(1);
    expect(embedCalls).toHaveLength(2);
    expect(embedCalls[1]).toContain("Bergen");
  });

  it("re-embeds a person when their job changes through an affiliation", async () => {
    const person = await invoke(
      "person.create",
      { displayName: `Job ${unique()}` },
      context(member),
    );
    const org = await invoke(
      "organisation.create",
      { name: `Initech ${unique()}` },
      context(member),
    );
    await drainAllEmbeddings(deps());
    await invoke(
      "affiliation.create",
      { personId: person.id, organisationId: org.id, title: "Engineer" },
      context(member),
    );
    expect(await queued()).toContainEqual({ object_type: "person", record_id: person.id });
    await drainAllEmbeddings(deps());
    expect(embedCalls.at(-1)).toMatch(/Title: Engineer[\s\S]*Organisation: Initech/);
  });

  it("deletes the vector when the record is deleted", async () => {
    const task = await invoke("task.create", { title: `Call back ${unique()}` }, context(member));
    await drainEmbeddingQueue(deps());
    expect(vectors.ids()).toContain(await vectorId("task", task.id));
    await invoke("task.delete", { id: task.id }, context(member));
    const out = await drainEmbeddingQueue(deps());
    expect(out.deleted).toBe(1);
    expect(vectors.ids()).not.toContain(await vectorId("task", task.id));
    const state = await env.DB.prepare("SELECT 1 FROM core_embedding WHERE record_id = ?")
      .bind(task.id)
      .first();
    expect(state).toBeNull();
  });

  it("leaves rows queued with one more attempt when the model fails", async () => {
    await invoke("person.create", { displayName: `Fail ${unique()}` }, context(member));
    const failing: ModelRunner = {
      ...models,
      embed: async () => Promise.reject(new Error("model down")),
    };
    const out = await drainEmbeddingQueue({ db, models: failing, vectors });
    expect(out.failed).toBe(1);
    const row = await env.DB.prepare("SELECT attempts FROM core_embedding_queue").first<{
      attempts: number;
    }>();
    expect(row?.attempts).toBe(1);
    expect((await drainEmbeddingQueue(deps())).embedded).toBe(1);
  });
});

describe("restricted and private content", () => {
  async function syncedActivity(overrides: {
    private_to?: string | null;
    disclosure?: string | null;
  }) {
    const id = newId("activity");
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO core_activity (id, type, subject, body, payload, occurred_at, author_user_id, author_actor,
         created_at, updated_at, private_to, disclosure)
       VALUES (?, 'email', 'Confidential offer', 'Salary details for the candidate', '{}', ?, ?, 'human', ?, ?, ?, ?)`,
    )
      .bind(
        id,
        now,
        member.id,
        now,
        now,
        overrides.private_to ?? null,
        overrides.disclosure ?? null,
      )
      .run();
    await env.DB.prepare(
      "INSERT INTO core_embedding_queue (object_type, record_id, queued_at) VALUES ('activity', ?, ?)",
    )
      .bind(id, now)
      .run();
    return id;
  }

  it("never embeds private or metadata-only activities", async () => {
    const privateId = await syncedActivity({ private_to: member.id, disclosure: "full" });
    const metadataId = await syncedActivity({ disclosure: "metadata" });
    const fullId = await syncedActivity({ disclosure: "full" });
    await drainEmbeddingQueue(deps());
    expect(embedCalls.join("\n")).toContain("Salary details");
    expect(embedCalls).toHaveLength(1);
    expect(vectors.ids()).toEqual([await vectorId("activity", fullId)]);
    expect(vectors.ids()).not.toContain(await vectorId("activity", privateId));
    expect(vectors.ids()).not.toContain(await vectorId("activity", metadataId));
  });

  it("deletes the vector when an embedded activity becomes private", async () => {
    const id = await syncedActivity({ disclosure: "full" });
    await drainEmbeddingQueue(deps());
    expect(vectors.size).toBe(1);
    await env.DB.prepare("UPDATE core_activity SET private_to = ? WHERE id = ?")
      .bind(member.id, id)
      .run();
    await env.DB.prepare(
      "INSERT INTO core_embedding_queue (object_type, record_id, queued_at) VALUES ('activity', ?, ?)",
    )
      .bind(id, new Date().toISOString())
      .run();
    expect((await drainEmbeddingQueue(deps())).deleted).toBe(1);
    expect(vectors.size).toBe(0);
  });

  it("does not embed system timeline posts", async () => {
    const id = newId("activity");
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO core_activity (id, type, subject, payload, occurred_at, author_user_id, author_actor, created_at, updated_at)
       VALUES (?, 'system', 'Stage changed', '{"kind":"field_change"}', ?, ?, 'system', ?, ?)`,
    )
      .bind(id, now, member.id, now, now)
      .run();
    await env.DB.prepare(
      "INSERT INTO core_embedding_queue (object_type, record_id, queued_at) VALUES ('activity', ?, ?)",
    )
      .bind(id, now)
      .run();
    await drainEmbeddingQueue(deps());
    expect(embedCalls).toEqual([]);
  });
});

describe("erase (ADR 0019)", () => {
  it("removes the person's vectors, their activities' vectors and summaries about them", async () => {
    const person = await invoke(
      "person.create",
      { displayName: `Erase Me ${unique()}`, emails: [{ email: `${unique()}@erase.example` }] },
      context(member),
    );
    const note = await invoke(
      "activity.log",
      {
        type: "note",
        body: "Private medical leave until March.",
        links: [{ object: "person", id: person.id }],
      },
      context(member),
    );
    await drainAllEmbeddings(deps());
    expect(vectors.ids()).toEqual(
      expect.arrayContaining([
        await vectorId("person", person.id),
        await vectorId("activity", note.id),
      ]),
    );
    await invoke(
      "summary.generate",
      { subject: { kind: "record", object: "person", id: person.id } },
      context(member, { models }),
    );
    expect(
      await env.DB.prepare("SELECT 1 FROM core_ai_summary WHERE subject_id = ?")
        .bind(person.id)
        .first(),
    ).not.toBeNull();

    // The post-commit hook is how ros-app drains right after the erase.
    const events: CommitEvent[] = [];
    await invoke(
      "person.erase",
      { id: person.id },
      context(admin, { onCommitted: (e) => events.push(e) }),
    );
    expect(events.at(-1)).toMatchObject({ operation: "person.erase", embeddingsQueued: true });
    await drainAllEmbeddings(deps());
    expect(vectors.ids()).not.toContain(await vectorId("person", person.id));
    expect(vectors.ids()).not.toContain(await vectorId("activity", note.id));
    const left = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_embedding WHERE record_id IN (?, ?)",
    )
      .bind(person.id, note.id)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
    const summaries = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_ai_summary WHERE subject_id = ? OR sources LIKE ?",
    )
      .bind(person.id, `%${person.id}%`)
      .first<{ n: number }>();
    expect(summaries?.n).toBe(0);
  });
});

describe("embedding from stage 5 record events (ADR 0154 amendment)", () => {
  function sink() {
    const sent: AutomationQueueMessage[] = [];
    return { sent, events: { send: async (m: AutomationQueueMessage[]) => void sent.push(...m) } };
  }

  it("writes no queue row when the events consumer embeds, and embeds once from the event", async () => {
    const { sent, events } = sink();
    const person = await invoke(
      "person.create",
      { displayName: `Event ${unique()}`, location: "Rome" },
      context(member, { events, embedViaEvents: true }),
    );
    expect(await queued()).toEqual([]);
    const changes = sent.flatMap((m) => (m.kind === "record" ? m.changes : []));
    expect(changes).toContainEqual(expect.objectContaining({ object: "person", id: person.id }));
    const first = await embedRecordEvents(deps(), changes);
    expect(first.embedded).toBe(1);
    // A redelivered batch costs no model call: the hash matches.
    const again = await embedRecordEvents(deps(), changes);
    expect(again).toMatchObject({ embedded: 0, unchanged: 1 });
    expect(embedCalls).toHaveLength(1);

    // An update to a field that is not embedded is skipped; one that is, is embedded.
    sent.length = 0;
    await invoke(
      "person.update",
      { id: person.id, timezone: "Europe/Rome" },
      context(member, { events, embedViaEvents: true }),
    );
    expect(
      (
        await embedRecordEvents(
          deps(),
          sent.flatMap((m) => (m.kind === "record" ? m.changes : [])),
        )
      ).taken,
    ).toBe(0);
    sent.length = 0;
    await invoke(
      "person.update",
      { id: person.id, location: "Milan" },
      context(member, { events, embedViaEvents: true }),
    );
    expect(
      (
        await embedRecordEvents(
          deps(),
          sent.flatMap((m) => (m.kind === "record" ? m.changes : [])),
        )
      ).embedded,
    ).toBe(1);
    expect(await queued()).toEqual([]);
  });

  it("still queues when events are sent but nothing embeds from them (no Vectorize)", async () => {
    const { events } = sink();
    const person = await invoke(
      "person.create",
      { displayName: `NoVec ${unique()}` },
      context(member, { events }),
    );
    expect(await queued()).toContainEqual({ object_type: "person", record_id: person.id });
  });

  it("queues the records for the cron when embedding from events fails", async () => {
    const { sent, events } = sink();
    const person = await invoke(
      "person.create",
      { displayName: `Retry ${unique()}` },
      context(member, { events, embedViaEvents: true }),
    );
    const failing: ModelRunner = {
      ...models,
      embed: async () => Promise.reject(new Error("model down")),
    };
    const out = await embedRecordEvents(
      { db, models: failing, vectors },
      sent.flatMap((m) => (m.kind === "record" ? m.changes : [])),
    );
    expect(out.failed).toBe(1);
    expect(await queued()).toContainEqual({ object_type: "person", record_id: person.id });
  });
});

describe("post-commit hook and backfill", () => {
  it("reports queued embeddings after a write, not after a read", async () => {
    const events: CommitEvent[] = [];
    const onCommitted = (e: CommitEvent) => events.push(e);
    const person = await invoke(
      "person.create",
      { displayName: `Hook ${unique()}` },
      context(member, { onCommitted }),
    );
    await invoke("person.get", { id: person.id }, context(member, { onCommitted }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ operation: "person.create", embeddingsQueued: true });
  });

  it("walks existing records once, queueing the ones never embedded", async () => {
    await env.DB.prepare("DELETE FROM core_settings WHERE key = ?")
      .bind(EMBEDDING_BACKFILL_SETTING)
      .run();
    await env.DB.prepare("DELETE FROM core_embedding").run();
    let total = 0;
    for (let i = 0; i < 50; i++) {
      const r = await backfillEmbeddingQueue(db, new Date().toISOString());
      total += r.queued;
      if (r.done) break;
    }
    expect(total).toBeGreaterThan(0);
    expect((await backfillEmbeddingQueue(db, new Date().toISOString())).done).toBe(true);
  });
});

describe("similar records", () => {
  it("finds records close in meaning, not the record itself", async () => {
    const tag = unique();
    const a = await invoke(
      "organisation.create",
      { name: `Solar Panels Co ${tag}`, industry: "Renewable energy" },
      context(member),
    );
    const b = await invoke(
      "organisation.create",
      { name: `Sunny Solar ${tag}`, industry: "Renewable energy" },
      context(member),
    );
    await invoke(
      "organisation.create",
      { name: `Bakery ${tag}`, industry: "Food" },
      context(member),
    );
    await drainAllEmbeddings(deps());
    const out = await invoke(
      "record.similar",
      { object: "organisation", id: a.id, objects: ["organisation"] },
      context(member, { models, vectors }),
    );
    expect(out.status).toBe("ok");
    expect(out.hits[0]?.id).toBe(b.id);
    expect(out.hits.map((h) => h.id)).not.toContain(a.id);
    expect(
      await invoke("record.similar", { object: "organisation", id: a.id }, context(member)),
    ).toMatchObject({ status: "unavailable" });
    expect(
      await invoke(
        "record.similar",
        { object: "organisation", id: "org_missing" },
        context(member, { models, vectors }),
      ),
    ).toMatchObject({ status: "not_indexed" });
  });
});
