// A fake gatekeeper with a fake OAuth provider, a mailbox, a calendar and an outbox (stage 6a).
// It implements the real gatekeeper interface (vendor, account, facets, hooks, actions) so the
// integration host, the connect flow, sync and outbound approvals can be exercised end to end in
// tests and local development without real accounts. It is offered only when
// INTEGRATIONS_FAKE_PROVIDER is "true" (never in a production deployment), and crm-runner binds
// it to itself as GATEKEEPER_FAKE.
//
// Not a template for production gatekeepers: no PKCE, no credentials, a trivially simple journal.
// See packages/gatekeeper-email-send and packages/gatekeeper-slack-post for real ones.
import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { connectHandoffPageHtml, htmlResponse } from "./pages.ts";

// --- Shapes ------------------------------------------------------------------------------------

export interface FakeAddress {
  email: string;
  name?: string;
}

/** A message in a fake mailbox, as a test or the dev UI seeds it. */
export interface FakeMessage {
  id: string;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  from: FakeAddress;
  to: FakeAddress[];
  cc?: FakeAddress[];
  subject: string;
  text: string;
  sentAt: string;
  headers?: Record<string, string>;
  /** The provider flags this read as restricted (ObservationDescription.containsRestrictedData). */
  restricted?: boolean;
}

export interface FakeEvent {
  id: string;
  uid: string;
  title: string;
  description?: string;
  startsAt: string;
  endsAt?: string;
  location?: string;
  organizer?: FakeAddress;
  attendees: FakeAddress[];
  cancelled?: boolean;
  restricted?: boolean;
}

export interface FakeChange {
  seq: number;
  kind: "mail" | "calendar";
  id: string;
  op: "upsert" | "delete";
}

interface Description {
  title: string;
  description: string;
  fields?: { label: string; value: string; syntax?: string }[];
  descriptionIsComplete?: boolean;
  implementsRevert: boolean;
  autoApprovable?: boolean;
  actionKind?: { tag: string; label: string };
}

interface QueueStub {
  authorizeObservation(d: {
    title: string;
    description: string;
    containsRestrictedData?: boolean;
    subresources?: string[];
  }): Promise<void>;
  submitAction(action: number, d: Description): Promise<void>;
  bindHook(
    controller: unknown,
    callback: unknown,
    d: { title: string; description: string },
  ): Promise<void>;
  dup(): QueueStub;
  [Symbol.dispose](): void;
}

interface HookInitiatorStub {
  startHook(): Promise<{ callback: { changed(): Promise<void> }; approvalQueue: QueueStub }>;
}

const RESOURCES = [
  {
    urlPattern: "fake://mailbox/:address",
    title: "Mailbox",
    description: "Mail in the fake mailbox",
    grantable: true,
  },
  {
    urlPattern: "fake://calendar/:address",
    title: "Calendar",
    description: "Events in the fake calendar",
    grantable: true,
  },
  {
    urlPattern: "fake://outbox/:address",
    title: "Outbox",
    description: "Send mail from the fake mailbox (outbound actions)",
    grantable: true,
  },
];

const TYPES = `/** A fake mailbox (development and tests). */
export interface FakeMailSession {
  listChanges(cursor: string | null, limit?: number): Promise<{ items: { id: string; op: "upsert" | "delete" }[]; next: string | null }>;
  getMessage(id: string): Promise<FakeMessage>;
  searchMessages(query: string): Promise<FakeMessage[]>;
}
export interface FakeCalendarSession {
  listChanges(cursor: string | null, limit?: number): Promise<{ items: { id: string; op: "upsert" | "delete" }[]; next: string | null }>;
  getEvent(id: string): Promise<FakeEvent>;
}
/** Sending is an outbound action: it waits for approval. */
export interface FakeOutboxSession {
  send(message: { to: string[]; subject: string; text: string; internal?: boolean; relatedRecords?: string[] }): Promise<{ id: number; status: "pending" | "sent" }>;
  listSent(): Promise<{ id: number; to: string[]; subject: string; status: "pending" | "sent" | "rejected" }[]>;
}
export type FakeMessage = { id: string; messageId: string; from: { email: string; name?: string }; to: { email: string; name?: string }[]; subject: string; text: string; sentAt: string };
export type FakeEvent = { id: string; uid: string; title: string; startsAt: string; endsAt?: string; attendees: { email: string; name?: string }[] };
`;

function parseResource(url: string): { kind: "mailbox" | "calendar" | "outbox"; address: string } {
  const match = /^fake:\/\/(mailbox|calendar|outbox)\/([^/?#]+)$/.exec(url);
  if (!match?.[1] || !match[2]) throw new Error(`Not a fake resource URL: ${url}`);
  const address = decodeURIComponent(match[2]).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(address)) throw new Error("Not an address");
  return { kind: match[1] as "mailbox" | "calendar" | "outbox", address };
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// --- The provider's data: one DO per mailbox address -------------------------------------------

export class FakeProvider extends DurableObject<Env> {
  #seq(): number {
    const next = (this.ctx.storage.kv.get<number>("seq") ?? 0) + 1;
    this.ctx.storage.kv.put("seq", next);
    return next;
  }

  #change(kind: "mail" | "calendar", id: string, op: "upsert" | "delete") {
    const seq = this.#seq();
    this.ctx.storage.kv.put(`change:${String(seq).padStart(10, "0")}`, { seq, kind, id, op });
  }

  async putMessage(message: FakeMessage): Promise<void> {
    this.ctx.storage.kv.put(`msg:${message.id}`, message);
    this.#change("mail", message.id, "upsert");
    await this.#notify();
  }

  async deleteMessage(id: string): Promise<void> {
    this.ctx.storage.kv.delete(`msg:${id}`);
    this.#change("mail", id, "delete");
    await this.#notify();
  }

  async putEvent(event: FakeEvent): Promise<void> {
    this.ctx.storage.kv.put(`evt:${event.id}`, event);
    this.#change("calendar", event.id, "upsert");
    await this.#notify();
  }

  async deleteEvent(id: string): Promise<void> {
    this.ctx.storage.kv.delete(`evt:${id}`);
    this.#change("calendar", id, "delete");
    await this.#notify();
  }

  async listChanges(
    kind: "mail" | "calendar",
    cursor: string | null,
    limit: number,
  ): Promise<{ items: { id: string; op: "upsert" | "delete" }[]; next: string | null }> {
    const after = cursor ? Number(cursor) : 0;
    const items: { id: string; op: "upsert" | "delete" }[] = [];
    let last = after;
    for (const [, change] of this.ctx.storage.kv.list<FakeChange>({
      start: `change:${String(after + 1).padStart(10, "0")}`,
      prefix: "change:",
    })) {
      last = change.seq;
      if (change.kind === kind) items.push({ id: change.id, op: change.op });
      if (items.length >= limit) break;
    }
    return { items, next: last > after ? String(last) : cursor };
  }

  async getMessage(id: string): Promise<FakeMessage | null> {
    return this.ctx.storage.kv.get<FakeMessage>(`msg:${id}`) ?? null;
  }

  async getEvent(id: string): Promise<FakeEvent | null> {
    return this.ctx.storage.kv.get<FakeEvent>(`evt:${id}`) ?? null;
  }

  async messages(): Promise<FakeMessage[]> {
    return [...this.ctx.storage.kv.list<FakeMessage>({ prefix: "msg:" })].map(([, m]) => m);
  }

  async recordSent(entry: { action: number; to: string[]; subject: string; text: string }) {
    const sent = this.ctx.storage.kv.get<(typeof entry)[]>("sent") ?? [];
    sent.push(entry);
    this.ctx.storage.kv.put("sent", sent);
  }

  async sent(): Promise<{ action: number; to: string[]; subject: string; text: string }[]> {
    return this.ctx.storage.kv.get("sent") ?? [];
  }

  async addInitiator(id: string, initiator: HookInitiatorStub): Promise<void> {
    await this.ctx.storage.put(`hook:${id}`, initiator);
  }

  async removeInitiator(id: string): Promise<void> {
    await this.ctx.storage.delete(`hook:${id}`);
  }

  async hookCount(): Promise<number> {
    return (await this.ctx.storage.list({ prefix: "hook:" })).size;
  }

  /** Fires every enabled hook: the host then pulls changes (as a Pub/Sub push would). */
  async #notify(): Promise<void> {
    const hooks = await this.ctx.storage.list<HookInitiatorStub>({ prefix: "hook:" });
    for (const initiator of hooks.values()) {
      try {
        const { callback, approvalQueue } = await initiator.startHook();
        await approvalQueue.authorizeObservation({
          title: "New mail",
          description: "The mailbox changed",
          subresources: [],
        });
        await callback.changed();
      } catch (error) {
        console.warn("fake provider: a hook failed", error);
      }
    }
  }
}

function provider(env: Env, address: string): DurableObjectStub<FakeProvider> {
  return env.FAKE_PROVIDER.getByName(address.toLowerCase());
}

// --- Accounts: the OAuth flow ------------------------------------------------------------------

interface ConnectCallbackStub {
  complete(user: unknown, expiresAt?: Date): Promise<{ targetOrigin: string; ticket: string }>;
  reconnectComplete(stageId: string): Promise<{ targetOrigin: string; ticket: string }>;
}

interface AccountState {
  address: string | null;
  nonce: string | null;
  mode: "connect" | "reconnect";
  connected: boolean;
  revoked: boolean;
  staged: { stageId: string; address: string } | null;
}

/** One connected (or connecting) fake account. Serves the fake provider's consent page. */
export class FakeAccount extends DurableObject<Env> {
  #state(): AccountState {
    return (
      this.ctx.storage.kv.get<AccountState>("state") ?? {
        address: null,
        nonce: null,
        mode: "connect",
        connected: false,
        revoked: false,
        staged: null,
      }
    );
  }

  #save(state: AccountState) {
    this.ctx.storage.kv.put("state", state);
  }

  async begin(
    callback: ConnectCallbackStub | null,
    mode: "connect" | "reconnect",
  ): Promise<string> {
    if (mode === "connect" && callback) await this.ctx.storage.put("callback", callback);
    const nonce = randomToken();
    this.#save({ ...this.#state(), nonce, mode });
    return nonce;
  }

  async describe(): Promise<{ address: string | null; connected: boolean; revoked: boolean }> {
    const s = this.#state();
    return { address: s.address, connected: s.connected, revoked: s.revoked };
  }

  async revoke(): Promise<void> {
    this.#save({ ...this.#state(), revoked: true, connected: false, nonce: null });
  }

  async commitReconnect(stageId: string): Promise<void> {
    const s = this.#state();
    if (!s.staged || s.staged.stageId !== stageId)
      throw new Error("That stage is no longer available");
    this.#save({ ...s, address: s.staged.address, staged: null, connected: true, revoked: false });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const nonce = url.pathname.split("/").at(-1) ?? "";
    const s = this.#state();
    if (!s.nonce || nonce !== s.nonce) {
      return htmlResponse("<h1>This link has expired</h1><p>Start the connection again.</p>", 410);
    }
    if (request.method === "GET") {
      const suggested = s.address ?? url.searchParams.get("address") ?? "you@fake.test";
      return htmlResponse(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Fake provider</title>
<style>body{font-family:system-ui;max-width:28rem;margin:3rem auto;padding:0 1rem}input,button{font:inherit;padding:.5rem;width:100%;box-sizing:border-box;margin:.25rem 0}</style></head>
<body><h1>Fake provider</h1><p>The CRM wants access to your fake mailbox and calendar.</p>
<form method="post"><label for="address">Mailbox address</label>
<input id="address" name="address" type="email" required value="${suggested.replace(/"/g, "&quot;")}">
<button type="submit">Allow</button></form></body></html>`);
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const form = await request.formData();
    const address = String(form.get("address") ?? "")
      .trim()
      .toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(address)) return htmlResponse("<h1>Not an address</h1>", 400);
    // The nonce is single use.
    this.#save({ ...s, nonce: null });
    const callback = await this.ctx.storage.get<ConnectCallbackStub>("callback");
    if (!callback) return htmlResponse("<h1>This link has expired</h1>", 410);
    const accountId = this.ctx.id.toString();
    let handoff: { targetOrigin: string; ticket: string };
    if (s.mode === "reconnect") {
      const stageId = randomToken();
      this.#save({ ...this.#state(), staged: { stageId, address } });
      handoff = await callback.reconnectComplete(stageId);
    } else {
      this.#save({ ...this.#state(), address, connected: true, revoked: false });
      handoff = await callback.complete(fakeUser(this.ctx, accountId));
    }
    return htmlResponse(connectHandoffPageHtml(handoff));
  }
}

type ExportsCtx = { exports: Cloudflare.Exports };

function fakeUser(ctx: ExportsCtx, accountId: string): unknown {
  return ctx.exports.FakeUser({ props: { accountId } });
}

function account(env: Env, accountId: string): DurableObjectStub<FakeAccount> {
  return env.FAKE_ACCOUNT.get(env.FAKE_ACCOUNT.idFromString(accountId));
}

/** The connect page's public path; crm-app proxies /gatekeeper/fake/* to crm-runner. */
function connectPath(accountId: string, nonce: string): string {
  return `/gatekeeper/fake/connect/${accountId}/${nonce}`;
}

/** Routes the fake provider's public pages (from crm-runner's fetch). */
export async function fakeProviderFetch(env: Env, request: Request): Promise<Response> {
  const match = /^\/gatekeeper\/fake\/connect\/([0-9a-f]{64})\/[A-Za-z0-9_-]+$/.exec(
    new URL(request.url).pathname,
  );
  if (!match?.[1]) return new Response("Not found", { status: 404 });
  return account(env, match[1]).fetch(request);
}

// --- Gatekeeper interface ----------------------------------------------------------------------

export class FakeGatekeeperVendor extends WorkerEntrypoint<Env> {
  async describe() {
    return {
      displayName: "Fake provider",
      url: "https://example.invalid/fake",
      tagline: "A fake mailbox and calendar for development and tests",
      autoProvisionsAccount: false,
      providesAuth: false,
    };
  }

  async connectAccount(callback: ConnectCallbackStub): Promise<{ url: string }> {
    const id = this.env.FAKE_ACCOUNT.newUniqueId();
    const nonce = await this.env.FAKE_ACCOUNT.get(id).begin(callback, "connect");
    return { url: connectPath(id.toString(), nonce) };
  }

  async getSupportedResources() {
    return RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES;
  }
}

export class FakeUser extends WorkerEntrypoint<Env, { accountId: string }> {
  #account() {
    return account(this.env, this.ctx.props.accountId);
  }

  async describe() {
    const d = await this.#account().describe();
    return {
      displayName: d.address ?? "Fake account",
      uniqueName: d.address ?? undefined,
      avatar: { url: "" },
    };
  }

  async getSupportedResources() {
    return RESOURCES;
  }

  async getGatekeeperClassFor(url: string) {
    const d = await this.#account().describe();
    if (!d.connected || d.revoked) throw new Error("This fake account is not connected");
    const { kind, address } = parseResource(url);
    if (address !== d.address) throw new Error(`This account can only reach ${d.address}`);
    const resource = RESOURCES.find((r) => r.urlPattern.startsWith(`fake://${kind}/`));
    return {
      class: this.ctx.exports.FakeGatekeeper({
        props: { accountId: this.ctx.props.accountId, kind, address },
      }),
      resource,
    };
  }

  async startResourceConfigurator(_pattern: string) {
    const d = await this.#account().describe();
    return {
      iframeHtml: "<!doctype html><title>Fake</title>",
      ui: new RpcStub(new FakeConfiguratorUi(d.address ?? "")),
    };
  }

  async revoke(): Promise<void> {
    await this.#account().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const nonce = await this.#account().begin(null, "reconnect");
    return { url: connectPath(this.ctx.props.accountId, nonce) };
  }

  async commitReconnect(stageId: string): Promise<void> {
    await this.#account().commitReconnect(stageId);
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async getVerifier() {
    return this.ctx.exports.FakeVerifier({ props: { accountId: this.ctx.props.accountId } });
  }

  async ensureResources(_patterns: string[]): Promise<{ url?: string }> {
    return {};
  }
}

export class FakeVerifier extends WorkerEntrypoint<Env, { accountId: string }> {}

/** The `ui` capability resource pickers call (Settings → Integrations). */
export class FakeConfiguratorUi extends RpcTarget {
  readonly #address: string;
  constructor(address: string) {
    super();
    this.#address = address;
  }
  address(): string {
    return this.#address;
  }
}

export class FakeHookController extends WorkerEntrypoint<Env, { address: string; hookId: string }> {
  async enable(initiator: HookInitiatorStub, _target: unknown): Promise<void> {
    await provider(this.env, this.ctx.props.address).addInitiator(this.ctx.props.hookId, initiator);
  }
  async disable(): Promise<void> {
    await provider(this.env, this.ctx.props.address).removeInitiator(this.ctx.props.hookId);
  }
}

interface Journal {
  next: number;
  actions: Record<
    number,
    {
      status: "pending" | "sent" | "rejected";
      to: string[];
      subject: string;
      text: string;
    }
  >;
}

class FakeSession extends RpcTarget {
  readonly #gk: FakeGatekeeper;
  readonly #queue: QueueStub;
  constructor(gk: FakeGatekeeper, queue: QueueStub) {
    super();
    this.#gk = gk;
    this.#queue = queue;
  }
  listChanges(cursor: string | null, limit = 50) {
    return this.#gk.listChanges(this.#queue, cursor, limit);
  }
  getMessage(id: string) {
    return this.#gk.readMessage(this.#queue, id);
  }
  searchMessages(query: string) {
    return this.#gk.searchMessages(this.#queue, query);
  }
  getEvent(id: string) {
    return this.#gk.readEvent(this.#queue, id);
  }
  subscribeChanges(hook: unknown) {
    return this.#gk.subscribe(this.#queue, hook);
  }
  send(message: {
    to: string[];
    subject: string;
    text: string;
    internal?: boolean;
    relatedRecords?: string[];
  }) {
    return this.#gk.send(this.#queue, message);
  }
  listSent() {
    return this.#gk.listSent(this.#queue);
  }
  [Symbol.dispose]() {
    this.#queue[Symbol.dispose]();
  }
}

/** The facet: one per (connection, resource), owned by the integration host. */
export class FakeGatekeeper extends DurableObject<
  Env,
  { accountId: string; kind: "mailbox" | "calendar" | "outbox"; address: string }
> {
  get #props() {
    return this.ctx.props;
  }

  async describe() {
    const { kind, address } = this.#props;
    const names = { mailbox: "MAILBOX", calendar: "CALENDAR", outbox: "OUTBOX" } as const;
    const types = {
      mailbox: "FakeMailSession",
      calendar: "FakeCalendarSession",
      outbox: "FakeOutboxSession",
    } as const;
    return {
      url: `fake://${kind}/${address}`,
      title: `${kind[0]?.toUpperCase()}${kind.slice(1)} ${address}`,
      snippet: `The fake ${kind} of ${address}`,
      suggestedBindingName: names[kind],
      tsType: types[kind],
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES;
  }

  async getAutoApprovableActions() {
    return this.#props.kind === "outbox"
      ? [{ tag: "fake.internal", label: "Send internal mail" }]
      : [];
  }

  async startSession(queue: QueueStub): Promise<FakeSession> {
    return new FakeSession(this, queue.dup());
  }

  #provider() {
    return provider(this.env, this.#props.address);
  }

  #require(kind: "mailbox" | "calendar" | "outbox") {
    if (this.#props.kind !== kind) throw new Error(`This session is a ${this.#props.kind}`);
  }

  async listChanges(queue: QueueStub, cursor: string | null, limit: number) {
    if (this.#props.kind === "outbox") throw new Error("An outbox has no changes");
    await queue.authorizeObservation({
      title: "List changes",
      description: `Changes in ${this.#props.address}`,
      subresources: [],
    });
    return this.#provider().listChanges(
      this.#props.kind === "mailbox" ? "mail" : "calendar",
      cursor,
      Math.min(Math.max(1, limit), 200),
    );
  }

  async readMessage(queue: QueueStub, id: string): Promise<FakeMessage> {
    this.#require("mailbox");
    const message = await this.#provider().getMessage(String(id));
    if (!message) throw new Error(`No message ${id}`);
    await queue.authorizeObservation({
      title: `Read "${message.subject}"`,
      description: `From ${message.from.email}`,
      subresources: [],
      ...(message.restricted ? { containsRestrictedData: true } : {}),
    });
    return message;
  }

  async searchMessages(queue: QueueStub, query: string): Promise<FakeMessage[]> {
    this.#require("mailbox");
    const q = String(query).toLowerCase();
    const all = await this.#provider().messages();
    const hits = all.filter(
      (m) =>
        !m.restricted &&
        (m.subject.toLowerCase().includes(q) ||
          m.from.email.includes(q) ||
          m.text.toLowerCase().includes(q)),
    );
    await queue.authorizeObservation({
      title: `Search "${query}"`,
      description: `${hits.length} messages`,
      subresources: [],
    });
    return hits.slice(0, 20);
  }

  async readEvent(queue: QueueStub, id: string): Promise<FakeEvent> {
    this.#require("calendar");
    const event = await this.#provider().getEvent(String(id));
    if (!event) throw new Error(`No event ${id}`);
    await queue.authorizeObservation({
      title: `Read event "${event.title}"`,
      description: event.startsAt,
      subresources: [],
      ...(event.restricted ? { containsRestrictedData: true } : {}),
    });
    return event;
  }

  async subscribe(queue: QueueStub, hook: unknown): Promise<void> {
    if (this.#props.kind === "outbox") throw new Error("An outbox has no hooks");
    const hookId = randomToken();
    const controller = this.ctx.exports.FakeHookController({
      props: { address: this.#props.address, hookId },
    });
    await queue.bindHook(controller, hook, {
      title: `Watch ${this.#props.address}`,
      description: "Called when the mailbox or calendar changes",
    });
  }

  #journal(): Journal {
    return this.ctx.storage.kv.get<Journal>("journal") ?? { next: 1, actions: {} };
  }

  async send(
    queue: QueueStub,
    message: {
      to: string[];
      subject: string;
      text: string;
      internal?: boolean;
      relatedRecords?: string[];
    },
  ): Promise<{ id: number; status: "pending" | "sent" }> {
    this.#require("outbox");
    const to = Array.isArray(message?.to) ? message.to.map(String).slice(0, 50) : [];
    const subject = String(message?.subject ?? "").slice(0, 500);
    const text = String(message?.text ?? "").slice(0, 20_000);
    if (!to.length || !subject) throw new Error("send needs `to` and a `subject`");
    const journal = this.#journal();
    const id = journal.next;
    journal.next += 1;
    journal.actions[id] = { status: "pending", to, subject, text };
    this.ctx.storage.kv.put("journal", journal);
    const related = Array.isArray(message.relatedRecords) ? message.relatedRecords.map(String) : [];
    await queue.submitAction(id, {
      title: `Send email: ${subject}`,
      description: `To ${to.join(", ")}\n\n${text}`,
      fields: [
        { label: "From", value: this.#props.address },
        { label: "To", value: to.join(", ") },
        { label: "Subject", value: subject },
        { label: "Body", value: text, syntax: "markdown" },
        ...(related.length ? [{ label: "Related records", value: related.join(", ") }] : []),
      ],
      descriptionIsComplete: true,
      implementsRevert: false,
      autoApprovable: message.internal === true,
      actionKind: message.internal
        ? { tag: "fake.internal", label: "Send internal mail" }
        : { tag: "fake.send", label: "Send mail" },
    });
    return { id, status: this.#journal().actions[id]?.status === "sent" ? "sent" : "pending" };
  }

  async listSent(queue: QueueStub) {
    this.#require("outbox");
    await queue.authorizeObservation({
      title: "List sent mail",
      description: "",
      subresources: [],
    });
    // Pending sends are simulated: they show as if sent, marked pending.
    return Object.entries(this.#journal().actions).map(([id, a]) => ({
      id: Number(id),
      to: a.to,
      subject: a.subject,
      status: a.status,
    }));
  }

  async applyAction(action: number): Promise<void> {
    const journal = this.#journal();
    const entry = journal.actions[action];
    if (!entry) throw new Error(`No action ${action}`);
    if (entry.status === "sent") return;
    if (entry.status === "rejected") throw new Error(`Action ${action} was rejected`);
    // In order: an earlier action still pending refuses this one.
    const earlier = Object.entries(journal.actions).find(
      ([id, a]) => Number(id) < action && a.status === "pending",
    );
    if (earlier) throw new Error(`Action ${earlier[0]} must be decided first`);
    await this.#provider().recordSent({
      action,
      to: entry.to,
      subject: entry.subject,
      text: entry.text,
    });
    entry.status = "sent";
    this.ctx.storage.kv.put("journal", journal);
  }

  async rejectAction(action: number): Promise<void> {
    const journal = this.#journal();
    const entry = journal.actions[action];
    if (entry && entry.status === "pending") {
      entry.status = "rejected";
      this.ctx.storage.kv.put("journal", journal);
    }
  }

  async revertAction(_action: number): Promise<never> {
    throw new Error("The fake outbox cannot revert");
  }

  async addObserver(): Promise<void> {}
  async removeObserver(): Promise<void> {}
}

/** Test and development seeding: the provider's data, by address. */
export function fakeProviderStub(env: Env, address: string): DurableObjectStub<FakeProvider> {
  return provider(env, address);
}
