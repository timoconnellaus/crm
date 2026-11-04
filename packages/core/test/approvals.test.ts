// The approval queue and simulation (ADR 0022): pending actions, change sets, the session
// overlay, dependencies, approval, rejection cascades, conflicts and expiry.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type ActingUser,
  ConflictError,
  expirePendingActions,
  ForbiddenError,
  type InvocationContext,
  invoke,
  NotFoundError,
  type PendingApproval,
  PendingApprovalError,
} from "../src/index.ts";
import { context, createUser, setPreset, unique } from "./helpers.ts";

let member: ActingUser;
let reviewer: ActingUser;

beforeEach(async () => {
  member = await createUser("member");
  reviewer = await createUser("member");
  await setPreset("cautious");
});

function mcp(user: ActingUser, sessionId: string, extra: Partial<InvocationContext> = {}) {
  return context(user, {
    actor: "mcp",
    origin: { surface: "mcp", clientId: "client-1", clientName: "Test client", sessionId },
    reason: "Test reason",
    ...extra,
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

const human = () => context(reviewer);

describe("queueing", () => {
  it("queues a Cautious MCP create with a provisional id and a diff preview", async () => {
    const session = `cap_${unique()}`;
    const name = unique("Ada");
    const p = await pending(invoke("person.create", { displayName: name }, mcp(member, session)));
    expect(p.status).toBe("pending_approval");
    expect(p.provisionalIds).toHaveLength(1);
    expect(p.provisionalIds[0]).toMatch(/^per_pending_/);
    expect(p.simulated).toMatchObject({ id: p.provisionalIds[0], displayName: name });
    expect(p.message).toMatch(/NOT applied/);

    const real = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_person WHERE display_name = ?",
    )
      .bind(name)
      .first<{ n: number }>();
    expect(real?.n).toBe(0);

    const set = await invoke("approval.get", { changeSetId: p.changeSetId }, human());
    expect(set.clientName).toBe("Test client");
    expect(set.actions[0]).toMatchObject({
      operation: "person.create",
      reason: "Test reason",
      status: "pending",
      risk: "write",
    });
    expect(set.actions[0]?.preview[0]?.diff.displayName).toEqual({ before: null, after: name });
    const audit = await env.DB.prepare(
      "SELECT gate_decision, outcome, pending_action_id FROM core_audit WHERE pending_action_id = ?",
    )
      .bind(p.actionId)
      .first();
    expect(audit).toMatchObject({ gate_decision: "review", outcome: "review" });
  });

  it("under Balanced applies a single MCP update but queues updateMany of 2", async () => {
    await setPreset("balanced");
    const a = await invoke("person.create", { displayName: unique("A") }, context(member));
    const b = await invoke("person.create", { displayName: unique("B") }, context(member));
    const session = `cap_${unique()}`;
    const updated = await invoke(
      "person.update",
      { id: a.id, location: "Hobart" },
      mcp(member, session),
    );
    expect(updated.location).toBe("Hobart");
    const p = await pending(
      invoke(
        "person.updateMany",
        { ids: [a.id, b.id], set: { location: "Perth" } },
        mcp(member, session),
      ),
    );
    expect(p.operation).toBe("person.updateMany");
    const still = await invoke("person.get", { id: b.id }, context(member));
    expect(still.location).toBeNull();
  });

  it("refuses an update to a record still pending creation, with an explanation", async () => {
    const session = `cap_${unique()}`;
    const p = await pending(
      invoke("person.create", { displayName: unique("P") }, mcp(member, session)),
    );
    await expect(
      invoke(
        "person.update",
        { id: p.provisionalIds[0] as string, location: "x" },
        mcp(member, session),
      ),
    ).rejects.toThrow(/pending creation/);
  });
});

describe("simulation overlay", () => {
  it("shows the session its pending create and the activity logged on it; others see nothing", async () => {
    const session = `cap_${unique()}`;
    const name = unique("Grace");
    const created = await pending(
      invoke("person.create", { displayName: name }, mcp(member, session)),
    );
    const personId = created.provisionalIds[0] as string;
    const logged = await pending(
      invoke(
        "activity.log",
        {
          type: "note",
          body: "Met at the conference",
          links: [{ object: "person", id: personId }],
        },
        mcp(member, session),
      ),
    );
    expect(logged.dependsOn).toEqual([created.actionId]);

    const got = (await invoke("person.get", { id: personId }, mcp(member, session))) as Record<
      string,
      unknown
    >;
    expect(got).toMatchObject({ id: personId, displayName: name });
    expect(got.pending).toMatchObject({ actionId: created.actionId });

    const hits = await invoke("search.global", { query: name }, mcp(member, session));
    expect(hits.hits.map((h) => h.id)).toContain(personId);

    const timeline = await invoke(
      "activity.listForRecord",
      { object: "person", recordId: personId },
      mcp(member, session),
    );
    expect(timeline.items.map((i) => i.body)).toContain("Met at the conference");

    const list = await invoke("person.list", {}, mcp(member, session));
    expect(list.items.map((i) => i.id)).toContain(personId);

    // A different session, and the UI, read real data.
    const other = mcp(member, `cap_${unique()}`);
    await expect(invoke("person.get", { id: personId }, other)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect((await invoke("search.global", { query: name }, other)).hits).toEqual([]);
    expect((await invoke("search.global", { query: name }, context(member))).hits).toEqual([]);
  });

  it("shows pending updates and deletes of real records to the session only", async () => {
    await setPreset("cautious");
    const person = await invoke("person.create", { displayName: unique("Upd") }, context(member));
    const session = `cap_${unique()}`;
    await pending(
      invoke("person.update", { id: person.id, location: "Darwin" }, mcp(member, session)),
    );
    expect((await invoke("person.get", { id: person.id }, mcp(member, session))).location).toBe(
      "Darwin",
    );
    expect((await invoke("person.get", { id: person.id }, context(member))).location).toBeNull();
    await pending(invoke("person.delete", { id: person.id }, mcp(member, session)));
    await expect(
      invoke("person.get", { id: person.id }, mcp(member, session)),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("approving", () => {
  it("creates the person with a real id and re-points the activity", async () => {
    const session = `cap_${unique()}`;
    const name = unique("Lin");
    const created = await pending(
      invoke("person.create", { displayName: name }, mcp(member, session)),
    );
    const provisional = created.provisionalIds[0] as string;
    await pending(
      invoke(
        "activity.log",
        { type: "note", body: "Follow up", links: [{ object: "person", id: provisional }] },
        mcp(member, session),
      ),
    );
    const out = await invoke("approval.approve", { changeSetId: created.changeSetId }, human());
    expect(out.counts).toMatchObject({ applied: 2, failed: 0 });
    const realId = out.results[0]?.bindings?.[provisional] as string;
    expect(realId).toMatch(/^per_[0-9A-Z]{26}$/);
    const person = await invoke("person.get", { id: realId }, context(member));
    expect(person.displayName).toBe(name);
    expect(person.createdBy).toBe(member.id);
    const timeline = await invoke(
      "activity.listForRecord",
      { object: "person", recordId: realId },
      context(member),
    );
    expect(timeline.items[0]).toMatchObject({ body: "Follow up", authorActor: "mcp" });

    const status = await invoke(
      "approval.status",
      { changeSetId: created.changeSetId },
      mcp(member, session),
    );
    expect(status.changeSets[0]?.actions.map((a) => a.status)).toEqual(["applied", "applied"]);
    // The applied audit row links back to the pending action.
    const audit = await env.DB.prepare(
      "SELECT outcome, actor, gate_decision FROM core_audit WHERE pending_action_id = ? ORDER BY at, id",
    )
      .bind(created.actionId)
      .all();
    expect(audit.results.map((r) => r.outcome)).toEqual(["review", "ok"]);
    expect(audit.results[1]).toMatchObject({ actor: "mcp" });
    // The session no longer sees a simulated copy.
    await expect(
      invoke("person.get", { id: provisional }, mcp(member, session)),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses out-of-order approval", async () => {
    const session = `cap_${unique()}`;
    const created = await pending(
      invoke("person.create", { displayName: unique("O") }, mcp(member, session)),
    );
    const logged = await pending(
      invoke(
        "activity.log",
        {
          type: "note",
          body: "x",
          links: [{ object: "person", id: created.provisionalIds[0] as string }],
        },
        mcp(member, session),
      ),
    );
    await expect(
      invoke("approval.approve", { actionIds: [logged.actionId] }, human()),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("fails cleanly when the target was deleted meanwhile, and skips its dependents", async () => {
    const person = await invoke("person.create", { displayName: unique("Gone") }, context(member));
    const session = `cap_${unique()}`;
    const update = await pending(
      invoke("person.update", { id: person.id, location: "Cairns" }, mcp(member, session)),
    );
    const note = await pending(
      invoke(
        "activity.log",
        { type: "note", body: "y", links: [{ object: "person", id: person.id }] },
        mcp(member, session),
      ),
    );
    expect(note.dependsOn).toEqual([update.actionId]);
    await invoke("person.delete", { id: person.id }, context(member));
    const out = await invoke("approval.approve", { changeSetId: update.changeSetId }, human());
    expect(out.results.map((r) => r.status)).toEqual(["failed", "skipped"]);
    expect(out.results[0]?.statusReason).toMatch(/No person/);
  });

  it("fails with a conflict when the record changed after it was queued", async () => {
    const person = await invoke("person.create", { displayName: unique("Chg") }, context(member));
    const session = `cap_${unique()}`;
    const update = await pending(
      invoke("person.update", { id: person.id, location: "Alice Springs" }, mcp(member, session)),
    );
    await invoke("person.update", { id: person.id, location: "Broome" }, context(member));
    const out = await invoke("approval.approve", { actionIds: [update.actionId] }, human());
    expect(out.results[0]).toMatchObject({ status: "failed", error: { code: "conflict" } });
    expect((await invoke("person.get", { id: person.id }, context(member))).location).toBe(
      "Broome",
    );
  });

  it("is human-only", async () => {
    const session = `cap_${unique()}`;
    const p = await pending(
      invoke("person.create", { displayName: unique("H") }, mcp(member, session)),
    );
    await expect(
      invoke("approval.approve", { changeSetId: p.changeSetId }, mcp(member, session)),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("rejecting", () => {
  it("rejects the create and the dependent activity with it", async () => {
    const session = `cap_${unique()}`;
    const created = await pending(
      invoke("person.create", { displayName: unique("R") }, mcp(member, session)),
    );
    const logged = await pending(
      invoke(
        "activity.log",
        {
          type: "note",
          body: "z",
          links: [{ object: "person", id: created.provisionalIds[0] as string }],
        },
        mcp(member, session),
      ),
    );
    const out = await invoke("approval.reject", { actionIds: [created.actionId] }, human());
    expect(out.results.map((r) => [r.actionId, r.status])).toEqual([
      [created.actionId, "rejected"],
      [logged.actionId, "rejected"],
    ]);
    const status = await invoke(
      "approval.status",
      { actionId: logged.actionId },
      mcp(member, session),
    );
    expect(status.changeSets[0]?.actions[0]?.statusReason).toMatch(/depends on was rejected/);
  });
});

describe("change sets and expiry", () => {
  it("groups by explicit change sets with a title", async () => {
    const session = `cap_${unique()}`;
    const begun = await invoke(
      "changeset.begin",
      { title: "Offsite import" },
      mcp(member, session),
    );
    const p = await pending(
      invoke("person.create", { displayName: unique("C") }, mcp(member, session)),
    );
    expect(p.changeSetId).toBe(begun.changeSetId);
    const committed = await invoke("changeset.commit", {}, mcp(member, session));
    expect(committed).toMatchObject({
      id: begun.changeSetId,
      state: "committed",
      title: "Offsite import",
    });
    const next = await pending(
      invoke("person.create", { displayName: unique("D") }, mcp(member, session)),
    );
    expect(next.changeSetId).not.toBe(begun.changeSetId);
  });

  it("expires pending actions after the configured period", async () => {
    const session = `cap_${unique()}`;
    const t0 = new Date("2026-11-01T00:00:00.000Z");
    const p = await pending(
      invoke(
        "person.create",
        { displayName: unique("E") },
        mcp(member, session, { clock: () => t0, approvalExpiryDays: 2 }),
      ),
    );
    expect(p.expiresAt).toBe("2026-11-03T00:00:00.000Z");
    const later = () => new Date("2026-11-03T00:00:01.000Z");
    const status = await invoke(
      "approval.status",
      { actionId: p.actionId },
      mcp(member, session, { clock: later }),
    );
    expect(status.changeSets[0]?.actions[0]?.status).toBe("expired");
    await expect(
      invoke("approval.approve", { actionIds: [p.actionId] }, context(reviewer, { clock: later })),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(
      await expirePendingActions(context(member).db.query, later().toISOString()),
    ).toBeGreaterThan(0);
  });

  it("lists change sets and record badges", async () => {
    const person = await invoke("person.create", { displayName: unique("Badge") }, context(member));
    const session = `cap_${unique()}`;
    const p = await pending(
      invoke("person.update", { id: person.id, location: "Bunbury" }, mcp(member, session)),
    );
    const list = await invoke("approval.list", {}, human());
    expect(list.items.map((s) => s.id)).toContain(p.changeSetId);
    expect(list.pendingCount).toBeGreaterThan(0);
    const badges = await invoke(
      "approval.pendingForRecord",
      { object: "person", ids: [person.id] },
      human(),
    );
    expect(badges.items[0]).toMatchObject({ actionId: p.actionId, action: "update" });
  });
});

describe("token scopes", () => {
  it("intersects the role with granted permissions", async () => {
    await setPreset("balanced");
    const readOnly = mcp(member, `cap_${unique()}`, { grantedPermissions: ["records:read"] });
    await expect(
      invoke("person.create", { displayName: unique("S") }, readOnly),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const viewer = await createUser("viewer");
    const wide = mcp(viewer, `cap_${unique()}`, {
      grantedPermissions: ["records:read", "records:write"],
    });
    await expect(
      invoke("person.create", { displayName: unique("V") }, wide),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
