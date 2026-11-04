// WebhookEndpoint: one Durable Object per endpoint id (`idFromName(endpointId)`). It holds the
// endpoint's scheme and signing secret, verifies and shapes deliveries, keeps the recent events
// and the ids it has seen, and delivers each new event to the bound hook through the kit's
// hook-delivery queue, retried from its alarm.

import { DurableObject } from "cloudflare:workers";
import type {
  HookTargetMetadata,
  ObservationDescription,
} from "@crm/gatekeeper-interface/gatekeeper";
import { HookDeliveryQueue } from "@crm/gatekeeper-kit/hook-delivery-queue";
import { shapeDelivery } from "./shape.js";
import type { WebhookEvent, WebhookScheme } from "./types.js";
import { type RejectionReason, verifySignature } from "./verify.js";

/** Recent verified events kept for `listEvents()`. */
export const MAX_RECENT_EVENTS = 100;
/** Delivery ids remembered for replay dedupe: this many, for this long. */
const MAX_SEEN_IDS = 10_000;
const SEEN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const CONFIG = "config";
const STATS = "stats";
const HOOK = "hook";
/** The initiator stub, stored on its own beside the hook's record. */
const HOOK_INITIATOR = "hook:initiator";

type Config = { endpointId: string; scheme: WebhookScheme; secret: string; configuredAt: number };

type Stats = {
  accepted: number;
  duplicates: number;
  rejected: number;
  lastReceivedAt?: string;
  lastRejectedAt?: string;
  lastRejectionReason?: RejectionReason;
};

/** What `HookInitiator.startHook()` returns, as this DO uses it. */
type StartedHook = {
  callback: { receiveEvent(event: WebhookEvent): Promise<void> } & Partial<Disposable>;
  approvalQueue: {
    authorizeObservation(description: ObservationDescription): Promise<void>;
  } & Partial<Disposable>;
};

/** The persistent initiator stub the host handed `HookController.enable()`. */
export type StoredInitiator = { startHook(): Promise<StartedHook> } & Partial<Disposable>;

type HookRecord = {
  /** Names this enablement's deliveries in the queue; a fresh one per enable after a disable. */
  key: string;
  target: HookTargetMetadata;
  enabledAt: number;
};

/** The endpoint's state for the admin UI. Never includes the secret. */
export type EndpointStatus = {
  endpointId: string;
  configured: boolean;
  scheme: WebhookScheme | null;
  configuredAt: string | null;
  hookEnabled: boolean;
  accepted: number;
  duplicates: number;
  rejected: number;
  lastReceivedAt: string | null;
  lastRejectedAt: string | null;
  lastRejectionReason: RejectionReason | null;
};

/** What the Worker's fetch handler should answer a delivery with. */
export type ReceiveResult = {
  status: number;
  body: { ok?: boolean; id?: string; duplicate?: boolean; error?: string; challenge?: string };
};

export class WebhookEndpoint extends DurableObject<Cloudflare.Env> {
  readonly #queue: HookDeliveryQueue<WebhookEvent>;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    // Never log the event: its payload is the external system's private data.
    this.#queue = new HookDeliveryQueue<WebhookEvent>(ctx.storage.kv, () =>
      console.warn("webhook: dropped an event after repeated delivery failures"),
    );
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL,
        event TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS seen_at ON seen (at);
    `);
  }

  /** Sets the scheme and secret. Called only from the host-facing configurator capability. */
  async configure(endpointId: string, scheme: WebhookScheme, secret: string): Promise<void> {
    this.ctx.storage.kv.put<Config>(CONFIG, {
      endpointId,
      scheme,
      secret,
      configuredAt: Date.now(),
    });
  }

  async status(endpointId: string): Promise<EndpointStatus> {
    const config = this.ctx.storage.kv.get<Config>(CONFIG);
    const stats = this.#stats();
    return {
      endpointId,
      configured: config !== undefined,
      scheme: config?.scheme ?? null,
      configuredAt: config ? new Date(config.configuredAt).toISOString() : null,
      hookEnabled: this.ctx.storage.kv.get<HookRecord>(HOOK) !== undefined,
      accepted: stats.accepted,
      duplicates: stats.duplicates,
      rejected: stats.rejected,
      lastReceivedAt: stats.lastReceivedAt ?? null,
      lastRejectedAt: stats.lastRejectedAt ?? null,
      lastRejectionReason: stats.lastRejectionReason ?? null,
    };
  }

  /**
   * Verifies, shapes, dedupes, stores and queues one delivery.
   * @param headers The request headers, lower-case names.
   * @param body The raw body, already bounded by the fetch handler.
   */
  async receive(headers: Record<string, string>, body: Uint8Array): Promise<ReceiveResult> {
    const config = this.ctx.storage.kv.get<Config>(CONFIG);
    if (!config) return { status: 404, body: { ok: false, error: "unknown endpoint" } };

    const now = Date.now();
    const verified = await verifySignature(
      config.scheme,
      config.secret,
      headers,
      body,
      Math.floor(now / 1000),
    );
    if (!verified.ok) {
      const stats = this.#stats();
      stats.rejected++;
      stats.lastRejectedAt = new Date(now).toISOString();
      stats.lastRejectionReason = verified.reason;
      this.ctx.storage.kv.put(STATS, stats);
      return { status: 401, body: { ok: false, error: verified.reason } };
    }

    const shaped = shapeDelivery({
      endpointId: config.endpointId,
      scheme: config.scheme,
      headers,
      body,
      receivedAt: new Date(now),
    });
    if (shaped.kind === "slack-challenge") {
      return { status: 200, body: { challenge: shaped.challenge } };
    }
    const { event } = shaped;

    const stats = this.#stats();
    if (this.#seen(event.id)) {
      stats.duplicates++;
      this.ctx.storage.kv.put(STATS, stats);
      return { status: 200, body: { ok: true, id: event.id, duplicate: true } };
    }

    const sql = this.ctx.storage.sql;
    sql.exec("INSERT INTO seen (id, at) VALUES (?, ?)", event.id, now);
    sql.exec(
      "DELETE FROM seen WHERE at < ? OR id IN (SELECT id FROM seen ORDER BY at DESC LIMIT -1 OFFSET ?)",
      now - SEEN_RETENTION_MS,
      MAX_SEEN_IDS,
    );
    sql.exec("INSERT INTO events (id, event) VALUES (?, ?)", event.id, JSON.stringify(event));
    sql.exec(
      "DELETE FROM events WHERE seq NOT IN (SELECT seq FROM events ORDER BY seq DESC LIMIT ?)",
      MAX_RECENT_EVENTS,
    );
    stats.accepted++;
    stats.lastReceivedAt = event.receivedAt;
    this.ctx.storage.kv.put(STATS, stats);

    const hook = this.ctx.storage.kv.get<HookRecord>(HOOK);
    if (hook) {
      this.#queue.enqueue(hook.key, event.id, event, now);
      await this.ctx.storage.setAlarm(now);
    }
    return { status: 200, body: { ok: true, id: event.id } };
  }

  /** The most recent events, newest first. */
  async listEvents(limit: number): Promise<WebhookEvent[]> {
    const rows = this.ctx.storage.sql
      .exec<{ event: string }>("SELECT event FROM events ORDER BY seq DESC LIMIT ?", limit)
      .toArray();
    return rows.map((row) => JSON.parse(row.event) as WebhookEvent);
  }

  /**
   * Enables (with an initiator) or disables (null) the hook. Re-enabling an enabled hook replaces
   * its initiator and keeps its pending deliveries.
   */
  async setHook(initiator: StoredInitiator | null, target?: HookTargetMetadata): Promise<void> {
    const existing = this.ctx.storage.kv.get<HookRecord>(HOOK);
    if (initiator === null) {
      if (existing) {
        this.#queue.cancel(existing.key);
        this.ctx.storage.kv.delete(HOOK);
        this.ctx.storage.kv.delete(HOOK_INITIATOR);
      }
      return;
    }
    this.ctx.storage.kv.put(HOOK_INITIATOR, initiator);
    this.ctx.storage.kv.put<HookRecord>(HOOK, {
      key: existing?.key ?? crypto.randomUUID(),
      target: target ?? { workspaceId: "" },
      enabledAt: Date.now(),
    });
  }

  override async alarm(): Promise<void> {
    await this.#queue.run(Date.now(), (hookKey, event) => this.#deliver(hookKey, event));
    const next = this.#queue.nextDue();
    if (next !== undefined) await this.ctx.storage.setAlarm(next);
  }

  async #deliver(hookKey: string, event: WebhookEvent): Promise<void> {
    const hook = this.ctx.storage.kv.get<HookRecord>(HOOK);
    // Disabled, or re-enabled afresh since: the delivery is finished without being made.
    const initiator = this.ctx.storage.kv.get<StoredInitiator>(HOOK_INITIATOR);
    if (!hook || hook.key !== hookKey || !initiator) return;
    const started = await initiator.startHook();
    try {
      await started.approvalQueue.authorizeObservation({
        title: `Webhook event ${event.type}`,
        description:
          `Received a verified \`${event.type}\` event (id \`${event.id}\`) at webhook endpoint ` +
          `\`${event.endpointId}\` (${event.scheme} signature) at ${event.receivedAt}.`,
      });
      await started.callback.receiveEvent(event);
    } finally {
      started.callback[Symbol.dispose]?.();
      started.approvalQueue[Symbol.dispose]?.();
      initiator[Symbol.dispose]?.();
    }
  }

  #seen(id: string): boolean {
    return this.ctx.storage.sql.exec("SELECT 1 FROM seen WHERE id = ?", id).toArray().length > 0;
  }

  #stats(): Stats {
    return this.ctx.storage.kv.get<Stats>(STATS) ?? { accepted: 0, duplicates: 0, rejected: 0 };
  }
}
