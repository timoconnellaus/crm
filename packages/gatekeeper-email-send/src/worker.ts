// ros-gatekeeper-email-send: an auto-provisioned gatekeeper that sends email through Cloudflare
// Email Service. Each sender address is a resource; its facet turns every `send()` into an
// approval-queue action and only hands the email to Email Service once the action is applied.
// README.md explains the design.
//
// No capnweb-validate decorators (the CRM app's dev server cannot transform them): every RPC input
// is validated explicitly, see validate.ts and sender.ts.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  AccountDescription,
  ActionKind,
  AgentCatalog,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUser,
  GatekeeperUserVerifier,
  ObservationDescription,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@relationship-os/gatekeeper-interface/gatekeeper";
import { workerVersionTag } from "@relationship-os/gatekeeper-interface/gatekeeper";
import { buildDescription, sanitizeTitle } from "@relationship-os/gatekeeper-kit/action-description";
import {
  ActionApplyError,
  ActionJournal,
  ActionOutcomeUnknownError,
  defineActions,
  type TaggedAction,
} from "@relationship-os/gatekeeper-kit/actions";
import { domainOf, parseDomainList } from "./address";
import type { SenderConfiguratorRpc } from "./configurator/sender-configurator-types";
import { assertSenderAllowed, SENDER_URL_PATTERN, senderFromUrl, senderUrl } from "./sender";
import {
  type EmailTransport,
  isRefusedBeforeSending,
  isRetryableRefusal,
  sendEmail,
} from "./transport";
import type {
  EmailSendMessage,
  EmailSendReceipt,
  EmailSendRecord,
  EmailSendSession,
} from "./types";
import TYPES_CODE from "./types.txt";
import { parseMessage, recipientsOf } from "./validate";

const MAIL_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
        "<path d='M224 48H32a8 8 0 0 0-8 8v136a16 16 0 0 0 16 16h176a16 16 0 0 0 16-16V56a8 8 0 0 0-8-8Zm-20.57 16L128 133.15 52.57 64ZM216 192H40V74.19l82.59 75.71a8 8 0 0 0 10.82 0L216 74.19V192Z'/></svg>",
    ),
};

const SENDER_RESOURCE: SupportedResource = {
  urlPattern: SENDER_URL_PATTERN,
  title: "Sender address",
  description:
    "Send email from one address through Cloudflare Email Service. Every email waits for " +
    "approval, except email to colleagues when your workspace auto-approves it.",
  icon: MAIL_ICON,
  grantable: true,
};

/** Action kinds, by tag. `email.internal` is the only auto-approvable one. */
const SEND_KIND: ActionKind = { tag: "email.send", label: "Send email" };
const INTERNAL_KIND: ActionKind = { tag: "email.internal", label: "Send email to colleagues" };

/** How many sent and rejected emails the facet remembers for `listSent()`. */
const HISTORY_LIMIT = 200;
/** How many rows `listSent()` returns. */
const LIST_LIMIT = 100;
const HISTORY_PREFIX = "history:";

// ── Actions ─────────────────────────────────────────────────────────

/** What the journal stores for one send: the sender at submit time and the validated message. */
type StoredEmail = { from: string; message: EmailSendMessage };

type Actions = { send: StoredEmail; sendInternal: StoredEmail };

/** A settled send, as `listSent()` reports it. */
type HistoryEntry = {
  id: number;
  to: string[];
  subject: string;
  status: "sent" | "rejected";
  sentAt?: string;
  messageId?: string;
};

/**
 * What the action handlers may do. Deliberately not the Durable Object: provider calls live behind
 * the approval path only.
 */
type EmailHost = {
  deliver(id: number, email: StoredEmail): Promise<void>;
  recordRejected(id: number, email: StoredEmail): void;
};

/** The approver's view of one send: who it goes to, from where, and exactly what it says. */
function describeSend(email: StoredEmail, internal: boolean) {
  const { message } = email;
  const count = recipientsOf(message).length;
  const builder = buildDescription(
    `Sends an email from the sender address to ${count} ${count === 1 ? "recipient" : "recipients"}` +
      (internal ? ", all of them colleagues." : "."),
  )
    .inline("From", email.from)
    .list("To", message.to);
  if (message.cc) builder.list("Cc", message.cc);
  if (message.bcc) builder.list("Bcc", message.bcc);
  if (message.replyTo) builder.inline("Reply-To", message.replyTo);
  builder.inline("Subject", message.subject);
  if (message.text !== undefined) builder.verbatim("Body", message.text);
  if (message.html !== undefined) builder.verbatim("HTML body", message.html, "html");
  if (message.relatedRecords) builder.list("Related records", message.relatedRecords);
  return {
    title: sanitizeTitle(`Send email: ${message.subject}`),
    ...builder.finish(),
    implementsRevert: false,
  };
}

const sendDefinition = (internal: boolean) => ({
  kind: internal ? INTERNAL_KIND : SEND_KIND,
  autoApprovable: internal,
  delivery: "continue-with-simulation" as const,
  // A crash between handing the email to Email Service and recording it must not send it twice.
  claimBeforeApply: true,
  describe: (email: StoredEmail) => describeSend(email, internal),
  apply: async (email: StoredEmail, host: EmailHost, ctx: { id: number }) => {
    await host.deliver(ctx.id, email);
  },
  reject: async (email: StoredEmail, host: EmailHost, ctx: { id: number }) => {
    host.recordRejected(ctx.id, email);
  },
});

const actions = defineActions<EmailHost, Actions>(
  { send: sendDefinition(false), sendInternal: sendDefinition(true) },
  // Email Service has no per-user authority to pin: the Worker's own binding sends every email,
  // and apply re-checks the sender domain against the current configuration instead.
  { fence: "none", vendorId: "email-send" },
);

/** Whether every recipient is at one of the comma-separated `internalDomains`. */
function isInternal(message: EmailSendMessage, internalDomains: string | undefined): boolean {
  const internal = parseDomainList(internalDomains);
  if (internal.length === 0) return false;
  return recipientsOf(message).every((address) => internal.includes(domainOf(address)));
}

function historyKey(id: number): string {
  return HISTORY_PREFIX + String(id).padStart(12, "0");
}

// ── Facet ───────────────────────────────────────────────────────────

type SenderProps = { sender: string };

/** What a session may ask of its facet, as closures so the session holds no facet reference. */
type SessionBackend = {
  sender: string;
  submit(queue: RpcStub<ApprovalQueue>, email: StoredEmail, internal: boolean): Promise<number>;
  wasSent(id: number): boolean;
  listSent(): EmailSendRecord[];
  internalDomains(): string | undefined;
  allowedDomains(): string | undefined;
};

class EmailSendSessionImpl extends RpcTarget implements EmailSendSession {
  readonly #backend: SessionBackend;
  readonly #queue: RpcStub<ApprovalQueue>;

  constructor(backend: SessionBackend, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#backend = backend;
    this.#queue = queue;
  }

  /** Validates the message and queues it for approval. */
  async send(message: EmailSendMessage): Promise<EmailSendReceipt> {
    const parsed = parseMessage(message);
    const sender = this.#backend.sender;
    assertSenderAllowed(sender, this.#backend.allowedDomains());
    const internal = isInternal(parsed, this.#backend.internalDomains());
    const id = await this.#backend.submit(this.#queue, { from: sender, message: parsed }, internal);
    // An auto-approved send may already have been applied while the submission was in flight.
    return { status: this.#backend.wasSent(id) ? "sent" : "pending", id };
  }

  /** Lists recent sends, pending ones included, after recording the read. */
  async listSent(): Promise<EmailSendRecord[]> {
    const rows = this.#backend.listSent();
    const observation: ObservationDescription = {
      title: "List sent email",
      description: `Listed ${rows.length} recent ${rows.length === 1 ? "email" : "emails"} from the sender address.`,
      fields: [{ label: "Sender", kind: "inline", value: this.#backend.sender }],
    };
    await this.#queue.authorizeObservation(observation);
    return rows;
  }

  /** The sender address; resource configuration, not provider data, so no observation. */
  async getSender(): Promise<string> {
    return this.#backend.sender;
  }

  [Symbol.dispose](): void {
    this.#queue[Symbol.dispose]();
  }
}

export class EmailSendGatekeeper
  extends DurableObject<Cloudflare.Env, SenderProps>
  implements Gatekeeper<EmailSendSession>
{
  readonly #journal = new ActionJournal<TaggedAction<Actions>>(this.ctx.storage.kv, {
    namespace: "email",
  });

  readonly #host: EmailHost = {
    deliver: (id, email) => this.#deliver(id, email),
    recordRejected: (id, email) => this.#record(id, email, { status: "rejected" }),
  };

  #actions() {
    return actions.bind(this.#journal, this.#host);
  }

  #sender(): string {
    // Props come from getGatekeeperClassFor, which validated them; re-parse anyway so a facet
    // never sends from anything but a plain address.
    return senderFromUrl(senderUrl(this.ctx.props.sender));
  }

  async #deliver(id: number, email: StoredEmail): Promise<void> {
    try {
      assertSenderAllowed(email.from, this.env.ALLOWED_SENDER_DOMAINS);
    } catch (error) {
      // Checked before anything is sent, so the email is known not to have gone out.
      throw new ActionApplyError(error instanceof Error ? error.message : String(error));
    }
    const { message } = email;
    let messageId: string;
    try {
      // The binding is structurally an EmailTransport; tests bind EMAIL to a fake with send().
      const transport: EmailTransport = this.env.EMAIL;
      ({ messageId } = await sendEmail(transport, {
        from: email.from,
        to: message.to,
        ...(message.cc ? { cc: message.cc } : {}),
        ...(message.bcc ? { bcc: message.bcc } : {}),
        subject: message.subject,
        ...(message.text !== undefined ? { text: message.text } : {}),
        ...(message.html !== undefined ? { html: message.html } : {}),
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      }));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // Rate and quota limits: refused, so a later retry is safe.
      if (isRetryableRefusal(error)) throw new Error(`Email Service refused for now: ${detail}`);
      if (isRefusedBeforeSending(error)) {
        throw new ActionApplyError(`Email Service refused this email: ${detail}`);
      }
      throw new ActionOutcomeUnknownError(
        `Email Service failed while sending, so the email may or may not have gone out: ${detail}`,
      );
    }
    this.#record(id, email, { status: "sent", sentAt: new Date().toISOString(), messageId });
  }

  #record(
    id: number,
    email: StoredEmail,
    outcome: Pick<HistoryEntry, "status" | "sentAt" | "messageId">,
  ): void {
    const kv = this.ctx.storage.kv;
    const entry: HistoryEntry = {
      id,
      to: recipientsOf(email.message),
      subject: email.message.subject,
      ...outcome,
    };
    kv.put(historyKey(id), entry);
    // Bounded: drop the oldest entries past the limit.
    const keys = [...kv.list<HistoryEntry>({ prefix: HISTORY_PREFIX })].map(([key]) => key);
    for (const key of keys.slice(0, Math.max(0, keys.length - HISTORY_LIMIT))) kv.delete(key);
  }

  /** History plus the sends still awaiting approval, newest first. */
  #listSent(): EmailSendRecord[] {
    const settled = [
      ...this.ctx.storage.kv.list<HistoryEntry>({ prefix: HISTORY_PREFIX, reverse: true }),
    ].map(
      ([, entry]): EmailSendRecord => ({
        id: entry.id,
        to: entry.to,
        subject: entry.subject,
        status: entry.status,
        ...(entry.sentAt ? { sentAt: entry.sentAt } : {}),
      }),
    );
    const pending = this.#journal.listPending().map(
      ({ id, action }): EmailSendRecord => ({
        id,
        to: recipientsOf(action.payload.message),
        subject: action.payload.message.subject,
        status: "pending",
      }),
    );
    return [...pending, ...settled].sort((a, b) => b.id - a.id).slice(0, LIST_LIMIT);
  }

  /** Describes the sender-address binding. */
  async describe(): Promise<ResourceDescription> {
    const sender = this.#sender();
    return {
      url: senderUrl(sender),
      title: `Email from ${sender}`,
      snippet: `Send email from ${sender}. Each email waits for approval unless it only goes to colleagues.`,
      suggestedBindingName: "EMAIL_SEND",
      tsType: "EmailSendSession",
    };
  }

  /** Returns the agent-facing EmailSendSession declarations. */
  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /** `email.internal` only: a send whose every recipient is a colleague. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return this.#actions().autoApprovableKinds();
  }

  /** Opens a session that submits each send through `approvalQueue`. */
  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<EmailSendSession> {
    const backend: SessionBackend = {
      sender: this.#sender(),
      submit: (queue, email, internal) =>
        this.#actions().submit(queue, internal ? "sendInternal" : "send", email),
      wasSent: (id) => this.#journal.wasApplied(id),
      listSent: () => this.#listSent(),
      internalDomains: () => this.env.INTERNAL_DOMAINS,
      allowedDomains: () => this.env.ALLOWED_SENDER_DOMAINS,
    };
    // The queue is disposed when this call returns, so the session keeps its own copy.
    return new EmailSendSessionImpl(backend, approvalQueue.dup());
  }

  /** No catalog: the session types say everything there is to know. */
  async getAgentCatalog(): Promise<AgentCatalog | null> {
    return null;
  }

  /** Admits every collaborator: the sent list holds only what this binding itself sent. */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  /** No observer state is kept. */
  async removeObserver(_id: string): Promise<void> {}

  /** Allows every observer. */
  async verifyObserverAccess(
    observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
    _subresources: string[],
  ): Promise<{ allowedObserverIds: string[] }> {
    return { allowedObserverIds: observers.map((observer) => observer.id) };
  }

  /** Sends an approved email, exactly once. */
  async applyAction(action: number): Promise<void> {
    await this.#actions().apply(requireActionId(action));
  }

  /** Drops a rejected email; it is never sent. */
  async rejectAction(action: number): Promise<void> {
    await this.#actions().reject(requireActionId(action));
  }

  revertAction(_action: number): Promise<void> {
    throw new Error("A sent email cannot be unsent.");
  }
}

function requireActionId(action: unknown): number {
  if (typeof action !== "number" || !Number.isSafeInteger(action) || action < 1) {
    throw new TypeError("Action ids are positive integers.");
  }
  return action;
}

// ── Account ─────────────────────────────────────────────────────────

/** The sender configurator's `ui` capability. */
export class SenderConfiguratorRpcImpl extends RpcTarget implements SenderConfiguratorRpc {
  readonly #allowed: string[];

  constructor(env: Cloudflare.Env) {
    super();
    this.#allowed = parseDomainList(env.ALLOWED_SENDER_DOMAINS);
  }

  async allowedDomains(): Promise<string[]> {
    return [...this.#allowed];
  }
}

// The CRM renders the configurator spec (src/configurator/sender-configurator-ui.tsx) itself; this
// frame is the fallback for a Workshop that only knows iframes.
const SENDER_CONFIGURATOR_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Sender address</title></head>
<body style="font-family: system-ui, sans-serif; margin: 0; padding: 1rem;">
<p>Enter the address email should be sent from, like <code>crm@example.com</code>.</p>
</body></html>`;

export class EmailSendAccount extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUser {
  /** Describes the account. All accounts are alike: none holds credentials. */
  async describe(): Promise<AccountDescription> {
    return {
      displayName: "Email sending",
      avatar: MAIL_ICON,
      grantedResourceUrlPatterns: [SENDER_URL_PATTERN],
    };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [SENDER_RESOURCE];
  }

  /** Returns the sender facet class for an allowed sender address. */
  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<EmailSendSession>>;
    resource: SupportedResource;
  }> {
    const sender = senderFromUrl(url);
    assertSenderAllowed(sender, this.env.ALLOWED_SENDER_DOMAINS);
    const props: SenderProps = { sender };
    return { class: this.ctx.exports.EmailSendGatekeeper({ props }), resource: SENDER_RESOURCE };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern !== SENDER_URL_PATTERN) {
      throw new Error(`Unsupported resource configurator type: ${String(resourceUrlPattern)}`);
    }
    return {
      iframeHtml: SENDER_CONFIGURATOR_HTML,
      ui: new RpcStub(new SenderConfiguratorRpcImpl(this.env)),
    };
  }

  /** Nothing to revoke: the account holds no credentials and no state. */
  async revoke(): Promise<void> {}

  reconnect(): Promise<{ url: string }> {
    throw new Error("Email sending has no connect flow.");
  }

  commitReconnect(_stageId: string): Promise<void> {
    throw new Error("Email sending has no connect flow.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  /** Mints the trivial verifier that goes with admitting every observer. */
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.EmailSendVerifier({});
  }

  /** No grant to expand: the sender resource needs no authorization. */
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }
}

export class EmailSendVerifier
  extends WorkerEntrypoint<Cloudflare.Env>
  implements GatekeeperUserVerifier {}

// ── Vendor ──────────────────────────────────────────────────────────

export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Email sending",
      url: "https://developers.cloudflare.com/email-service/",
      logo: MAIL_ICON,
      tagline: "Send email from your domain",
      description:
        "Let automations and extensions send email from your organization's own domain through " +
        "Cloudflare Email Service. Every email is shown for approval before it goes out.",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }

  /** The version tag of this Worker's running version, for the deployment's admins. */
  async versionTag(): Promise<string | undefined> {
    return workerVersionTag(this.env);
  }

  /** Mints a new account. */
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.EmailSendAccount({});
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("Email sending is auto-provisioned and has no connect flow.");
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [SENDER_RESOURCE];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

export default GatekeeperVendor;
