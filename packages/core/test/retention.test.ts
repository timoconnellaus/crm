// Storage retention (ADR 0090): the audit retention setting and its sanctioned purge path through
// the append-only triggers, run history purge, pending action compaction and caps, the storage
// gauge, and that the retention queries keep to their indexes (EXPLAIN QUERY PLAN, rows read).
import { env } from "cloudflare:workers";
import { createCrmDb } from "@crm/db";
import { beforeAll, describe, expect, it } from "vitest";
import {
  capFileDiffs,
  capPreview,
  capValue,
  isTruncatedValue,
  matchesPreviewValue,
  VALUE_MAX_CHARS,
} from "../src/approvals/caps.ts";
import {
  type ActingUser,
  AUDIT_PURGE_MAX,
  auditPurgeDue,
  compactPendingActions,
  ForbiddenError,
  type InvocationContext,
  invoke,
  measureStorage,
  type PendingApproval,
  PendingApprovalError,
  purgeRunHistory,
  runAuditPurge,
  ValidationError,
} from "../src/index.ts";
import { context, createUser, db, setPreset, unique } from "./helpers.ts";

let admin: ActingUser;
let member: ActingUser;

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
});

// --- A metered, recording D1 handle --------------------------------------------------------

interface Recorded {
  sql: string;
  params: unknown[];
}
let rowsRead = 0;
let recorded: Recorded[] = [];
const real = new WeakMap<object, { stmt: D1PreparedStatement; sql: string; params: unknown[] }>();

const metered = new Proxy(env.DB, {
  get(target, prop) {
    if (prop === "prepare") {
      return (query: string) => {
        const wrap = (stmt: D1PreparedStatement, params: unknown[]): D1PreparedStatement => {
          const proxy = new Proxy(stmt, {
            get(s, p) {
              if (p === "bind") return (...args: unknown[]) => wrap(s.bind(...args), args);
              if (p === "all" || p === "run" || p === "first") {
                return async (...args: unknown[]) => {
                  recorded.push({ sql: query, params });
                  const result = await s.all();
                  rowsRead += result.meta.rows_read;
                  if (p === "first") {
                    const col = args[0] as string | undefined;
                    const row = result.results[0] as Record<string, unknown> | undefined;
                    return col ? (row?.[col] ?? null) : (row ?? null);
                  }
                  return result;
                };
              }
              const value = Reflect.get(s, p);
              return typeof value === "function" ? value.bind(s) : value;
            },
          });
          real.set(proxy, { stmt, sql: query, params });
          return proxy;
        };
        return wrap(target.prepare(query), []);
      };
    }
    if (prop === "batch") {
      return async (statements: D1PreparedStatement[]) => {
        const unwrapped = statements.map((s) => {
          const r = real.get(s);
          if (r) recorded.push({ sql: r.sql, params: r.params });
          return r?.stmt ?? s;
        });
        const results = await target.batch(unwrapped);
        for (const r of results) rowsRead += r.meta.rows_read;
        return results;
      };
    }
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const meteredDb = createCrmDb(metered);

async function measure<T>(run: () => Promise<T>): Promise<{ result: T; rows: number }> {
  rowsRead = 0;
  recorded = [];
  const result = await run();
  return { result, rows: rowsRead };
}

const BIG_TABLES = [
  "core_audit",
  "core_audit_changes",
  "core_audit_redactions",
  "core_audit_read_counts",
  "core_extension_runs",
  "core_pending_action",
];

/** Fails if any recorded statement plans a full scan of a big table. */
async function expectNoFullScans(statements: Recorded[]) {
  expect(statements.length).toBeGreaterThan(0);
  const scans: string[] = [];
  for (const { sql, params } of statements) {
    if (!/^\s*(select|delete|update|insert)/i.test(sql) || /^\s*insert/i.test(sql)) continue;
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...params)
      .all<{ detail: string }>();
    for (const { detail } of plan.results) {
      const m = /^SCAN (\w+)/.exec(detail);
      if (
        m &&
        BIG_TABLES.includes(m[1] as string) &&
        !/USING (COVERING )?INDEX|PRIMARY KEY/.test(detail)
      ) {
        scans.push(`${detail}  <=  ${sql.slice(0, 160)}`);
      }
      if (m && BIG_TABLES.includes(m[1] as string) && /USING COVERING INDEX/.test(detail)) {
        // A covering-index scan still reads every row of the index.
        scans.push(`${detail}  <=  ${sql.slice(0, 160)}`);
      }
    }
  }
  expect(scans).toEqual([]);
}

async function setRetention(years: 1 | 2 | 7 | null) {
  return invoke("audit.setRetention", { years }, context(admin));
}

async function count(sql: string, ...params: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql)
    .bind(...params)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** Old audit rows (2019), each with one change row; ids `aud_old<tag>_<n>`. */
async function insertOldAudits(tag: string, n: number, start = "2019-01-01") {
  await env.DB.prepare(
    `INSERT INTO core_audit (id, at, operation, risk, actor, user_id, origin, input, result,
       gate_decision, outcome)
     WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?)
     SELECT printf('aud_old%s_%06d', ?, i),
       strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+' || i || ' minutes'),
       'person.update', 'write', 'human', ?, '{"surface":"ui"}', '{}', NULL, 'auto', 'ok' FROM k`,
  )
    .bind(n, tag, start, member.id)
    .run();
  await env.DB.prepare(
    `INSERT INTO core_audit_changes (audit_id, object_type, record_id, action, diff, at)
     SELECT id, 'person', 'per_old', 'update', '{"location":{"before":"a","after":"b"}}', at
     FROM core_audit WHERE id LIKE ?`,
  )
    .bind(`aud_old${tag}_%`)
    .run();
}

// --- Retention setting -------------------------------------------------------------------

describe("audit retention setting", () => {
  it("defaults to forever", async () => {
    const out = await invoke("audit.retention", {}, context(admin));
    expect(out).toEqual({ years: null, cutoff: null });
  });

  it("is changed only by a human admin, at risk destructive, and audited", async () => {
    await expect(
      invoke("audit.setRetention", { years: 2 }, context(member)),
    ).rejects.toBeInstanceOf(ForbiddenError);
    for (const actor of ["mcp", "assistant", "automation", "extension"] as const) {
      await expect(
        invoke(
          "audit.setRetention",
          { years: 2 },
          context(admin, { actor, origin: { surface: actor === "mcp" ? "mcp" : "system" } }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    await expect(
      invoke("audit.setRetention", { years: 3 as never }, context(admin)),
    ).rejects.toBeInstanceOf(ValidationError);

    const out = await setRetention(7);
    expect(out).toMatchObject({ years: 7, previousYears: null });
    const row = await env.DB.prepare(
      "SELECT * FROM core_audit WHERE operation = 'audit.setRetention' AND outcome = 'ok' ORDER BY at DESC LIMIT 1",
    ).first<{ id: string; risk: string }>();
    expect(row?.risk).toBe("destructive");
    const change = await env.DB.prepare("SELECT diff FROM core_audit_changes WHERE audit_id = ?")
      .bind(row?.id)
      .first<{ diff: string }>();
    expect(JSON.parse(change?.diff ?? "{}")).toEqual({ years: { before: null, after: 7 } });
    await setRetention(null);
  });
});

// --- The sanctioned purge path -----------------------------------------------------------

describe("audit purge", () => {
  it("refuses ordinary deletes, and markers inside the retention window", async () => {
    await insertOldAudits("guard", 3);
    const id = "aud_oldguard_000001";
    // Forever: no delete passes, even with a marker for an old cutoff.
    await expect(
      env.DB.prepare("DELETE FROM core_audit_changes WHERE audit_id = ?").bind(id).run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      env.DB.prepare("DELETE FROM core_audit WHERE id = ?").bind(id).run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      env.DB.prepare(
        "INSERT INTO core_audit_purges (cutoff, retention_years, at) VALUES ('2020-01-01T00:00:00.000Z', 1, '2026-01-01')",
      ).run(),
    ).rejects.toThrow(/retention window/);

    await setRetention(1);
    // Retention set, but no marker yet: still refused.
    await expect(
      env.DB.prepare("DELETE FROM core_audit_changes WHERE audit_id = ?").bind(id).run(),
    ).rejects.toThrow(/append-only/);
    // A marker must match the setting and lie at least that many years back.
    await expect(
      env.DB.prepare(
        "INSERT INTO core_audit_purges (cutoff, retention_years, at) VALUES ('2020-01-01T00:00:00.000Z', 2, '2026-01-01')",
      ).run(),
    ).rejects.toThrow(/retention window/);
    await expect(
      env.DB.prepare(
        "INSERT INTO core_audit_purges (cutoff, retention_years, at) VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-6 months'), 1, '2026-01-01')",
      ).run(),
    ).rejects.toThrow(/retention window/);
    // A recent audit row can never be deleted, whatever marker exists.
    const recent = await env.DB.prepare(
      "SELECT id FROM core_audit WHERE at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day') LIMIT 1",
    ).first<{ id: string }>();
    expect(recent).toBeTruthy();
    await expect(
      env.DB.prepare("DELETE FROM core_audit WHERE id = ?").bind(recent?.id).run(),
    ).rejects.toThrow(/append-only/);
    await setRetention(null);
  });

  it("deletes audit rows, change rows, redaction markers and read counts past retention, with one summary row per round", async () => {
    await insertOldAudits("purge", 30);
    // An erase redacted one old row: its marker must go with it.
    await env.DB.prepare(
      `INSERT INTO core_audit_redactions (audit_id, object_type, record_id, operation, user_id, at)
       VALUES ('aud_oldpurge_000002', 'person', 'per_old', 'person.erase', ?, '2025-01-01T00:00:00.000Z')`,
    )
      .bind(admin.id)
      .run();
    await env.DB.prepare(
      `INSERT INTO core_audit_read_counts (hour, actor, user_id, caller, operation, count, first_at, last_at)
       VALUES ('2019-03-01T10:00:00.000Z', 'mcp', ?, 'cap_x', 'person.get', 4, '2019-03-01T10:01:00.000Z', '2019-03-01T10:59:00.000Z')`,
    )
      .bind(member.id)
      .run();
    const recentBefore = await count(
      "SELECT count(*) AS n FROM core_audit WHERE at >= '2025-01-01'",
    );

    // Forever: nothing is due and nothing runs (not even an audit row).
    expect(await runAuditPurge(db)).toMatchObject({ rounds: 0, auditRows: 0 });
    expect(
      await count("SELECT count(*) AS n FROM core_audit WHERE operation = 'audit.purge'"),
    ).toBe(0);

    await setRetention(2);
    const oldTotal = await count("SELECT count(*) AS n FROM core_audit WHERE at < '2020-01-01'");
    const result = await runAuditPurge(db);
    expect(result).toMatchObject({
      auditRows: oldTotal,
      changeRows: oldTotal,
      readCountRows: 1,
      more: false,
    });
    expect(await count("SELECT count(*) AS n FROM core_audit WHERE at < '2020-01-01'")).toBe(0);
    expect(
      await count("SELECT count(*) AS n FROM core_audit_changes WHERE at < '2020-01-01'"),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM core_audit_redactions WHERE audit_id = 'aud_oldpurge_000002'",
      ),
    ).toBe(0);
    expect(
      await count("SELECT count(*) AS n FROM core_audit_read_counts WHERE hour < '2020-01-01'"),
    ).toBe(0);
    // Newer audit rows are untouched (the purge's own row is added).
    expect(
      await count("SELECT count(*) AS n FROM core_audit WHERE at >= '2025-01-01'"),
    ).toBeGreaterThanOrEqual(recentBefore);

    const summary = await env.DB.prepare(
      "SELECT * FROM core_audit WHERE operation = 'audit.purge'",
    ).all<{ id: string; actor: string; result: string }>();
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0]?.actor).toBe("automation");
    expect(JSON.parse(summary.results[0]?.result ?? "{}")).toMatchObject({
      years: 2,
      auditRows: oldTotal,
      redactions: 1,
    });
    const marker = await env.DB.prepare("SELECT * FROM core_audit_purges").all<{
      audit_id: string;
      retention_years: number;
    }>();
    expect(marker.results).toHaveLength(1);
    expect(marker.results[0]).toMatchObject({
      audit_id: summary.results[0]?.id,
      retention_years: 2,
    });

    // Markers are append-only; ordinary deletes of current rows still fail.
    await expect(env.DB.prepare("DELETE FROM core_audit_purges").run()).rejects.toThrow(
      /append-only/,
    );
    await expect(
      env.DB.prepare("DELETE FROM core_audit WHERE id = ?").bind(summary.results[0]?.id).run(),
    ).rejects.toThrow(/append-only/);

    // Switching back to forever closes the path again, even for rows older than the marker.
    await insertOldAudits("after", 2, "2018-06-01");
    await setRetention(null);
    await expect(
      env.DB.prepare("DELETE FROM core_audit_changes WHERE audit_id = 'aud_oldafter_000001'").run(),
    ).rejects.toThrow(/append-only/);
    await setRetention(2);
    expect((await runAuditPurge(db)).auditRows).toBe(2);
    await setRetention(null);
  });

  it("works in bounded rounds on its indexes", async () => {
    const n = AUDIT_PURGE_MAX + 500;
    await insertOldAudits("bulk", n);
    // Plenty of recent rows the purge must not walk.
    await insertOldAudits("recent", 3000, new Date(Date.now() - 86_400_000 * 30).toISOString());
    await setRetention(1);

    const due = await measure(() => auditPurgeDue(meteredDb.query, new Date().toISOString()));
    expect(due.result).toBe(true);
    expect(due.rows).toBeLessThan(20);
    await expectNoFullScans(recorded);

    const first = await measure(() =>
      invoke(
        "audit.purge",
        {},
        {
          actor: "automation",
          user: { id: "system", email: "system@crm.invalid", name: "System", role: "admin" },
          origin: { surface: "system", automationId: "audit.purge" },
          db: meteredDb,
        },
      ),
    );
    expect(first.result).toMatchObject({ auditRows: AUDIT_PURGE_MAX, more: true });
    // Reads and index maintenance (the delete guards, foreign keys, 5 indexes) scale with the
    // rows deleted, about 20 per audit row with one change row, not with the table.
    expect(first.rows).toBeLessThan(AUDIT_PURGE_MAX * 40);
    await expectNoFullScans(recorded);

    const rest = await runAuditPurge(db);
    expect(rest).toMatchObject({ auditRows: 500, more: false });
    expect(
      await count("SELECT count(*) AS n FROM core_audit WHERE id LIKE 'aud_oldrecent_%'"),
    ).toBe(3000);
    await setRetention(null);
  });
});

// --- Run history -------------------------------------------------------------------------

describe("run history purge", () => {
  async function insertRuns(outcome: string, daysAgo: number, n: number, tag: string) {
    await env.DB.prepare(
      `INSERT INTO core_extension_runs (id, extension_id, kind, started_at, duration_ms, outcome)
       WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?)
       SELECT printf('xrn_%s_%06d', ?, i), 'example', 'tool',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ? || ' days', '-' || i || ' seconds'), 5, ? FROM k`,
    )
      .bind(n, tag, daysAgo, outcome)
      .run();
  }

  it("deletes successful runs after 30 days and failures after 90, in chunks", async () => {
    await insertRuns("ok", 31, 700, "okold");
    await insertRuns("ok", 5, 300, "oknew");
    await insertRuns("error", 45, 50, "errmid");
    await insertRuns("error", 91, 40, "errold");
    await insertRuns("timeout", 100, 10, "toold");
    await insertRuns("ok", 1, 2000, "busy");

    const { result, rows } = await measure(() =>
      purgeRunHistory(meteredDb.query, new Date().toISOString(), { chunk: 250 }),
    );
    expect(result).toEqual({ deleted: 750, more: false });
    // About the deleted rows and their index entries, not the 2,350 kept.
    expect(rows).toBeLessThan(750 * 6);
    await expectNoFullScans(recorded);
    const left = await env.DB.prepare(
      "SELECT substr(id, 5, instr(substr(id, 5), '_') - 1) AS tag, count(*) AS n FROM core_extension_runs GROUP BY tag ORDER BY tag",
    ).all<{ tag: string; n: number }>();
    expect(Object.fromEntries(left.results.map((r) => [r.tag, r.n]))).toEqual({
      busy: 2000,
      errmid: 50,
      oknew: 300,
    });
  });
});

// --- Pending actions: caps and compaction ------------------------------------------------

function mcp(user: ActingUser, sessionId: string): InvocationContext {
  return context(user, {
    actor: "mcp",
    origin: { surface: "mcp", clientId: "client-1", clientName: "Test client", sessionId },
    reason: "Retention test",
  });
}

async function pending(promise: Promise<unknown>): Promise<PendingApproval> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PendingApprovalError);
  return (error as PendingApprovalError).pending;
}

async function actionView(p: PendingApproval) {
  const set = await invoke("approval.get", { changeSetId: p.changeSetId }, context(admin));
  const action = set.actions.find((a) => a.id === p.actionId);
  if (!action) throw new Error(`no action ${p.actionId}`);
  return action;
}

describe("pending action caps", () => {
  it("truncates long preview values with a marker, and approval still checks them", async () => {
    await setPreset("cautious");
    const long = "x".repeat(VALUE_MAX_CHARS * 5);
    const org = await invoke("organisation.create", { name: unique("CapOrg") }, context(member));
    const activity = await invoke(
      "activity.log",
      { type: "note", body: long, links: [{ object: "organisation", id: org.id }] },
      context(member),
    );

    const session = `cap_${unique()}`;
    const p = await pending(
      invoke("activity.update", { id: activity.id, body: `${long}!` }, mcp(member, session)),
    );
    const view = await actionView(p);
    const diff = view.preview[0]?.diff.body;
    expect(isTruncatedValue(diff?.before)).toBe(true);
    expect(isTruncatedValue(diff?.after)).toBe(true);
    expect((diff?.before as { head: string } | undefined)?.head.length ?? 0).toBeLessThanOrEqual(
      VALUE_MAX_CHARS + 1,
    );
    const row = await env.DB.prepare(
      "SELECT length(preview) AS n FROM core_pending_action WHERE id = ?",
    )
      .bind(p.actionId)
      .first<{ n: number }>();
    expect(row?.n).toBeLessThan(10_000);

    const out = await invoke("approval.approve", { actionIds: [p.actionId] }, context(admin));
    expect(out.counts).toMatchObject({ applied: 1 });

    // Changed meanwhile: the truncated before no longer matches, so approval fails cleanly.
    const p2 = await pending(
      invoke("activity.update", { id: activity.id, body: `${long}?` }, mcp(member, session)),
    );
    await invoke("activity.update", { id: activity.id, body: `${long}#` }, context(member));
    const out2 = await invoke("approval.approve", { actionIds: [p2.actionId] }, context(admin));
    expect(out2.counts).toMatchObject({ failed: 1 });
    await setPreset("balanced");
  });

  it("refuses to queue an input too large to store, with a clear error", async () => {
    await setPreset("cautious");
    const rows = Array.from(
      { length: 12_000 },
      (_, i) => `Person ${i},p${i}-${"y".repeat(80)}@example.com`,
    );
    const csv = `name,email\n${rows.join("\n")}`;
    expect(csv.length).toBeGreaterThan(1_000_000);
    await expect(
      invoke(
        "import.csv.commit",
        { object: "person", csv, mapping: { name: "displayName", email: "email" } },
        mcp(member, `cap_${unique()}`),
      ),
    ).rejects.toThrow(/too large to queue for review/);
    await setPreset("balanced");
  });

  it("caps previews by size and counts what it left out", () => {
    const entries = Array.from({ length: 300 }, (_, i) => ({
      object: "person",
      id: `per_${i}`,
      action: "update",
      diff: { notes: { before: "a".repeat(1_900), after: "b".repeat(1_900) } },
    }));
    const { preview, omitted } = capPreview(entries);
    expect(JSON.stringify(preview).length).toBeLessThanOrEqual(400_000);
    expect(preview.length + omitted).toBe(300);
    expect(omitted).toBeGreaterThan(0);
    const files = Array.from({ length: 5 }, (_, i) => ({
      path: `f${i}.ts`,
      hunks: [{ lines: "q".repeat(300) }],
    }));
    const capped = capFileDiffs(files, 800);
    expect(capped[0]?.hunks).toHaveLength(1);
    expect(capped.at(-1)).toMatchObject({ path: "f4.ts", hunks: [], truncated: true });
    const marker = capValue({ big: "z".repeat(5_000) });
    expect(isTruncatedValue(marker)).toBe(true);
    expect(matchesPreviewValue({ big: "z".repeat(5_000) }, marker)).toBe(true);
    expect(matchesPreviewValue({ big: "z".repeat(5_001) }, marker)).toBe(false);
  });
});

describe("pending action compaction", () => {
  async function decideDaysAgo(actionId: string, days: number) {
    await env.DB.prepare(
      `UPDATE core_pending_action SET decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ? || ' days') WHERE id = ?`,
    )
      .bind(days, actionId)
      .run();
  }

  it("keeps a summary of actions decided over 30 days ago and drops the rest", async () => {
    await setPreset("cautious");
    const session = `cap_${unique()}`;
    const old = await pending(
      invoke("person.create", { displayName: unique("Old") }, mcp(member, session)),
    );
    const recent = await pending(
      invoke("person.create", { displayName: unique("New") }, mcp(member, session)),
    );
    const waiting = await pending(
      invoke("person.create", { displayName: unique("Wait") }, mcp(member, session)),
    );
    await invoke("approval.reject", { actionIds: [old.actionId, recent.actionId] }, context(admin));
    await decideDaysAgo(old.actionId, 31);
    // An extension proposal hangs off its pending action (stage 3b); it is compacted with it.
    const fileDiff = [
      {
        path: "src/index.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        hunks: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [{ op: "+", text: "x" }] },
        ],
      },
    ];
    await env.DB.prepare(
      `INSERT INTO core_extension_proposals (action_id, extension_id, commit_oid, source, version,
         message, diff, impact, check_result, created_by, created_at)
       VALUES (?, 'example', 'abc', 'runtime', '1.0.0', 'm', ?, '{}', '{"ok":true,"issues":[],"plan":{}}', ?, ?)`,
    )
      .bind(old.actionId, JSON.stringify(fileDiff), member.id, new Date().toISOString())
      .run();
    await decideDaysAgo(recent.actionId, 10);

    const { result, rows } = await measure(() =>
      compactPendingActions(meteredDb.query, new Date().toISOString()),
    );
    expect(result).toEqual({ compacted: 1, more: false });
    expect(rows).toBeLessThan(50);
    await expectNoFullScans(recorded);

    const view = await actionView(old);
    expect(view).toMatchObject({
      status: "rejected",
      operation: "person.create",
      input: null,
      preview: [],
      summary: { records: 1, actions: { create: 1 } },
    });
    expect(view.compactedAt).toBeTruthy();
    expect(view.decidedBy).toBe(admin.id);
    for (const p of [recent, waiting]) {
      const v = await actionView(p);
      expect(v.compactedAt).toBeNull();
      expect(v.preview).toHaveLength(1);
    }
    const proposal = await env.DB.prepare(
      "SELECT diff, check_result FROM core_extension_proposals WHERE action_id = ?",
    )
      .bind(old.actionId)
      .first<{ diff: string; check_result: string }>();
    expect(JSON.parse(proposal?.diff ?? "[]")).toEqual([
      {
        path: "src/index.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        hunks: [],
        truncated: true,
      },
    ]);
    expect(JSON.parse(proposal?.check_result ?? "{}")).toEqual({ ok: true, compacted: true });
    // Idempotent: compacted rows are not touched again.
    expect(await compactPendingActions(db.query, new Date().toISOString())).toEqual({
      compacted: 0,
      more: false,
    });
    await setPreset("balanced");
  });
});

// --- Erase still works with aggregated reads and compacted actions (ADR 0019) ------------

describe("erase with aggregated reads and compacted actions", () => {
  it("erases a person that MCP read and that a compacted pending action touched", async () => {
    const email = `${unique("gone")}@example.com`;
    const person = await invoke(
      "person.create",
      { displayName: "Erasable Person", emails: [{ email }] },
      context(member),
    );
    const session = `cap_${unique()}`;
    // Successful MCP reads are counted, not stored with their input.
    await invoke("search.global", { query: email }, mcp(member, session));
    await invoke("person.get", { id: person.id }, mcp(member, session));
    expect(
      await count(
        "SELECT count(*) AS n FROM core_audit WHERE instr(lower(input), ?) > 0 AND operation IN ('search.global', 'person.get')",
        email,
      ),
    ).toBe(0);
    expect(
      await count(
        "SELECT coalesce(sum(count), 0) AS n FROM core_audit_read_counts WHERE caller = ?",
        session,
      ),
    ).toBe(2);

    await setPreset("cautious");
    const queued = await pending(
      invoke("person.update", { id: person.id, location: "Somewhere" }, mcp(member, session)),
    );
    await invoke("approval.reject", { actionIds: [queued.actionId] }, context(admin));
    await env.DB.prepare(
      "UPDATE core_pending_action SET decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-40 days') WHERE id = ?",
    )
      .bind(queued.actionId)
      .run();
    expect(
      (await compactPendingActions(db.query, new Date().toISOString())).compacted,
    ).toBeGreaterThanOrEqual(1);
    await setPreset("balanced");

    const erased = await invoke("person.erase", { id: person.id }, context(admin));
    expect(erased.erased).toEqual([person.id]);
    expect(await count("SELECT count(*) AS n FROM core_person WHERE id = ?", person.id)).toBe(0);
    // The compacted action was found through its record link and redacted like any other.
    const action = await env.DB.prepare(
      "SELECT input, reason, summary FROM core_pending_action WHERE id = ?",
    )
      .bind(queued.actionId)
      .first<{ input: string; reason: string; summary: string }>();
    expect(action).toMatchObject({ input: '"[erased]"', reason: "[erased]" });
    expect(action?.summary).not.toContain(email);
    // Nothing anywhere in the audit tables still holds the email; read counts hold only ids.
    expect(
      await count(
        "SELECT count(*) AS n FROM core_audit WHERE instr(lower(input || coalesce(result, '') || coalesce(error, '')), ?) > 0",
        email,
      ),
    ).toBe(0);
    expect(
      await count("SELECT count(*) AS n FROM core_audit_read_counts WHERE caller = ?", session),
    ).toBeGreaterThan(0);
  });
});

// --- Storage gauge -----------------------------------------------------------------------

describe("storage gauge", () => {
  it("measures row counts into the cache and reports size against the 10 GB cap", async () => {
    const stats = await measureStorage(db, new Date().toISOString());
    expect(stats.tables.core_audit).toBeGreaterThan(0);
    const status = await invoke("storage.status", {}, context(admin));
    expect(status.capBytes).toBe(10_000_000_000);
    expect(status.measuredAt).toBe(stats.measuredAt);
    expect(status.tables.find((t) => t.table === "core_audit")?.rows).toBe(stats.tables.core_audit);
    expect(["ok", "unknown"]).toContain(status.level);
    await expect(invoke("storage.status", {}, context(member))).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    // A status read costs a handful of rows, not a count of every table.
    const { rows } = await measure(() =>
      invoke("storage.status", {}, { ...context(admin), db: meteredDb }),
    );
    expect(rows).toBeLessThan(20);

    // A refresh right after a measurement returns the cached one.
    const refreshed = await invoke("storage.refresh", {}, context(admin));
    expect(refreshed.measuredAt).toBe(stats.measuredAt);
  });
});
