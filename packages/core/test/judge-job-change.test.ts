// Placement `sync.jobChange` (stage 11 AC 9, ADR 0236): a known person's changed signature is
// read by the judge in place of the string compare. Asked only on a changed signature, from a
// mailbox that shares full content; phone, email and web lines never reach it; an erased sender
// never reaches it; when it cannot answer, the string compare decides as before; off changes
// nothing; its calls are counted in the ingest's own batch.
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ActingUser,
  choiceAnswer,
  type FakeJudgeCall,
  fakeJudge,
  invokeByName,
  isContactLine,
  JOB_CHANGE_LABELS,
  JOB_CHANGE_PLACEMENT,
  type JobChangeLabel,
  type JobChangeState,
  JUDGE_UNAVAILABLE_REASONS,
  type Judge,
  newId,
  offJudge,
  type SyncItem,
  signatureForJudge,
  unavailableJudge,
} from "../src/index.ts";
import { erasedAddressHash } from "../src/records/erase-subject.ts";
import { context, createUser, db, unique } from "./helpers.ts";

let admin: ActingUser;
let alice: ActingUser;
let adaEmail: string;
let ada: { id: string };
let orgName: string;

async function connection(sharing: "full" | "metadata") {
  const id = newId("connection");
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_integration_connection (id, vendor, scope, owner_user_id, title, sharing_level, status, created_at, updated_at) VALUES (?, 'fake', 'personal', ?, 'Mail', ?, 'active', ?, ?)",
  )
    .bind(id, alice.id, sharing, now, now)
    .run();
  return id;
}

let seq = 0;
function signed(signature: string): SyncItem {
  seq += 1;
  const messageId = `jc${seq}.${unique("x")}@mail.test`;
  return {
    kind: "email",
    op: "upsert",
    providerId: `p-${messageId}`,
    messageId,
    subject: `Subject ${seq}`,
    snippet: "Hello",
    from: { email: adaEmail, name: "Ada Lovelace" },
    to: [{ email: "alice@ourco.test" }],
    sentAt: new Date(Date.UTC(2026, 10, 1, 10, seq % 60)).toISOString(),
    signature,
  };
}

function ingest(conn: string, items: SyncItem[], judge?: Judge) {
  return invokeByName(
    "sync.ingest",
    { connectionId: conn, items },
    {
      actor: "automation",
      user: alice,
      origin: { surface: "automation", automationId: `sync:${conn}` },
      db,
      ...(judge ? { judge } : {}),
    },
  );
}

/** Answers every call with one label. */
const answering = (label: JobChangeLabel, inputTokens = 400) => {
  const judge = fakeJudge(() => ({ signature: choiceAnswer(JOB_CHANGE_LABELS, label) }));
  const counted: Judge & { calls: FakeJudgeCall[] } = {
    provider: "fake",
    calls: judge.calls,
    async ask(request) {
      const out = await judge.ask(request);
      return out.status === "answered" ? { ...out, inputTokens } : out;
    },
  };
  return counted;
};

async function jobChanges() {
  const out = (await invokeByName("jobChange.list", {}, context(admin))) as {
    items: {
      personId: string;
      signal: string;
      evidence: Record<string, unknown>;
      proposal: Record<string, unknown>;
    }[];
  };
  return out.items.filter((i) => i.personId === ada.id);
}

/** A known person with a primary job, and a first signature already seen. */
async function seen(sharing: "full" | "metadata" = "full") {
  const conn = await connection(sharing);
  await ingest(conn, [signed(`Ada Lovelace\nEngineer\n${orgName}`)], offJudge);
  return conn;
}

const RENAMED = () =>
  `Ada Lovelace\nEngineer\n${orgName} Holdings Pty Ltd\nM: +61 400 000 000\nada@example.org\nwww.example.org`;
const MOVED = "Ada Lovelace\nCTO\nAnalytical Engines Ltd\n+44 20 7946 0000";

beforeAll(async () => {
  admin = await createUser("admin");
  alice = await createUser("member");
});

beforeEach(async () => {
  const ext = `${unique("ext")}.org`;
  adaEmail = `ada@${ext}`;
  orgName = `Brightside ${unique("B")}`;
  const org = (await invokeByName(
    "organisation.create",
    { name: orgName, domains: [{ domain: ext }] },
    context(admin),
  )) as { id: string };
  ada = (await invokeByName(
    "person.create",
    { displayName: `Ada ${unique("L")}`, emails: [{ email: adaEmail }] },
    context(admin),
  )) as { id: string };
  await invokeByName(
    "affiliation.create",
    { personId: ada.id, organisationId: org.id, title: "Engineer", primary: true },
    context(admin),
  );
});

describe("signatures as the judge reads them", () => {
  it("drops phone, email and web lines, labelled or not", () => {
    for (const line of [
      "+61 400 000 000",
      "M: +61 400 000 000",
      "Tel. (02) 9999 1234",
      "+44 20 7946 0000 | +44 7700 900123",
      "ada@example.org",
      "E: ada@example.org",
      "www.example.org",
      "https://example.org/team",
      "example.org",
      "W: example.org",
    ]) {
      expect(isContactLine(line), line).toBe(true);
    }
    for (const line of ["Ada Lovelace", "Head of Ops, Acme Pty Ltd", "Level 3, 12 King St"]) {
      expect(isContactLine(line), line).toBe(false);
    }
    expect(signatureForJudge(RENAMED())).toBe(
      `Ada Lovelace\nEngineer\n${orgName} Holdings Pty Ltd`,
    );
  });
});

describe("sync.jobChange in sync.ingest", () => {
  it("is asked only on a changed signature; the same employer written differently is no suggestion", async () => {
    const conn = await seen();
    const judge = answering("same_employer");
    // The same signature again: nothing changed, nothing asked.
    await ingest(conn, [signed(`Ada Lovelace\nEngineer\n${orgName}`)], judge);
    expect(judge.calls).toHaveLength(0);
    // The string compare would suggest a job change here ("… Holdings Pty Ltd" is not the
    // organisation's name); the judge reads it as the same employer.
    await ingest(conn, [signed(RENAMED())], judge);
    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0]?.placement).toBe(JOB_CHANGE_PLACEMENT);
    const state = judge.calls[0]?.state as unknown as JobChangeState;
    expect(state).toEqual({
      person: { name: expect.stringMatching(/^Ada /), worksAt: orgName, title: "Engineer" },
      previousSignature: { title: "Engineer", company: orgName },
      newSignature: `Ada Lovelace\nEngineer\n${orgName} Holdings Pty Ltd`,
    });
    // Phone, email and web lines never reach it, nor the email itself.
    expect(JSON.stringify(state)).not.toMatch(/\+61|@|www\.|example\.org|Subject|Hello/);
    expect(await jobChanges()).toEqual([]);
  });

  it("suggests a job change on a different employer, naming the company code parsed", async () => {
    const conn = await seen();
    const judge = answering("different_employer");
    await ingest(conn, [signed(MOVED)], judge);
    expect(await jobChanges()).toEqual([
      expect.objectContaining({
        signal: "signature",
        proposal: { organisationName: "Analytical Engines Ltd", title: "CTO" },
        evidence: expect.objectContaining({
          judge: { verdict: "different_employer", p: 1, threshold: 0.5, model: "fake" },
        }),
      }),
    ]);
  });

  it("a new title at the same employer is no suggestion", async () => {
    const conn = await seen();
    await ingest(
      conn,
      [signed(`Ada Lovelace\nHead of Engineering\n${orgName}`)],
      answering("new_title"),
    );
    expect(await jobChanges()).toEqual([]);
  });

  it.each([
    ...JUDGE_UNAVAILABLE_REASONS.filter((r) => r !== "off").map((r) => [r] as const),
    ["fault"] as const,
  ])("falls back to the string compare when the judge fails (%s)", async (reason) => {
    const conn = await seen();
    const judge: Judge =
      reason === "fault"
        ? { provider: "fake", ask: async () => ({ status: "fault", detail: "malformed" }) }
        : unavailableJudge(reason);
    await ingest(conn, [signed(MOVED)], judge);
    expect(await jobChanges()).toEqual([
      expect.objectContaining({
        proposal: { organisationName: "Analytical Engines Ltd", title: "CTO" },
      }),
    ]);
    expect((await jobChanges())[0]?.evidence.judge).toBeUndefined();
  });

  it("off: the string compare decides, as before stage 11", async () => {
    const conn = await seen();
    await ingest(conn, [signed(RENAMED())], offJudge);
    expect(await jobChanges()).toEqual([
      expect.objectContaining({ proposal: expect.objectContaining({ title: "Engineer" }) }),
    ]);
  });

  it("never sends a metadata-only mailbox's signature", async () => {
    const conn = await seen("metadata");
    const judge = answering("same_employer");
    await ingest(conn, [signed(MOVED)], judge);
    expect(judge.calls).toHaveLength(0);
    // The string compare still decides, as before.
    expect(await jobChanges()).toHaveLength(1);
  });

  it("never reaches the judge for an erased sender", async () => {
    const conn = await seen();
    await env.DB.prepare(
      "INSERT INTO core_erased_address (hash, object_type, erased_at) VALUES (?, 'person', ?)",
    )
      .bind(await erasedAddressHash(adaEmail), new Date().toISOString())
      .run();
    const judge = answering("different_employer");
    await ingest(conn, [signed(MOVED)], judge);
    expect(judge.calls).toHaveLength(0);
    expect(await jobChanges()).toEqual([]);
  });

  it("counts its calls in the ingest's batch, at most five a batch", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const usage = () =>
      env.DB.prepare(
        "SELECT calls, input_tokens FROM core_judge_usage WHERE day = ? AND placement = 'sync.jobChange'",
      )
        .bind(day)
        .first<{ calls: number; input_tokens: number }>()
        .then((r) => ({ calls: r?.calls ?? 0, tokens: r?.input_tokens ?? 0 }));
    const conn = await seen();
    const before = await usage();
    const judge = answering("same_employer", 350);
    // Seven changes in one batch: five are asked, the other two take the string compare.
    await ingest(
      conn,
      Array.from({ length: 7 }, (_, i) => signed(`Ada Lovelace\nEngineer ${i}\n${orgName}`)),
      judge,
    );
    expect(judge.calls).toHaveLength(5);
    const after = await usage();
    expect([after.calls - before.calls, after.tokens - before.tokens]).toEqual([5, 1750]);
  });
});
