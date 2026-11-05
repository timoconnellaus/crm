// The integration host (ADR 0050, ADR 0110): the Workshop side of the Cloudflare OS gatekeeper
// interface. ONE DURABLE OBJECT PER CONNECTION (`INTEGRATION_HOST.getByName(connectionId)`), so
// no single object carries the deployment's gatekeeper traffic (cost audit U10); listing comes
// from the D1 mirror.
//
// It owns, in its own storage (the only place persistent RPC stubs can live,
// allow_irrevocable_stub_storage):
// - the connected account (`Fetcher<GatekeeperUser>`), and a companion account (Slack posting);
// - the staged account of a connect or reconnect, until its ticket is redeemed;
// - one gatekeeper facet per bound resource, keyed by a hash of the resource URL, created from
//   the class stub `getGatekeeperClassFor(url)` returned (and recreated from it after a restart);
// - hook controllers and their purpose (sync, webhook, or an agent's request awaiting stage 5);
// - sync state (backfill and catch-up cursors), driven by alarms.
// D1 holds only the mirror (core_integration_connection) the UI and operations read.
import { DurableObject, RpcTarget } from "cloudflare:workers";
import {
  type ActingUser,
  type BoundResource,
  type ConnectRedeemed,
  type ConnectStart,
  catalogueEntry,
  type IntegrationCaller,
  type IntegrationCallResult,
  invokeByName,
  ROLES,
  type Role,
  recordIntegrationEvents,
  revokeBindings,
  SYNC_BATCH_MAX,
  type SyncConfig,
  syncedInWindow,
  syncKindOf,
  vendorBinding,
} from "@relationship-os/core";
import { createCrmDb } from "@relationship-os/db";
import { HostQueue, type QueueCaller, type QueueHost } from "./queue.ts";
import { adapterFor, type SyncKind } from "./sync.ts";

// biome-ignore lint/suspicious/noExplicitAny: gatekeeper accounts, facets and sessions are RPC stubs whose types live in each vendor's package; the host treats them structurally.
type Stub = any;

const STAGE_TTL_MS = 15 * 60_000;
const CATCH_UP_MS = 15 * 60_000;
const BACKFILL_STEP_MS = 1_000;
const SYNC_SOON_MS = 5_000;
const SYNC_PAGE = 25;
const RECONCILE_WINDOW_MS = 7 * 86_400_000;

interface Meta {
  connectionId: string;
  vendor: string;
  scope: "personal" | "org";
  ownerUserId: string;
  title: string;
}

interface PendingConnect {
  vendor: string;
  userId: string;
  nonceHash: string;
  appOrigin: string;
  mode: "connect" | "reconnect" | "companion";
  startedAt: number;
}

interface Staged {
  vendor: string;
  ticketHash: string;
  expiresAt: number;
  mode: "connect" | "reconnect" | "companion";
  stageId?: string;
}

interface FacetRecord {
  key: string;
  url: string;
  pattern: string;
  title: string;
  tsType: string;
  bindingName: string;
  hookTsType?: string;
  /** The account that minted it: the connection's vendor or its companion. */
  vendor: string;
}

interface HookRecord {
  id: string;
  facetKey: string;
  purpose: "sync" | "webhook" | "agent";
  title: string;
  description: string;
  enabled: boolean;
}

interface SyncState {
  config: SyncConfig;
  mail?: KindState;
  calendar?: KindState;
}

interface KindState {
  resource: string;
  cursor: string | null;
  since: string;
  backfilled: boolean;
  lastError?: string | null;
  lastRunAt?: string;
  created?: number;
  restricted?: number;
  /** Delete reconciliation walks 7-day windows from `since`; the next one starts here. */
  reconcileFrom?: string;
  deleted?: number;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function token(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Plain JSON for a session's result: cursors give their first page, capabilities a marker. */
async function toJson(value: unknown, depth = 0): Promise<unknown> {
  if (value === null || value === undefined) return null;
  if (typeof value === "function") {
    // An RPC stub (a cursor or a capability). A cursor answers next().
    try {
      const page = await (value as unknown as { next(): Promise<unknown> }).next();
      return depth < 2 ? toJson(page, depth + 1) : null;
    } catch {
      return "[capability]";
    }
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return Promise.all(value.slice(0, 200).map((v) => toJson(v, depth)));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = typeof v === "function" ? "[capability]" : await toJson(v, depth);
    }
    return out;
  }
  return value;
}

async function loadUser(env: Env, id: string): Promise<ActingUser> {
  const row = await env.DB.prepare("SELECT id, email, name, role FROM core_user WHERE id = ?")
    .bind(id)
    .first<{ id: string; email: string; name: string; role: string }>();
  if (!row) throw new Error(`The user ${id} no longer exists`);
  const role = (ROLES as readonly string[]).includes(row.role) ? (row.role as Role) : "viewer";
  return { id: row.id, email: row.email, name: row.name, role };
}

/** Sync hooks call back with whatever their gatekeeper's hook interface names; all mean "pull". */
class SyncHookTarget extends RpcTarget {
  readonly #poke: () => Promise<void>;
  constructor(poke: () => Promise<void>) {
    super();
    this.#poke = poke;
  }
  changed() {
    return this.#poke();
  }
  receiveMessage(_entry: unknown) {
    return this.#poke();
  }
  receiveEvent(_event: unknown) {
    return this.#poke();
  }
  newMessage(_entry: unknown) {
    return this.#poke();
  }
}

/** Webhook deliveries become integration events (stage 5 triggers on them). */
class WebhookSink extends RpcTarget {
  readonly #env: Env;
  readonly #connectionId: string;
  constructor(env: Env, connectionId: string) {
    super();
    this.#env = env;
    this.#connectionId = connectionId;
  }
  async receiveEvent(event: {
    id?: string;
    endpointId?: string;
    scheme?: string;
    type?: string;
    receivedAt?: string;
    payload?: unknown;
    headers?: Record<string, string>;
  }): Promise<void> {
    await recordIntegrationEvents(createCrmDb(this.#env.DB), [
      {
        source: "webhook",
        connectionId: this.#connectionId,
        type: String(event?.type ?? "webhook").slice(0, 200),
        externalId: event?.id ? `${event.endpointId ?? ""}:${event.id}` : null,
        payload: {
          endpointId: event?.endpointId ?? null,
          scheme: event?.scheme ?? null,
          payload: event?.payload ?? null,
          headers: event?.headers ?? {},
        },
        occurredAt: event?.receivedAt ?? new Date().toISOString(),
      },
    ]);
  }
}

export class IntegrationHost extends DurableObject<Env> {
  /** Configurator `ui` capabilities by resource pattern, for this isolate's lifetime. */
  #configurators = new Map<string, Stub>();

  // --- State ----------------------------------------------------------------------------------

  async #meta(): Promise<Meta> {
    const meta = await this.ctx.storage.get<Meta>("meta");
    if (meta) return meta;
    // First use: read the mirror row the operation wrote.
    const id = this.ctx.id.name ?? "";
    const row = await this.env.DB.prepare(
      "SELECT id, vendor, scope, owner_user_id, title FROM core_integration_connection WHERE id = ?",
    )
      .bind(id)
      .first<{
        id: string;
        vendor: string;
        scope: "personal" | "org";
        owner_user_id: string;
        title: string;
      }>();
    if (!row) throw new Error(`No connection ${id}`);
    const fresh: Meta = {
      connectionId: row.id,
      vendor: row.vendor,
      scope: row.scope,
      ownerUserId: row.owner_user_id,
      title: row.title,
    };
    await this.ctx.storage.put("meta", fresh);
    return fresh;
  }

  #vendor(vendor: string): Stub {
    const binding = (this.env as unknown as Record<string, unknown>)[vendorBinding(vendor)];
    if (!binding) throw new Error(`The ${vendor} gatekeeper is not deployed here`);
    if (vendor === "fake" && this.env.INTEGRATIONS_FAKE_PROVIDER !== "true") {
      throw new Error("The fake provider is turned off");
    }
    return binding;
  }

  async #account(vendor?: string): Promise<Stub> {
    const meta = await this.#meta();
    const key = !vendor || vendor === meta.vendor ? "account" : `companion:${vendor}`;
    const account = await this.ctx.storage.get<Stub>(key);
    if (!account) throw new Error("This connection has no connected account yet");
    return account;
  }

  async #mirror(set: Record<string, unknown>): Promise<void> {
    const meta = await this.#meta();
    const columns = Object.keys(set);
    if (!columns.length) return;
    await this.env.DB.prepare(
      `UPDATE core_integration_connection SET ${columns.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
    )
      .bind(...columns.map((c) => set[c] ?? null), new Date().toISOString(), meta.connectionId)
      .run();
  }

  // --- Connect --------------------------------------------------------------------------------

  async startConnect(input: {
    vendor: string;
    userId: string;
    appOrigin?: string;
  }): Promise<ConnectStart> {
    const meta = await this.#meta();
    if (input.userId !== meta.ownerUserId)
      throw new Error("Only the connection's owner can connect it");
    return this.#begin(
      input.vendor,
      input.userId,
      input.appOrigin,
      input.vendor === meta.vendor ? "connect" : "companion",
    );
  }

  async #begin(
    vendor: string,
    userId: string,
    appOrigin: string | undefined,
    mode: PendingConnect["mode"],
  ): Promise<ConnectStart> {
    const meta = await this.#meta();
    const origin = appOrigin ?? this.env.APP_ORIGIN;
    if (!origin) throw new Error("The CRM's public origin is unknown (APP_ORIGIN)");
    const nonce = token();
    await this.ctx.storage.put<PendingConnect>("connect", {
      vendor,
      userId,
      nonceHash: await sha256(nonce),
      appOrigin: new URL(origin).origin,
      mode,
      startedAt: Date.now(),
    });
    let url: string;
    if (mode === "reconnect") {
      ({ url } = await (await this.#account(vendor)).reconnect());
    } else {
      const callback = this.ctx.exports.ConnectCallback({
        props: { connectionId: meta.connectionId, vendor },
      });
      ({ url } = await this.#vendor(vendor).connectAccount(callback, {}));
    }
    await this.#scheduleAlarm(Date.now() + STAGE_TTL_MS);
    return { url, nonce };
  }

  /** ConnectCallback.complete(): stage the account until the initiator redeems the ticket. */
  async stage(
    vendor: string,
    account: Stub,
    expiresAt?: Date,
  ): Promise<{ targetOrigin: string; ticket: string }> {
    const meta = await this.#meta();
    const pending = await this.ctx.storage.get<PendingConnect>("connect");
    if (!pending || pending.vendor !== vendor) {
      try {
        await account.revoke();
      } catch {}
      throw new Error("No connect flow is waiting for this account");
    }
    const ticket = `${meta.connectionId}.${token()}`;
    await this.ctx.storage.put("staged-account", account);
    await this.ctx.storage.put<Staged>("staged", {
      vendor,
      ticketHash: await sha256(ticket),
      expiresAt: Date.now() + STAGE_TTL_MS,
      mode: pending.mode,
    });
    if (expiresAt)
      await this.ctx.storage.put("credentials-expire", new Date(expiresAt).toISOString());
    return { targetOrigin: pending.appOrigin, ticket };
  }

  /** ConnectCallback.reconnectComplete(): credentials staged in the gatekeeper, keyed by stageId. */
  async stageReconnect(
    vendor: string,
    stageId: string,
  ): Promise<{ targetOrigin: string; ticket: string }> {
    const meta = await this.#meta();
    const pending = await this.ctx.storage.get<PendingConnect>("connect");
    if (pending?.mode !== "reconnect" || pending.vendor !== vendor) {
      throw new Error("No reconnect is waiting");
    }
    const ticket = `${meta.connectionId}.${token()}`;
    await this.ctx.storage.put<Staged>("staged", {
      vendor,
      ticketHash: await sha256(ticket),
      expiresAt: Date.now() + STAGE_TTL_MS,
      mode: "reconnect",
      stageId,
    });
    return { targetOrigin: pending.appOrigin, ticket };
  }

  async credentialsChanged(state: "expired" | "restored"): Promise<void> {
    await this.#mirror(
      state === "expired"
        ? { status: "expired", error: "The provider says the credentials expired. Reconnect." }
        : { status: "active", error: null },
    );
    if (state === "expired") {
      // Run-as (ADR 0170): automations bound to this connection pause and the admins are told.
      // Reconnecting does not restore the bindings: a person binds it again.
      const meta = await this.#meta();
      await revokeBindings(
        createCrmDb(this.env.DB),
        { connectionId: meta.connectionId },
        { reason: `${meta.title}'s credentials expired`, by: null },
      );
    }
  }

  /** Redeems a handoff ticket over the initiating user's session (with the popup's nonce). */
  async redeem(input: { ticket: string; nonce: string; userId: string }): Promise<ConnectRedeemed> {
    const meta = await this.#meta();
    const pending = await this.ctx.storage.get<PendingConnect>("connect");
    const staged = await this.ctx.storage.get<Staged>("staged");
    const fail = async (message: string): Promise<never> => {
      await this.#dropStaged();
      throw new Error(message);
    };
    if (!pending || !staged) return fail("No connect flow is waiting. Start again.");
    if (staged.expiresAt < Date.now()) return fail("This connect flow expired. Start again.");
    if (input.userId !== pending.userId)
      return fail("Only the user who started this flow can finish it");
    if ((await sha256(input.nonce)) !== pending.nonceHash)
      return fail("This handoff is not for this window");
    if ((await sha256(input.ticket)) !== staged.ticketHash) return fail("Unknown or used ticket");

    await this.ctx.storage.delete(["connect", "staged"]);
    let label: string | null = null;
    if (staged.mode === "reconnect") {
      await (await this.#account(staged.vendor)).commitReconnect(staged.stageId ?? "");
    } else {
      const account = await this.ctx.storage.get<Stub>("staged-account");
      await this.ctx.storage.delete("staged-account");
      const key = staged.mode === "companion" ? `companion:${staged.vendor}` : "account";
      await this.ctx.storage.put(key, account);
    }
    if (staged.mode !== "companion") {
      try {
        const d = await (await this.#account()).describe();
        label = d?.uniqueName ?? d?.displayName ?? null;
      } catch {
        label = null;
      }
    }
    // A companion gatekeeper (Slack posting) connects next, in the same popup.
    const entry = catalogueEntry(meta.vendor);
    let next: ConnectRedeemed["next"] = null;
    if (staged.mode === "connect" && entry?.companion) {
      const binding = (this.env as unknown as Record<string, unknown>)[
        vendorBinding(entry.companion)
      ];
      if (binding) {
        const start = await this.#begin(
          entry.companion,
          input.userId,
          pending.appOrigin,
          "companion",
        );
        next = { ...start, vendor: entry.companion };
      }
    }
    return { accountLabel: label, next };
  }

  async #dropStaged(): Promise<void> {
    const account = await this.ctx.storage.get<Stub>("staged-account");
    await this.ctx.storage.delete(["connect", "staged", "staged-account"]);
    if (account) {
      try {
        await account.revoke();
      } catch (error) {
        console.warn("could not revoke a staged account", error);
      }
    }
  }

  async reconnect(input: { userId: string; appOrigin?: string }): Promise<ConnectStart> {
    const meta = await this.#meta();
    if (input.userId !== meta.ownerUserId) throw new Error("Only the owner can reconnect");
    return this.#begin(meta.vendor, input.userId, input.appOrigin, "reconnect");
  }

  /** An auto-provisioned account (web search, email sending, webhooks). */
  async provision(input: {
    vendor: string;
    userId: string;
  }): Promise<{ accountLabel: string | null }> {
    const meta = await this.#meta();
    if (input.userId !== meta.ownerUserId)
      throw new Error("Only the connection's owner can provision it");
    const vendor = this.#vendor(input.vendor);
    const account = await vendor.createAccount();
    await this.ctx.storage.put("account", account);
    const d = await account.describe();
    if (d?.singleton) {
      // The singleton facet is installed like any other and exposed to every usable actor.
      const cls = await account.getSingletonGatekeeperClass();
      await this.ctx.storage.put("class:singleton", cls);
      const facet = this.#facet("singleton", cls);
      const r = await facet.describe();
      const resource: FacetRecord = {
        key: "singleton",
        url: r.url,
        pattern: "singleton",
        title: r.title,
        tsType: r.tsType,
        bindingName: r.suggestedBindingName,
        vendor: input.vendor,
      };
      await this.ctx.storage.put("facet:singleton", resource);
      await this.#mirror({ resources: JSON.stringify([this.#bound(resource)]) });
    }
    return { accountLabel: d?.displayName ?? null };
  }

  async disconnect(): Promise<void> {
    const sync = await this.ctx.storage.get<SyncState>("sync");
    if (sync) await this.ctx.storage.delete("sync");
    for (const [key, hook] of await this.ctx.storage.list<HookRecord>({ prefix: "hook:" })) {
      const controller = await this.ctx.storage.get<Stub>(`controller:${hook.id}`);
      if (hook.enabled && controller) {
        try {
          await controller.disable();
        } catch {}
      }
      await this.ctx.storage.delete([key, `controller:${hook.id}`]);
    }
    for (const key of [
      "account",
      ...[...(await this.ctx.storage.list({ prefix: "companion:" })).keys()],
    ]) {
      const account = await this.ctx.storage.get<Stub>(key);
      if (account) {
        try {
          await account.revoke();
        } catch (error) {
          console.warn("revoke failed", error);
        }
      }
    }
    for (const [key, record] of await this.ctx.storage.list<FacetRecord>({ prefix: "facet:" })) {
      try {
        this.ctx.facets.delete(`f-${record.key}`);
      } catch {}
      await this.ctx.storage.delete([key, `class:${record.key}`]);
    }
    await this.#dropStaged();
    await this.ctx.storage.delete(["account", "meta"]);
    await this.ctx.storage.deleteAlarm();
  }

  // --- Facets ---------------------------------------------------------------------------------

  #facet(key: string, cls: Stub): Stub {
    return this.ctx.facets.get(`f-${key}`, () => ({ class: cls }));
  }

  /** The running facet for a resource, recreated from its stored class after a restart. */
  async #facetFor(key: string): Promise<{ facet: Stub; record: FacetRecord }> {
    const record = await this.ctx.storage.get<FacetRecord>(`facet:${key}`);
    if (!record) throw new Error(`No resource ${key} on this connection`);
    const cls = await this.ctx.storage.get<Stub>(`class:${key}`);
    if (!cls) throw new Error(`The class of resource ${key} is missing`);
    return { facet: this.#facet(key, cls), record };
  }

  #bound(r: FacetRecord): BoundResource {
    return {
      key: r.key,
      url: r.url,
      pattern: r.pattern,
      title: r.title,
      tsType: r.tsType,
      bindingName: r.bindingName,
      ...(r.hookTsType ? { hookTsType: r.hookTsType } : {}),
    };
  }

  async bindResource(url: string): Promise<BoundResource> {
    const meta = await this.#meta();
    const key = (await sha256(url)).slice(0, 16);
    const existing = await this.ctx.storage.get<FacetRecord>(`facet:${key}`);
    if (existing) return this.#bound(existing);
    let vendor = meta.vendor;
    let minted: { class: Stub; resource: { urlPattern: string } };
    try {
      minted = await (await this.#account()).getGatekeeperClassFor(url);
    } catch (error) {
      const companion = catalogueEntry(meta.vendor)?.companion;
      const other = companion ? await this.ctx.storage.get<Stub>(`companion:${companion}`) : null;
      if (!companion || !other) throw error;
      minted = await other.getGatekeeperClassFor(url);
      vendor = companion;
    }
    await this.ctx.storage.put(`class:${key}`, minted.class);
    const facet = this.#facet(key, minted.class);
    const d = await facet.describe();
    const record: FacetRecord = {
      key,
      url: d?.url ?? url,
      pattern: minted.resource?.urlPattern ?? "",
      title: d?.title ?? url,
      tsType: d?.tsType ?? "unknown",
      bindingName: d?.suggestedBindingName ?? "RESOURCE",
      ...(d?.hookTsType ? { hookTsType: d.hookTsType } : {}),
      vendor,
    };
    await this.ctx.storage.put(`facet:${key}`, record);
    // A webhook endpoint delivers into the CRM's event log from the moment it is bound.
    if (meta.vendor === "webhook") {
      await this.#withSession(
        key,
        { kind: "system", purpose: "webhook", user: await loadUser(this.env, meta.ownerUserId) },
        (s) => s.subscribe(new WebhookSink(this.env, meta.connectionId)),
      );
    }
    return this.#bound(record);
  }

  async unbindResource(key: string): Promise<void> {
    for (const [hookKey, hook] of await this.ctx.storage.list<HookRecord>({ prefix: "hook:" })) {
      if (hook.facetKey !== key) continue;
      const controller = await this.ctx.storage.get<Stub>(`controller:${hook.id}`);
      if (hook.enabled && controller) {
        try {
          await controller.disable();
        } catch {}
      }
      await this.ctx.storage.delete([hookKey, `controller:${hook.id}`]);
    }
    try {
      this.ctx.facets.delete(`f-${key}`);
    } catch {}
    await this.ctx.storage.delete([`facet:${key}`, `class:${key}`]);
    const sync = await this.ctx.storage.get<SyncState>("sync");
    if (sync && (sync.config.mail === key || sync.config.calendar === key)) {
      await this.setSync({
        ...sync.config,
        mail: sync.config.mail === key ? null : sync.config.mail,
        calendar: sync.config.calendar === key ? null : sync.config.calendar,
      });
    }
  }

  async resources(): Promise<BoundResource[]> {
    return [...(await this.ctx.storage.list<FacetRecord>({ prefix: "facet:" })).values()].map((r) =>
      this.#bound(r),
    );
  }

  async supportedResources(): Promise<
    { urlPattern: string; title: string; description: string; grantable: boolean; vendor: string }[]
  > {
    const meta = await this.#meta();
    const out: {
      urlPattern: string;
      title: string;
      description: string;
      grantable: boolean;
      vendor: string;
    }[] = [];
    const accounts: [string, Stub][] = [[meta.vendor, await this.#account()]];
    for (const [key, stub] of await this.ctx.storage.list<Stub>({ prefix: "companion:" })) {
      accounts.push([key.slice("companion:".length), stub]);
    }
    for (const [vendor, account] of accounts) {
      const list = (await account.getSupportedResources()) as {
        urlPattern: string;
        title: string;
        description?: string;
        grantable?: boolean;
      }[];
      for (const r of list ?? []) {
        out.push({
          urlPattern: r.urlPattern,
          title: r.title,
          description: r.description ?? "",
          grantable: r.grantable !== false,
          vendor,
        });
      }
    }
    return out;
  }

  async configure(pattern: string, method: string, args: unknown[]): Promise<unknown> {
    let ui = this.#configurators.get(pattern);
    if (!ui) {
      const frame = await (await this.#account()).startResourceConfigurator(pattern);
      ui = frame.ui;
      this.#configurators.set(pattern, ui);
    }
    if (!/^[a-zA-Z][a-zA-Z0-9]{0,60}$/.test(method) || method === "constructor") {
      throw new Error("Not a configurator method");
    }
    return toJson(await ui[method](...args));
  }

  async types(key: string): Promise<string> {
    const { facet } = await this.#facetFor(key);
    return facet.getTypeScriptTypes();
  }

  // --- Sessions -------------------------------------------------------------------------------

  #queueHost(meta: Meta, record: FacetRecord): QueueHost {
    return {
      env: this.env,
      connectionId: meta.connectionId,
      connectionTitle: meta.title,
      vendor: record.vendor,
      ownerUserId: meta.ownerUserId,
      facetKey: record.key,
      resourceTitle: record.title,
      apply: (facetKey, action) => this.applyOutbound(facetKey, action),
      reject: async (facetKey, action) => {
        await this.rejectOutbound(facetKey, action);
      },
      stashController: async (controller) => {
        const id = token();
        await this.ctx.storage.put(`controller:${id}`, controller);
        return id;
      },
      enableHook: (id, facetKey, purpose, d) => this.#enableHook(id, facetKey, purpose, d),
      // Hooks agents ask for wait for a person (stage 5 binds them to automations).
      recordAgentHook: async (id, facetKey, d) => {
        await this.ctx.storage.put<HookRecord>(`hook:${id}`, {
          id,
          facetKey,
          purpose: "agent",
          ...d,
          enabled: false,
        });
      },
    };
  }

  async #withSession<T>(
    key: string,
    caller: QueueCaller,
    run: (session: Stub, queue: HostQueue) => Promise<T>,
  ): Promise<{ value: T; queue: HostQueue }> {
    const meta = await this.#meta();
    const { facet, record } = await this.#facetFor(key);
    const queue = new HostQueue(this.#queueHost(meta, record), caller);
    const session = await facet.startSession(queue);
    try {
      const value = await run(session, queue);
      await queue.settle();
      return { value, queue };
    } finally {
      try {
        session[Symbol.dispose]?.();
      } catch {}
    }
  }

  async call(input: {
    resource: string;
    method: string;
    args: unknown[];
    caller: IntegrationCaller;
  }): Promise<IntegrationCallResult> {
    const meta = await this.#meta();
    if (meta.scope === "personal" && input.caller.userId !== meta.ownerUserId) {
      throw new Error("A personal connection is used only by its owner's actors");
    }
    if (!/^[a-zA-Z][a-zA-Z0-9]{0,60}$/.test(input.method) || input.method === "constructor") {
      throw new Error("Not a session method");
    }
    const user = await loadUser(this.env, input.caller.userId);
    const { value, queue } = await this.#withSession(
      input.resource,
      { kind: "actor", caller: input.caller, user },
      async (session) => toJson(await session[input.method](...input.args)),
    );
    return { value, pending: queue.pending, applied: queue.applied };
  }

  /** A session stub for code (Code Mode, extension tools) acting as `caller`. */
  async openSession(input: { resource: string; caller: IntegrationCaller }): Promise<Stub> {
    const meta = await this.#meta();
    if (meta.scope === "personal" && input.caller.userId !== meta.ownerUserId) {
      throw new Error("A personal connection is used only by its owner's actors");
    }
    const { facet, record } = await this.#facetFor(input.resource);
    const user = await loadUser(this.env, input.caller.userId);
    return facet.startSession(
      new HostQueue(this.#queueHost(meta, record), { kind: "actor", caller: input.caller, user }),
    );
  }

  // --- Outbound -------------------------------------------------------------------------------

  async applyOutbound(facetKey: string, action: number): Promise<void> {
    const { facet } = await this.#facetFor(facetKey);
    await facet.applyAction(action, null);
  }

  async rejectOutbound(
    facetKey: string,
    action: number,
  ): Promise<{ restart?: boolean } | undefined> {
    const { facet } = await this.#facetFor(facetKey);
    const result = await facet.rejectAction(action);
    return result && typeof result === "object" ? { restart: Boolean(result.restart) } : undefined;
  }

  // --- Hooks ----------------------------------------------------------------------------------

  async #enableHook(
    id: string,
    facetKey: string,
    purpose: "sync" | "webhook",
    d: { title: string; description: string },
  ): Promise<void> {
    const meta = await this.#meta();
    const controller = await this.ctx.storage.get<Stub>(`controller:${id}`);
    if (!controller) throw new Error("The hook controller is gone");
    const initiator = this.ctx.exports.HostHookInitiator({
      props: { connectionId: meta.connectionId, hookId: id },
    });
    await controller.enable(initiator, { workspaceId: meta.connectionId });
    await this.ctx.storage.put<HookRecord>(`hook:${id}`, {
      id,
      facetKey,
      purpose,
      ...d,
      enabled: true,
    });
  }

  /** HookInitiator.startHook(): a fresh callback and queue for one firing. */
  async startHook(hookId: string): Promise<{ callback: RpcTarget; approvalQueue: HostQueue }> {
    const meta = await this.#meta();
    const hook = await this.ctx.storage.get<HookRecord>(`hook:${hookId}`);
    if (!hook?.enabled) throw new Error("This hook is no longer enabled");
    const { record } = await this.#facetFor(hook.facetKey);
    const user = await loadUser(this.env, meta.ownerUserId);
    const purpose = hook.purpose === "webhook" ? "webhook" : "sync";
    const queue = new HostQueue(this.#queueHost(meta, record), { kind: "system", purpose, user });
    const callback =
      hook.purpose === "webhook"
        ? new WebhookSink(this.env, meta.connectionId)
        : new SyncHookTarget(() => this.syncSoon());
    return { callback, approvalQueue: queue };
  }

  async hooks(): Promise<HookRecord[]> {
    return [...(await this.ctx.storage.list<HookRecord>({ prefix: "hook:" })).values()];
  }

  // --- Sync -----------------------------------------------------------------------------------

  async setSync(config: SyncConfig): Promise<void> {
    const meta = await this.#meta();
    const before = await this.ctx.storage.get<SyncState>("sync");
    const days = config.backfillDays ?? 90;
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const state: SyncState = { config };
    for (const kind of ["mail", "calendar"] as const) {
      const key = config[kind];
      if (!key) continue;
      const record = await this.ctx.storage.get<FacetRecord>(`facet:${key}`);
      if (
        !record ||
        syncKindOf(meta.vendor, record.url) !== kind ||
        !adapterFor(meta.vendor, kind)
      ) {
        throw new Error(`Resource ${key} cannot sync ${kind}`);
      }
      const prior = before?.[kind];
      state[kind] =
        prior && prior.resource === key
          ? prior
          : { resource: key, cursor: null, since, backfilled: false };
      if (!prior || prior.resource !== key) await this.#subscribeSync(kind, key);
    }
    await this.ctx.storage.put("sync", state);
    await this.#mirrorSync(state);
    await this.#scheduleAlarm(Date.now() + 10);
  }

  async #subscribeSync(kind: SyncKind, key: string): Promise<void> {
    const meta = await this.#meta();
    const adapter = adapterFor(meta.vendor, kind);
    if (!adapter?.subscribe) return;
    const user = await loadUser(this.env, meta.ownerUserId);
    try {
      await this.#withSession(
        key,
        { kind: "system", purpose: "sync", user },
        (session) =>
          adapter.subscribe?.(session, new SyncHookTarget(() => this.syncSoon())) ??
          Promise.resolve(),
      );
    } catch (error) {
      // Without push, the periodic catch-up still syncs.
      console.warn("sync: could not subscribe to changes", error);
    }
  }

  async syncSoon(): Promise<void> {
    await this.#scheduleAlarm(Date.now() + SYNC_SOON_MS, true);
  }

  async syncNow(): Promise<void> {
    await this.#syncPass();
  }

  async syncState(): Promise<SyncState | null> {
    return (await this.ctx.storage.get<SyncState>("sync")) ?? null;
  }

  async #scheduleAlarm(at: number, onlyIfEarlier = true): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || !onlyIfEarlier || at < current) await this.ctx.storage.setAlarm(at);
  }

  override async alarm(): Promise<void> {
    const staged = await this.ctx.storage.get<Staged>("staged");
    if (staged && staged.expiresAt <= Date.now()) await this.#dropStaged();
    const pending = await this.ctx.storage.get<PendingConnect>("connect");
    if (pending && pending.startedAt + STAGE_TTL_MS <= Date.now() && !staged) {
      await this.ctx.storage.delete("connect");
    }
    if (await this.ctx.storage.get<SyncState>("sync")) await this.#syncPass();
  }

  /** One sync pass: one chunk per configured kind, then the next alarm. */
  async #syncPass(): Promise<void> {
    const state = await this.ctx.storage.get<SyncState>("sync");
    if (!state) return;
    const meta = await this.#meta();
    const row = await this.env.DB.prepare(
      "SELECT sharing_level, status FROM core_integration_connection WHERE id = ?",
    )
      .bind(meta.connectionId)
      .first<{ sharing_level: string; status: string }>();
    if (!row || row.status === "disconnected") return;
    let more = false;
    for (const kind of ["mail", "calendar"] as const) {
      const kindState = state[kind];
      if (!kindState) continue;
      try {
        more = (await this.#pullKind(meta, kind, kindState, row.sharing_level)) || more;
        kindState.lastError = null;
      } catch (error) {
        kindState.lastError = error instanceof Error ? error.message : String(error);
      }
      kindState.lastRunAt = new Date().toISOString();
    }
    await this.ctx.storage.put("sync", state);
    await this.#mirrorSync(state);
    await this.ctx.storage.setAlarm(Date.now() + (more ? BACKFILL_STEP_MS : CATCH_UP_MS));
  }

  async #pullKind(meta: Meta, kind: SyncKind, state: KindState, sharing: string): Promise<boolean> {
    const adapter = adapterFor(meta.vendor, kind);
    if (!adapter) return false;
    const user = await loadUser(this.env, meta.ownerUserId);
    const { value: result } = await this.#withSession(
      state.resource,
      { kind: "system", purpose: "sync", user },
      (session, queue) =>
        adapter.pull(session, state.cursor, {
          since: state.since,
          now: new Date().toISOString(),
          tracker: queue.tracker,
          limit: SYNC_PAGE,
        }),
    );
    state.restricted = (state.restricted ?? 0) + result.restricted;
    // "Don't sync": read nothing into the CRM, but keep the cursor moving.
    if (sharing !== "none") {
      const db = createCrmDb(this.env.DB);
      for (let i = 0; i < result.items.length; i += SYNC_BATCH_MAX) {
        const out = (await invokeByName(
          "sync.ingest",
          { connectionId: meta.connectionId, items: result.items.slice(i, i + SYNC_BATCH_MAX) },
          {
            actor: "automation",
            user,
            origin: { surface: "automation", automationId: `sync:${meta.connectionId}` },
            db,
          },
        )) as {
          created: number;
          bodies: { externalKey: string; key: string }[];
          removedBodies: string[];
        };
        state.created = (state.created ?? 0) + out.created;
        for (const body of out.bodies) {
          const text = result.bodies.get(body.externalKey);
          if (text && this.env.BLOBS) await this.env.BLOBS.put(body.key, text);
        }
        if (out.removedBodies.length && this.env.BLOBS)
          await this.env.BLOBS.delete(out.removedBodies);
      }
    }
    state.cursor = result.cursor;
    if (!result.more) state.backfilled = true;
    // Caught up: reconcile one window for deletes (providers without a delete feed).
    if (!result.more && sharing !== "none") await this.#reconcile(meta, kind, state, user);
    return result.more;
  }

  /**
   * Delete propagation for window-based adapters (Gmail, Google Calendar, Outlook; ADR 0112): one
   * 7-day window per catch-up pass, walking the backfill range and starting again. What the CRM
   * synced in the window and the provider no longer lists (deleted, trashed) is sent to
   * sync.ingest as a delete. Nothing is deleted when the listing was cut short.
   */
  async #reconcile(meta: Meta, kind: SyncKind, state: KindState, user: ActingUser): Promise<void> {
    const adapter = adapterFor(meta.vendor, kind);
    if (!adapter?.listIds) return;
    const now = Date.now();
    const start = Math.max(Date.parse(state.reconcileFrom ?? state.since), Date.parse(state.since));
    const end = Math.min(start + RECONCILE_WINDOW_MS, now);
    if (end <= start) {
      state.reconcileFrom = state.since;
      return;
    }
    const from = new Date(start);
    const to = new Date(end);
    const { value: listed } = await this.#withSession(
      state.resource,
      { kind: "system", purpose: "sync", user },
      (session) =>
        adapter.listIds?.(session, from, to) ?? Promise.resolve({ ids: [], complete: false }),
    );
    state.reconcileFrom = end >= now ? state.since : to.toISOString();
    if (!listed.complete) return;
    const present = new Set(listed.ids);
    const db = createCrmDb(this.env.DB);
    const synced = await syncedInWindow(db.query, {
      connectionId: meta.connectionId,
      kind: kind === "mail" ? "email" : "meeting",
      from: from.toISOString(),
      to: to.toISOString(),
    });
    const gone = synced.filter((id) => !present.has(id));
    for (let i = 0; i < gone.length; i += SYNC_BATCH_MAX) {
      const out = (await invokeByName(
        "sync.ingest",
        {
          connectionId: meta.connectionId,
          items: gone.slice(i, i + SYNC_BATCH_MAX).map((providerId) => ({
            kind: kind === "mail" ? "email" : "meeting",
            op: "delete",
            providerId,
          })),
        },
        {
          actor: "automation",
          user,
          origin: { surface: "automation", automationId: `sync:${meta.connectionId}` },
          db,
        },
      )) as { deleted: number; removedBodies: string[] };
      state.deleted = (state.deleted ?? 0) + out.deleted;
      if (out.removedBodies.length && this.env.BLOBS)
        await this.env.BLOBS.delete(out.removedBodies);
    }
  }

  async #mirrorSync(state: SyncState): Promise<void> {
    const view = {
      mail: state.config.mail,
      calendar: state.config.calendar,
      backfillDays: state.config.backfillDays ?? 90,
      status: {
        mail: state.mail ? this.#kindView(state.mail) : null,
        calendar: state.calendar ? this.#kindView(state.calendar) : null,
      },
    };
    const last = [state.mail?.lastRunAt, state.calendar?.lastRunAt].filter(Boolean).sort().at(-1);
    await this.#mirror({ sync: JSON.stringify(view), ...(last ? { last_sync_at: last } : {}) });
  }

  #kindView(s: KindState) {
    return {
      backfilled: s.backfilled,
      since: s.since,
      lastRunAt: s.lastRunAt ?? null,
      lastError: s.lastError ?? null,
      created: s.created ?? 0,
      deleted: s.deleted ?? 0,
      restrictedSkipped: s.restricted ?? 0,
    };
  }
}
