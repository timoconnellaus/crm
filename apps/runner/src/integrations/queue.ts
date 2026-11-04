// The integration host's ApprovalQueue (the Workshop side of the gatekeeper interface, ADR 0050,
// ADR 0051, ADR 0111). One per session (or hook firing), bound to whoever is calling: an actor
// (MCP, assistant, extension, automation, a person) or the system (sync, webhooks).
//
// - authorizeObservation: reads by actors are counted (ADR 0090); a read the gatekeeper flags
//   containsRestrictedData is refused for anyone but the connection's owner, and marked on the
//   tracker so sync never writes it (ADR 0052).
// - submitAction: the gate decides at once as risk `outbound` (core `submitOutbound`): review
//   mirrors it into the caller's change set; auto applies it right after the call; deny rejects.
// - bindHook: system hooks (sync, webhooks) are enabled at once (their owner consented when
//   turning sync on or creating the endpoint); hooks agents ask for wait (stage 5 binds them).
import { RpcTarget } from "cloudflare:workers";
import {
  type ActingUser,
  auditOutboundApplied,
  type IntegrationCaller,
  type OutboundDescription,
  type OutboundSubmission,
  type PendingApproval,
  parseFloor,
  readCountHour,
  submitOutbound,
} from "@crm/core";
import { createCrmDb } from "@crm/db";

export type QueueCaller =
  | { kind: "actor"; caller: IntegrationCaller; user: ActingUser }
  | { kind: "system"; purpose: "sync" | "webhook" | "probe"; user: ActingUser };

export interface ObservationRecord {
  title: string;
  restricted: boolean;
}

/** Observations seen through one queue, so the sync service can tell restricted reads apart. */
export class ObservationTracker {
  restricted = false;
  count = 0;
  reset(): void {
    this.restricted = false;
  }
}

/** What the host gives each queue: where it is, and how to apply or reject an action later. */
export interface QueueHost {
  env: Env;
  connectionId: string;
  connectionTitle: string;
  vendor: string;
  ownerUserId: string;
  facetKey: string;
  resourceTitle: string;
  apply(facetKey: string, action: number): Promise<void>;
  reject(facetKey: string, action: number): Promise<void>;
  /** Keeps a hook controller stub in the host's storage; returns its hook id. */
  stashController(controller: unknown): Promise<string>;
  enableHook(
    id: string,
    facetKey: string,
    purpose: "sync" | "webhook",
    description: { title: string; description: string },
  ): Promise<void>;
  recordAgentHook(
    id: string,
    facetKey: string,
    description: { title: string; description: string },
  ): Promise<void>;
}

export class HostQueue extends RpcTarget {
  readonly #host: QueueHost;
  readonly #caller: QueueCaller;
  readonly tracker = new ObservationTracker();
  readonly pending: PendingApproval[] = [];
  readonly applied: { action: number; actionKind: string | null; title: string }[] = [];
  /** Work that must finish before the call returns (auto-applies, hook enables). */
  readonly deferred: Promise<unknown>[] = [];

  constructor(host: QueueHost, caller: QueueCaller) {
    super();
    this.#host = host;
    this.#caller = caller;
  }

  async authorizeObservation(description: {
    title?: string;
    containsRestrictedData?: boolean;
  }): Promise<void> {
    const restricted = description?.containsRestrictedData === true;
    const user = this.#caller.user;
    if (restricted && user.id !== this.#host.ownerUserId) {
      throw new Error(
        "This read contains restricted data: only the connection's owner may see it (ADR 0052)",
      );
    }
    this.tracker.count += 1;
    if (restricted) this.tracker.restricted = true;
    if (this.#caller.kind === "actor" && this.#caller.caller.actor !== "human") {
      await this.#countRead(this.#caller.caller);
    }
  }

  /** One upsert per hour, actor, user, caller and vendor (ADR 0090), never the content. */
  async #countRead(caller: IntegrationCaller): Promise<void> {
    const now = new Date().toISOString();
    const o = caller.origin;
    try {
      await this.#host.env.DB.prepare(
        `INSERT INTO core_audit_read_counts (hour, actor, user_id, caller, operation, count, simulated, first_at, last_at)
         VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)
         ON CONFLICT (hour, actor, user_id, caller, operation)
         DO UPDATE SET count = count + 1, last_at = excluded.last_at`,
      )
        .bind(
          readCountHour(now),
          caller.actor,
          caller.userId,
          o.sessionId ?? o.extensionId ?? o.automationId ?? o.clientId ?? "",
          `gatekeeper.${this.#host.vendor}.observe`,
          now,
          now,
        )
        .run();
    } catch (error) {
      console.error("failed to count an observation", error);
    }
  }

  async submitAction(action: number, description: OutboundDescription): Promise<void> {
    const host = this.#host;
    const caller =
      this.#caller.kind === "actor"
        ? this.#caller.caller
        : {
            actor: "automation" as const,
            userId: this.#caller.user.id,
            userName: this.#caller.user.name,
            role: this.#caller.user.role,
            origin: {
              surface: "automation" as const,
              automationId: `${this.#caller.purpose}:${host.connectionId}`,
            },
          };
    const submission: OutboundSubmission = {
      connectionId: host.connectionId,
      connectionTitle: host.connectionTitle,
      vendor: host.vendor,
      facetKey: host.facetKey,
      resourceTitle: host.resourceTitle,
      action,
      description,
      actor: caller.actor,
      user: this.#caller.user,
      origin: caller.origin,
      reason: caller.reason,
      floor: parseFloor(host.env.APPROVAL_FLOOR),
    };
    const db = createCrmDb(host.env.DB);
    const decision = await submitOutbound(db, submission);
    if (decision.decision === "review") {
      this.pending.push(decision.pending);
      return;
    }
    // Apply or reject once submitAction has returned: the gatekeeper is still inside the call
    // that submitted it.
    const later = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(async () => {
      if (decision.decision === "deny") {
        await host.reject(host.facetKey, action);
        return;
      }
      try {
        await host.apply(host.facetKey, action);
        this.applied.push({
          action,
          actionKind: description.actionKind?.tag ?? null,
          title: description.title,
        });
        await auditOutboundApplied(db, submission, { ok: true });
      } catch (error) {
        await auditOutboundApplied(db, submission, {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
    this.deferred.push(later);
  }

  async bindHook(
    controller: unknown,
    _callback: unknown,
    description: { title: string; description: string },
  ): Promise<void> {
    const host = this.#host;
    const d = {
      title: String(description?.title ?? "Hook").slice(0, 200),
      description: String(description?.description ?? "").slice(0, 2000),
    };
    // The controller is a persistent stub: store it now, while it is still ours.
    const id = await host.stashController(controller);
    if (this.#caller.kind === "system" && this.#caller.purpose !== "probe") {
      const purpose = this.#caller.purpose;
      // Enable it once bindHook has returned to the gatekeeper.
      this.deferred.push(
        new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() =>
          host.enableHook(id, host.facetKey, purpose, d),
        ),
      );
      return;
    }
    await host.recordAgentHook(id, host.facetKey, d);
  }

  getGitCache(): never {
    throw new Error("This CRM hosts no git cache");
  }

  /** Waits for the auto-applies and hook enables this queue scheduled. */
  async settle(): Promise<void> {
    while (this.deferred.length) {
      const batch = this.deferred.splice(0);
      await Promise.allSettled(batch);
    }
  }
}
