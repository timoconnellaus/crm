// Outbound approvals (stage 6 AC2, ADR 0051): gatekeeper actions mirrored into the approval queue
// as `outbound` items, in mixed change sets, with dependencies on provisional CRM ids, in-order
// apply per facet, rejection cascades and the autoApprovable + admin-enabled rule.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type IntegrationRuntime,
  invokeByName,
  type OutboundSubmission,
  PendingApprovalError,
  submitOutbound,
} from "../src/index.ts";
import { context, createUser, db, setPreset, unique } from "./helpers.ts";

interface Calls {
  applied: { connectionId: string; facetKey: string; action: number }[];
  rejected: { connectionId: string; facetKey: string; action: number }[];
  failOn?: number;
}

function fakeRuntime(calls: Calls): IntegrationRuntime {
  const no = () => Promise.reject(new Error("not used in this test"));
  return {
    availableVendors: async () => ["email-send"],
    startConnect: no,
    provision: no,
    redeem: no,
    reconnect: no,
    disconnect: no,
    bindResource: no,
    unbindResource: no,
    configure: no,
    supportedResources: no,
    call: no,
    types: no,
    setSync: no,
    syncNow: no,
    applyOutbound: async (input) => {
      if (input.action === calls.failOn) throw new Error("provider said no");
      calls.applied.push(input);
    },
    rejectOutbound: async (input) => {
      calls.rejected.push(input);
      return undefined;
    },
  };
}

let admin: ActingUser;
let member: ActingUser;
let calls: Calls;
let connectionId: string;
let session: string;

function submission(
  action: number,
  overrides: Partial<OutboundSubmission> & { tag?: string; autoApprovable?: boolean } = {},
): OutboundSubmission {
  const { tag = "email.send", autoApprovable = false, ...rest } = overrides;
  return {
    connectionId,
    connectionTitle: "Company mail",
    vendor: "email-send",
    facetKey: "f1",
    resourceTitle: "crm@example.com",
    action,
    description: {
      title: `Send email ${action}`,
      description: "**Hello** there",
      fields: [{ label: "To", value: "ada@example.org" }],
      implementsRevert: false,
      autoApprovable,
      actionKind: { tag, label: tag },
    },
    actor: "mcp",
    user: member,
    origin: { surface: "mcp", sessionId: session, clientName: "Claude" },
    reason: "Follow up",
    ...rest,
  };
}

function approve(input: Record<string, unknown>) {
  return invokeByName("approval.approve", input, {
    ...context(admin),
    integrations: fakeRuntime(calls),
  }) as Promise<{ results: { actionId: string; status: string }[] }>;
}

function reject(input: Record<string, unknown>) {
  return invokeByName("approval.reject", input, {
    ...context(admin),
    integrations: fakeRuntime(calls),
  }) as Promise<{ results: { actionId: string; status: string }[] }>;
}

async function row(id: string) {
  return env.DB.prepare("SELECT * FROM core_pending_action WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
}

beforeEach(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  calls = { applied: [], rejected: [] };
  connectionId = `con_${unique("c").toUpperCase()}`;
  session = `cap_${unique("s")}`;
  await setPreset("balanced");
});

describe("gate for outbound actions", () => {
  it("reviews everything outbound under Balanced, unless autoApprovable and admin-enabled", async () => {
    const tag = `email.internal.${unique("k")}`;
    const first = await submitOutbound(db, submission(1, { tag, autoApprovable: true }));
    expect(first.decision).toBe("review");

    // Only kinds the gatekeeper marks autoApprovable can be enabled, by a human admin.
    const other = `slack.post.${unique("k")}`;
    await submitOutbound(db, submission(2, { tag: other, autoApprovable: false, facetKey: "f2" }));
    await expect(
      invokeByName("outbound.setAutoApprove", { tag: other, enabled: true }, context(admin)),
    ).rejects.toThrow(/not marked auto-approvable/);
    await expect(
      invokeByName("outbound.setAutoApprove", { tag, enabled: true }, context(member)),
    ).rejects.toThrow(/role/);
    await expect(
      invokeByName(
        "outbound.setAutoApprove",
        { tag, enabled: true },
        context(admin, { actor: "mcp" }),
      ),
    ).rejects.toThrow(/cannot be called by mcp/);
    await invokeByName("outbound.setAutoApprove", { tag, enabled: true }, context(admin));
    const audit = await env.DB.prepare(
      "SELECT outcome FROM core_audit WHERE operation = 'outbound.setAutoApprove' AND user_id = ?",
    )
      .bind(admin.id)
      .all();
    expect(audit.results).toContainEqual({ outcome: "ok" });

    expect(
      (await submitOutbound(db, submission(3, { tag, autoApprovable: true, facetKey: "f3" })))
        .decision,
    ).toBe("auto");
    // The same kind submitted without the autoApprovable flag still waits.
    expect(
      (await submitOutbound(db, submission(4, { tag, autoApprovable: false, facetKey: "f4" })))
        .decision,
    ).toBe("review");
    // Cautious reviews even enabled kinds; humans are never queued.
    await setPreset("cautious");
    expect(
      (await submitOutbound(db, submission(5, { tag, autoApprovable: true, facetKey: "f5" })))
        .decision,
    ).toBe("review");
    expect(
      (
        await submitOutbound(
          db,
          submission(6, { actor: "human", origin: { surface: "ui" }, facetKey: "f6" }),
        )
      ).decision,
    ).toBe("auto");
    // The floor still applies.
    await setPreset("balanced");
    expect(
      (
        await submitOutbound(
          db,
          submission(7, {
            tag,
            autoApprovable: true,
            facetKey: "f7",
            floor: { mcp: { outbound: "review" } },
          }),
        )
      ).decision,
    ).toBe("review");
    expect(
      (
        await submitOutbound(
          db,
          submission(8, { facetKey: "f8", floor: { "*": { outbound: "deny" } } }),
        )
      ).decision,
    ).toBe("deny");
  });
});

describe("outbound items in the approval queue", () => {
  it("joins the caller's change set next to CRM changes and shows the gatekeeper's description", async () => {
    await setPreset("cautious");
    const mcp = context(member, { actor: "mcp", origin: { surface: "mcp", sessionId: session } });
    let pending: PendingApprovalError | null = null;
    try {
      await invokeByName("person.create", { displayName: "Ada Pending" }, mcp);
    } catch (error) {
      pending = error as PendingApprovalError;
    }
    expect(pending).toBeInstanceOf(PendingApprovalError);
    const create = pending?.pending;
    const outbound = await submitOutbound(db, submission(1));
    expect(outbound.decision).toBe("review");
    if (outbound.decision !== "review" || !create) throw new Error("expected review");
    expect(outbound.pending.changeSetId).toBe(create.changeSetId);

    const set = (await invokeByName(
      "approval.get",
      { changeSetId: create.changeSetId },
      context(admin),
    )) as {
      actions: {
        operation: string;
        risk: string;
        outbound: { title: string; fields: unknown[]; action: number } | null;
      }[];
    };
    expect(set.actions.map((a) => [a.operation, a.risk])).toEqual([
      ["person.create", "write"],
      ["integration.outbound", "outbound"],
    ]);
    expect(set.actions[1]?.outbound).toMatchObject({
      title: "Send email 1",
      action: 1,
      fields: [{ label: "To", value: "ada@example.org" }],
    });
  });

  it("depends on a provisional CRM id it mentions, and rejection cascades to it", async () => {
    await setPreset("cautious");
    const mcp = context(member, { actor: "mcp", origin: { surface: "mcp", sessionId: session } });
    const create = await invokeByName("person.create", { displayName: "Grace" }, mcp).catch(
      (e: PendingApprovalError) => e.pending,
    );
    const provisional = (create as { provisionalIds: string[] }).provisionalIds[0] ?? "";
    expect(provisional).toMatch(/^per_pending_/);
    const outbound = await submitOutbound(
      db,
      submission(1, {
        description: {
          title: "Welcome Grace",
          description: `Related record ${provisional}`,
          fields: [{ label: "Related", value: provisional }],
          actionKind: { tag: "email.send", label: "Send email" },
        },
      }),
    );
    if (outbound.decision !== "review") throw new Error("expected review");
    expect(outbound.pending.dependsOn).toEqual([(create as { actionId: string }).actionId]);

    // Approving the email before the create is refused.
    await expect(approve({ actionIds: [outbound.pending.actionId] })).rejects.toThrow(/depends on/);
    const result = await reject({ actionIds: [(create as { actionId: string }).actionId] });
    expect(result.results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect((await row(outbound.pending.actionId))?.status).toBe("rejected");
    // The facet is told to drop it.
    expect(calls.rejected).toEqual([{ connectionId, facetKey: "f1", action: 1 }]);
  });

  it("an auto-approvable action mentioning a provisional id still waits", async () => {
    const tag = `email.internal.${unique("k")}`;
    await submitOutbound(db, submission(1, { tag, autoApprovable: true }));
    await invokeByName("outbound.setAutoApprove", { tag, enabled: true }, context(admin));
    const result = await submitOutbound(
      db,
      submission(2, {
        tag,
        autoApprovable: true,
        description: {
          title: "x",
          description: "per_pending_01JC9Z6X0V8M4T3K2Q1W5E7R9Y",
          autoApprovable: true,
          actionKind: { tag, label: tag },
        },
      }),
    );
    expect(result.decision).toBe("review");
  });

  it("applies in action order per facet and refuses out-of-order approval", async () => {
    const a = await submitOutbound(db, submission(1));
    const b = await submitOutbound(db, submission(2));
    const other = await submitOutbound(db, submission(1, { facetKey: "other" }));
    if (a.decision !== "review" || b.decision !== "review" || other.decision !== "review") {
      throw new Error("expected review");
    }
    await expect(approve({ actionIds: [b.pending.actionId] })).rejects.toThrow(/in order/);
    // Another facet's action is independent.
    await approve({ actionIds: [other.pending.actionId] });
    expect(calls.applied).toEqual([{ connectionId, facetKey: "other", action: 1 }]);

    const result = await approve({ changeSetId: a.pending.changeSetId });
    expect(result.results.map((r) => r.status)).toEqual(["applied", "applied"]);
    expect(calls.applied.slice(1)).toEqual([
      { connectionId, facetKey: "f1", action: 1 },
      { connectionId, facetKey: "f1", action: 2 },
    ]);
    expect((await row(b.pending.actionId))?.status).toBe("applied");
    const audits = await env.DB.prepare(
      "SELECT gate_decision, outcome FROM core_audit WHERE pending_action_id = ? ORDER BY at",
    )
      .bind(b.pending.actionId)
      .all();
    expect(audits.results).toEqual([
      { gate_decision: "review", outcome: "review" },
      { gate_decision: "review", outcome: "ok" },
    ]);
  });

  it("a failed apply fails the item and skips what depends on it, dropping it on its facet", async () => {
    await setPreset("cautious");
    const mcp = context(member, { actor: "mcp", origin: { surface: "mcp", sessionId: session } });
    const first = await submitOutbound(db, submission(1));
    if (first.decision !== "review") throw new Error("expected review");
    // A later outbound item mentioning a pending create that comes after the failing one.
    const create = (await invokeByName("person.create", { displayName: "Linus" }, mcp).catch(
      (e: PendingApprovalError) => e.pending,
    )) as { provisionalIds: string[] };
    const second = await submitOutbound(
      db,
      submission(2, {
        facetKey: "f9",
        description: {
          title: "x",
          description: create.provisionalIds[0] ?? "",
          actionKind: { tag: "email.send", label: "Send" },
        },
      }),
    );
    if (second.decision !== "review") throw new Error("expected review");
    calls.failOn = 1;
    const result = await approve({ changeSetId: first.pending.changeSetId });
    expect(result.results.find((r) => r.actionId === first.pending.actionId)?.status).toBe(
      "failed",
    );
    expect((await row(first.pending.actionId))?.status_reason).toMatch(/provider said no/);
    expect(calls.applied).toEqual([{ connectionId, facetKey: "f9", action: 2 }]);
  });

  it("expired outbound items are dropped on their facets", async () => {
    const a = await submitOutbound(db, submission(1, { expiryDays: 0 }));
    if (a.decision !== "review") throw new Error("expected review");
    const { expirePendingActions } = await import("../src/index.ts");
    await expirePendingActions(
      db.query,
      new Date(Date.now() + 1000).toISOString(),
      fakeRuntime(calls),
    );
    expect(calls.rejected).toContainEqual({ connectionId, facetKey: "f1", action: 1 });
  });
});
