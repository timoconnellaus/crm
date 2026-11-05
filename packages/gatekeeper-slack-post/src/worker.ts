// ros-gatekeeper-slack-post: posts Slack messages and DMs with a bot token. It complements the
// vendored read-only Slack gatekeeper and uses the same Slack app (CLIENT_ID / CLIENT_SECRET).
// A workspace is the resource; its facet turns every `post()` and `dm()` into an approval-queue
// action and only calls Slack once the action is applied. README.md explains the design.
//
// No capnweb-validate decorators (the CRM app's dev server cannot transform them): every RPC input
// is validated explicitly, see validate.ts.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  AccountDescription,
  ActionKind,
  AgentCatalog,
  ApprovalQueue,
  ConnectHandoff,
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
import { stripTrailingSlashes, workerVersionTag } from "@relationship-os/gatekeeper-interface/gatekeeper";
import { buildDescription, sanitizeTitle } from "@relationship-os/gatekeeper-kit/action-description";
import {
  ActionApplyError,
  ActionJournal,
  ActionOutcomeUnknownError,
  defineActions,
  type TaggedAction,
} from "@relationship-os/gatekeeper-kit/actions";
import { withAuthRetry } from "@relationship-os/gatekeeper-kit/auth-retry";
import {
  advanceToOAuth,
  claimOAuth,
  isConnectAttempted,
  markConnectAttempted,
  NONCE_KEY,
  putInitiation,
  type StoredNonce,
} from "@relationship-os/gatekeeper-kit/connect-handshake";
import { generateNonce } from "@relationship-os/gatekeeper-kit/connect-nonce";
import {
  connectHandoffPageHtml,
  errorPageHtml,
  htmlResponse,
  INVALID_LINK_HTML,
} from "@relationship-os/gatekeeper-kit/connect-pages";
import { notifyCredentialsExpiredOnce } from "@relationship-os/gatekeeper-kit/credential-expiry";
import {
  commitStagedCredentials,
  discardStagedCredentials,
  stageCredentials,
} from "@relationship-os/gatekeeper-kit/credential-stage";
import {
  CredentialCoordinator,
  CredentialsExpiredError,
  type CredentialsWithIdentity,
  isConnectionSuperseded,
  type RejectionVerdict,
} from "@relationship-os/gatekeeper-kit/credentials";
import {
  BOT_SCOPES,
  callSlack,
  exchangeCode,
  isGrantDeath,
  isSlackAuthError,
  refreshGrant,
  revokeToken,
  SlackApiError,
  type SlackBotGrant,
  slackEndpoints,
} from "./slack-api";
import type {
  SlackChannel,
  SlackDirectMessage,
  SlackPostMessage,
  SlackPostReceipt,
  SlackPostRecord,
  SlackPostSession,
  SlackUser,
} from "./types";
import TYPES_CODE from "./types.txt";
import { isChannelId, isTeamId, isUserId, parseDm, parseEmail, parsePost } from "./validate";

const VENDOR_ID = "slack-post";
const EXPIRED_MESSAGE =
  "The Slack (post messages) connection has expired. Reconnect it in the CRM.";

const SLACK_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
        "<path d='M216 40H40a16 16 0 0 0-16 16v160a15.85 15.85 0 0 0 9.24 14.5A16.05 16.05 0 0 0 40 232a15.89 15.89 0 0 0 10.25-3.78l.09-.07L83 200h133a16 16 0 0 0 16-16V56a16 16 0 0 0-16-16Zm0 144H80a8 8 0 0 0-5.15 1.87L40 216V56h176Z'/></svg>",
    ),
};

// ── Resource ────────────────────────────────────────────────────────

const WORKSPACE_URL_PATTERN = "slack-post://workspace/:teamId";
const WORKSPACE_URL_PREFIX = "slack-post://workspace/";

const WORKSPACE_RESOURCE: SupportedResource = {
  urlPattern: WORKSPACE_URL_PATTERN,
  title: "Slack workspace (post messages)",
  description:
    "Post messages to channels and send direct messages as the CRM's Slack app. Every message " +
    "waits for approval before it is sent.",
  icon: SLACK_ICON,
  grantable: true,
};

function workspaceUrl(teamId: string): string {
  return WORKSPACE_URL_PREFIX + teamId;
}

function teamIdFromUrl(url: unknown): string {
  if (typeof url !== "string" || url.length > 256 || !url.startsWith(WORKSPACE_URL_PREFIX)) {
    throw new TypeError(`Not a Slack workspace URL; expected ${WORKSPACE_URL_PATTERN}.`);
  }
  const teamId = url.slice(WORKSPACE_URL_PREFIX.length).replace(/\/$/, "");
  if (!isTeamId(teamId))
    throw new TypeError("The Slack workspace URL does not name a team id (T…).");
  return teamId;
}

/** The bot scopes a connect requests for `resourceUrlPatterns` (`[]`: identity only). */
function scopesFor(resourceUrlPatterns: unknown): string[] {
  if (resourceUrlPatterns === undefined) return [...BOT_SCOPES];
  if (
    !Array.isArray(resourceUrlPatterns) ||
    resourceUrlPatterns.length > 10 ||
    !resourceUrlPatterns.every((pattern) => pattern === WORKSPACE_URL_PATTERN)
  ) {
    throw new Error(
      `Unknown grantable resource URL pattern; this vendor has ${WORKSPACE_URL_PATTERN}.`,
    );
  }
  // An empty list asks for no resource authorization: only what identifies the workspace.
  return resourceUrlPatterns.length === 0 ? ["users:read"] : [...BOT_SCOPES];
}

function grantsPosting(scopes: readonly string[]): boolean {
  return BOT_SCOPES.every((scope) => scopes.includes(scope));
}

// ── Environment ─────────────────────────────────────────────────────

type Env = Cloudflare.Env;

function baseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL || "http://localhost:8787/gatekeeper/slack-post");
}

function basePath(env: Env): string {
  const path = new URL(baseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

function redirectUri(env: Env): string {
  return `${baseUrl(env)}/oauth`;
}

function clientOf(env: Env): { id: string; secret: string } | null {
  return env.CLIENT_ID && env.CLIENT_SECRET
    ? { id: env.CLIENT_ID, secret: env.CLIENT_SECRET }
    : null;
}

const NOT_CONFIGURED_HTML = errorPageHtml(
  "Slack posting is not configured",
  "An administrator must set the Slack app's CLIENT_ID and CLIENT_SECRET on ros-gatekeeper-slack-post.",
);

const HEX_ID = /^[0-9a-f]{64}$/;

// ── Account Durable Object: credentials and the connect handshake ───

/** Metadata a connect attempt carries from its link to its callback. */
type AttemptMeta = { firstConnect?: true; scopes: string[]; startedUnder?: string };

type ReconnectStage = { grant: SlackBotGrant; startedUnder: string };

/** What crosses the account RPC boundary: never the refresh token. */
type PublicCreds = { token: string; expiresAt?: number; teamId: string };

/** The connected workspace, for display and resource checks. */
type WorkspaceInfo = { teamId: string; teamName?: string; botUserId?: string; scopes: string[] };

const CALLBACK_KEY = "callback";
const ABANDONED_CONNECT_MS = 60 * 60 * 1000;

export class SlackPostUserAccount extends DurableObject<Env> {
  readonly #creds = new CredentialCoordinator<SlackBotGrant>(this.ctx.storage.kv, {
    expiresAt: (grant) => grant.expiresAt,
    vendorId: VENDOR_ID,
  });

  #refresh = async (current: SlackBotGrant): Promise<SlackBotGrant> => {
    const client = clientOf(this.env);
    if (!client) throw new Error("Slack posting is not configured.");
    try {
      return await refreshGrant(slackEndpoints(this.env), client, current);
    } catch (error) {
      if (isGrantDeath(error)) throw new CredentialsExpiredError(EXPIRED_MESSAGE, { cause: error });
      throw error;
    }
  };

  #notify = () =>
    notifyCredentialsExpiredOnce(
      this.ctx.storage.kv,
      this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>(CALLBACK_KEY),
      VENDOR_ID,
    );

  /** Starts a first connect: stores the Workshop callback and returns the link nonce. */
  async beginConnect(
    callback: Fetcher<GatekeeperConnectCallback>,
    scopes: string[],
  ): Promise<string> {
    const kv = this.ctx.storage.kv;
    if (isConnectAttempted(kv)) throw new Error("This account has already been connected.");
    kv.put(CALLBACK_KEY, callback);
    const nonce = generateNonce();
    putInitiation<AttemptMeta>(kv, nonce, Date.now(), { firstConnect: true, scopes });
    // Self-destruct if the flow is never completed.
    await this.ctx.storage.setAlarm(Date.now() + ABANDONED_CONNECT_MS);
    return nonce;
  }

  /** Starts a reconnect or grant expansion: its grant will be staged, not made live. */
  async prepareReconnect(scopes: string[]): Promise<string> {
    if (this.#creds.stored() === undefined) throw new Error("This account is not connected.");
    const nonce = generateNonce();
    putInitiation<AttemptMeta>(this.ctx.storage.kv, nonce, Date.now(), { scopes });
    return nonce;
  }

  /** Advances a link nonce to the OAuth stage, or null when the link is stale. */
  async beginOAuth(
    initiationNonce: string,
  ): Promise<{ oauthNonce: string; scopes: string[] } | null> {
    if (typeof initiationNonce !== "string") return null;
    const kv = this.ctx.storage.kv;
    const oauthNonce = advanceToOAuth(kv, initiationNonce, Date.now(), {
      startedUnder: this.#creds.connectionGeneration(),
    });
    if (oauthNonce === null) return null;
    const stored = kv.get<StoredNonce<AttemptMeta>>(NONCE_KEY);
    return { oauthNonce, scopes: stored?.scopes ?? [...BOT_SCOPES] };
  }

  /**
   * Finishes the OAuth callback: claims the nonce before exchanging the code, then completes a
   * first connect live or stages a reconnect. Returns the handoff for the final page, or null when
   * the callback is stale or replayed.
   */
  async acceptCode(code: string, oauthNonce: string): Promise<ConnectHandoff | null> {
    if (typeof code !== "string" || typeof oauthNonce !== "string" || code.length > 512)
      return null;
    const kv = this.ctx.storage.kv;
    const claim = claimOAuth<AttemptMeta>(kv, oauthNonce, Date.now());
    if (claim === null) return null;
    const callback = kv.get<Fetcher<GatekeeperConnectCallback>>(CALLBACK_KEY);
    if (!callback) throw new Error("This connection attempt has expired. Start again.");
    const client = clientOf(this.env);
    if (!client) throw new Error("Slack posting is not configured.");

    const grant = await exchangeCode(slackEndpoints(this.env), client, code, redirectUri(this.env));
    const startedUnder = claim.startedUnder ?? "";

    if (claim.firstConnect === true) {
      if (isConnectAttempted(kv)) throw new Error("This account has already been connected.");
      try {
        this.#creds.connect(grant, { ifGeneration: startedUnder });
      } catch (error) {
        if (!isConnectionSuperseded(error)) throw error;
        throw new Error("This account's connection changed. Start again.", { cause: error });
      }
      markConnectAttempted(kv);
      await this.ctx.storage.deleteAlarm();
      const user = this.ctx.exports.SlackPostAccount({
        props: { accountId: this.ctx.id.toString() },
      });
      return callback.complete(user);
    }

    // A reconnect: the link is a bearer capability, so the grant is staged until the Workshop
    // confirms the completing browser is the owner's (commitReconnect).
    if (this.#creds.connectionGeneration() !== startedUnder) {
      throw new Error("This account's connection changed while reconnecting. Start again.");
    }
    const live = this.#creds.stored();
    if (live !== undefined && live.teamId !== grant.teamId) {
      throw new Error(
        "That is a different Slack workspace. Reconnect the same workspace, or add a new connection.",
      );
    }
    discardStagedCredentials<ReconnectStage>(kv);
    const stageId = stageCredentials<ReconnectStage>(kv, { grant, startedUnder }, Date.now());
    return callback.reconnectComplete(stageId);
  }

  /** Makes exactly the staged reconnect live. */
  async commitReconnect(stageId: string): Promise<void> {
    if (typeof stageId !== "string") throw new TypeError("stageId must be a string.");
    const staged = commitStagedCredentials<ReconnectStage>(
      this.ctx.storage.kv,
      Date.now(),
      stageId,
    );
    if (staged === null) throw new Error("This reconnect stage is no longer available.");
    try {
      this.#creds.connect(staged.grant, { ifGeneration: staged.startedUnder });
    } catch (error) {
      if (!isConnectionSuperseded(error)) throw error;
      throw new Error("This account's connection changed while reconnecting.", { cause: error });
    }
  }

  /** The current bot token, refreshed as needed; refresh material stays here. */
  async getCredentials(): Promise<CredentialsWithIdentity<PublicCreds>> {
    const { creds, identity, generation } = await this.#creds.snapshot(this.#refresh, {
      notify: this.#notify,
    });
    return {
      creds: {
        token: creds.accessToken,
        teamId: creds.teamId,
        ...(creds.expiresAt !== undefined ? { expiresAt: creds.expiresAt } : {}),
      },
      identity,
      generation,
    };
  }

  /** Adjudicates a token Slack refused, healing past it with a refresh where it can. */
  async reportCredentialsRejected(identity: string): Promise<RejectionVerdict> {
    if (typeof identity !== "string") throw new TypeError("identity must be a string.");
    return this.#creds.adjudicateRejection(identity, {
      refresh: this.#refresh,
      notify: this.#notify,
    });
  }

  /** The connected workspace, or null before the connect completes. */
  async info(): Promise<WorkspaceInfo | null> {
    const grant = this.#creds.stored();
    if (grant === undefined) return null;
    return {
      teamId: grant.teamId,
      scopes: grant.scopes,
      ...(grant.teamName ? { teamName: grant.teamName } : {}),
      ...(grant.botUserId ? { botUserId: grant.botUserId } : {}),
    };
  }

  /** Revokes the connection: local state first, then Slack, best effort. */
  async revoke(): Promise<void> {
    const live = this.#creds.stored();
    const staged = discardStagedCredentials<ReconnectStage>(this.ctx.storage.kv);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    const endpoints = slackEndpoints(this.env);
    if (staged !== null) await revokeToken(endpoints, staged.grant.accessToken);
    if (live !== undefined) await revokeToken(endpoints, live.accessToken);
  }

  /** Deletes an account whose connect was abandoned. */
  override async alarm(): Promise<void> {
    if (this.#creds.stored() === undefined) await this.ctx.storage.deleteAll();
  }
}

// ── Account entrypoint ──────────────────────────────────────────────

type AccountProps = { accountId: string };

function accountStub(ctx: { exports: Cloudflare.Exports }, accountId: string) {
  if (!HEX_ID.test(accountId)) throw new TypeError("Malformed account id.");
  const namespace = ctx.exports.SlackPostUserAccount;
  return namespace.get(namespace.idFromString(accountId));
}

/** The account's `ui` capability for the workspace configurator. */
class WorkspaceConfiguratorRpc extends RpcTarget {
  readonly #workspace: { teamId: string; teamName?: string };

  constructor(workspace: { teamId: string; teamName?: string }) {
    super();
    this.#workspace = workspace;
  }

  /** The one workspace this connection posts to. */
  async workspace(): Promise<{ teamId: string; teamName?: string; resourceUrl: string }> {
    return { ...this.#workspace, resourceUrl: workspaceUrl(this.#workspace.teamId) };
  }
}

const WORKSPACE_CONFIGURATOR_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Slack workspace</title></head>
<body style="font-family: system-ui, sans-serif; margin: 0; padding: 1rem;">
<p>Messages are posted to the Slack workspace this connection was made with.</p>
</body></html>`;

export class SlackPostAccount
  extends WorkerEntrypoint<Env, AccountProps>
  implements GatekeeperUser
{
  #account() {
    return accountStub(this.ctx, this.ctx.props.accountId);
  }

  async #requireInfo(): Promise<WorkspaceInfo> {
    const info = await this.#account().info();
    if (info === null) throw new Error("This Slack connection is not connected.");
    return info;
  }

  async describe(): Promise<AccountDescription> {
    const info = await this.#requireInfo();
    return {
      displayName: info.teamName ? `${info.teamName} (posting)` : "Slack (posting)",
      uniqueName: info.teamId,
      avatar: SLACK_ICON,
      grantedResourceUrlPatterns: grantsPosting(info.scopes) ? [WORKSPACE_URL_PATTERN] : [],
    };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [WORKSPACE_RESOURCE];
  }

  /** Returns the posting facet for this connection's own workspace. */
  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<SlackPostSession>>;
    resource: SupportedResource;
  }> {
    const teamId = teamIdFromUrl(url);
    const info = await this.#requireInfo();
    if (info.teamId !== teamId) {
      throw new Error("This Slack connection is for a different workspace.");
    }
    const props: FacetProps = { accountId: this.ctx.props.accountId, teamId };
    return { class: this.ctx.exports.SlackPostGatekeeper({ props }), resource: WORKSPACE_RESOURCE };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern !== WORKSPACE_URL_PATTERN) {
      throw new Error(`Unsupported resource configurator type: ${String(resourceUrlPattern)}`);
    }
    const info = await this.#requireInfo();
    return {
      iframeHtml: WORKSPACE_CONFIGURATOR_HTML,
      ui: new RpcStub(
        new WorkspaceConfiguratorRpc({
          teamId: info.teamId,
          ...(info.teamName ? { teamName: info.teamName } : {}),
        }),
      ),
    };
  }

  async revoke(): Promise<void> {
    await this.#account().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const nonce = await this.#account().prepareReconnect([...BOT_SCOPES]);
    return { url: connectUrl(this.env, this.ctx.props.accountId, nonce) };
  }

  async commitReconnect(stageId: string): Promise<void> {
    await this.#account().commitReconnect(stageId);
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.SlackPostVerifier({});
  }

  /** Requests the posting scopes through a staged reconnect when this connection lacks them. */
  async ensureResources(resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    const scopes = scopesFor(resourceUrlPatterns);
    const info = await this.#requireInfo();
    if (scopes.every((scope) => info.scopes.includes(scope))) return {};
    const nonce = await this.#account().prepareReconnect([...BOT_SCOPES]);
    return { url: connectUrl(this.env, this.ctx.props.accountId, nonce) };
  }
}

/** Admits every observer: a binding's posts are visible to everyone in the workspace channel. */
export class SlackPostVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {}

function connectUrl(env: Env, accountId: string, nonce: string): string {
  return `${baseUrl(env)}/connect/${accountId}/${nonce}`;
}

// ── Actions ─────────────────────────────────────────────────────────

type PostPayload = {
  channelId: string;
  channelName?: string;
  text: string;
  threadTs?: string;
  relatedRecords?: string[];
};

type DmPayload = {
  userId: string;
  userName?: string;
  userEmail?: string;
  text: string;
  relatedRecords?: string[];
};

type Actions = { post: PostPayload; dm: DmPayload };

/** A settled message, as `listRecentPosts()` reports it. */
type HistoryEntry = {
  id: number;
  kind: "post" | "dm";
  target: string;
  text: string;
  status: "posted" | "rejected";
  ts?: string;
  postedAt?: string;
};

type SlackHost = {
  post(id: number, payload: PostPayload): Promise<void>;
  dm(id: number, payload: DmPayload): Promise<void>;
  recordRejected(id: number, kind: "post" | "dm", target: string, text: string): void;
};

const POST_KIND: ActionKind = { tag: "slack.post", label: "Post to Slack" };
const DM_KIND: ActionKind = { tag: "slack.dm", label: "Send a Slack DM" };

function channelLabel(payload: PostPayload): string {
  return payload.channelName ? `#${payload.channelName}` : payload.channelId;
}

function userLabel(payload: DmPayload): string {
  return payload.userName ?? payload.userEmail ?? payload.userId;
}

const actions = defineActions<SlackHost, Actions>(
  {
    post: {
      kind: POST_KIND,
      autoApprovable: false,
      delivery: "continue-with-simulation",
      // A crash between Slack accepting the message and recording it must not post it twice.
      claimBeforeApply: true,
      describe: (payload) => {
        const builder = buildDescription(
          payload.threadTs
            ? "Replies in a Slack thread as the CRM's Slack app."
            : "Posts a message to a Slack channel as the CRM's Slack app.",
        ).inline(
          "Channel",
          payload.channelName
            ? `#${payload.channelName} (${payload.channelId})`
            : payload.channelId,
        );
        if (payload.threadTs) builder.inline("Thread", payload.threadTs);
        builder.verbatim("Message", payload.text, "markdown");
        if (payload.relatedRecords) builder.list("Related records", payload.relatedRecords);
        return {
          title: sanitizeTitle(`Post to Slack: ${channelLabel(payload)}`),
          ...builder.finish(),
          implementsRevert: false,
        };
      },
      apply: (payload, host, ctx) => host.post(ctx.id, payload),
      reject: async (payload, host, ctx) =>
        host.recordRejected(ctx.id, "post", channelLabel(payload), payload.text),
    },
    dm: {
      kind: DM_KIND,
      autoApprovable: false,
      delivery: "continue-with-simulation",
      claimBeforeApply: true,
      describe: (payload) => {
        const builder = buildDescription("Sends a direct message as the CRM's Slack app.").inline(
          "To",
          payload.userName ? `${payload.userName} (${payload.userId})` : payload.userId,
        );
        if (payload.userEmail) builder.inline("Email", payload.userEmail);
        builder.verbatim("Message", payload.text, "markdown");
        if (payload.relatedRecords) builder.list("Related records", payload.relatedRecords);
        return {
          title: sanitizeTitle(`Send a Slack DM to ${userLabel(payload)}`),
          ...builder.finish(),
          implementsRevert: false,
        };
      },
      apply: (payload, host, ctx) => host.dm(ctx.id, payload),
      reject: async (payload, host, ctx) =>
        host.recordRejected(ctx.id, "dm", userLabel(payload), payload.text),
    },
  },
  // The payload names channel and user ids in one workspace. Apply checks the live connection is
  // still for that workspace instead of pinning the connection generation, so a reconnect of the
  // same workspace (a token rotation or re-consent) does not strand approved messages.
  { fence: "none", vendorId: VENDOR_ID },
);

// ── Facet ───────────────────────────────────────────────────────────

type FacetProps = { accountId: string; teamId: string };

const HISTORY_PREFIX = "history:";
const HISTORY_LIMIT = 200;
const LIST_LIMIT = 100;
const SNIPPET_LENGTH = 200;
const MAX_CHANNEL_PAGES = 5;
const CHANNEL_PAGE_SIZE = 200;
const CHANNEL_CACHE_MS = 5 * 60 * 1000;
const TOKEN_SAFETY_MS = 60 * 1000;

function historyKey(id: number): string {
  return HISTORY_PREFIX + String(id).padStart(12, "0");
}

function snippet(text: string): string {
  return text.length > SNIPPET_LENGTH ? `${text.slice(0, SNIPPET_LENGTH)}…` : text;
}

function requireActionId(action: unknown): number {
  if (typeof action !== "number" || !Number.isSafeInteger(action) || action < 1) {
    throw new TypeError("Action ids are positive integers.");
  }
  return action;
}

type CachedToken = { token: string; expiresAt?: number; identity: string; teamId: string };

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function toChannel(raw: unknown): SlackChannel | null {
  const channel = asRecord(raw);
  if (typeof channel.id !== "string" || typeof channel.name !== "string") return null;
  return {
    id: channel.id,
    name: channel.name,
    isMember: channel.is_member === true,
    isArchived: channel.is_archived === true,
  };
}

function toUser(raw: unknown): SlackUser | null {
  const user = asRecord(raw);
  if (typeof user.id !== "string" || typeof user.name !== "string") return null;
  const profile = asRecord(user.profile);
  const realName = typeof user.real_name === "string" ? user.real_name : profile.real_name;
  const displayName = profile.display_name;
  return {
    id: user.id,
    name: user.name,
    ...(typeof realName === "string" && realName ? { realName } : {}),
    ...(typeof displayName === "string" && displayName ? { displayName } : {}),
  };
}

/** What a session may ask of its facet, as closures so the session holds no facet reference. */
type SessionBackend = {
  submitPost(queue: RpcStub<ApprovalQueue>, payload: PostPayload): Promise<number>;
  submitDm(queue: RpcStub<ApprovalQueue>, payload: DmPayload): Promise<number>;
  wasPosted(id: number): boolean;
  resolveChannel(channel: string): Promise<{ id: string; name?: string }>;
  resolveUser(user: string): Promise<{ id: string; name?: string; email?: string }>;
  listChannels(): Promise<SlackChannel[]>;
  findUser(email: string): Promise<SlackUser | null>;
  listRecentPosts(): SlackPostRecord[];
  teamId: string;
};

class SlackPostSessionImpl extends RpcTarget implements SlackPostSession {
  readonly #backend: SessionBackend;
  readonly #queue: RpcStub<ApprovalQueue>;

  constructor(backend: SessionBackend, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#backend = backend;
    this.#queue = queue;
  }

  async post(message: SlackPostMessage): Promise<SlackPostReceipt> {
    const input = parsePost(message);
    const channel = await this.#backend.resolveChannel(input.channel);
    const id = await this.#backend.submitPost(this.#queue, {
      channelId: channel.id,
      ...(channel.name ? { channelName: channel.name } : {}),
      text: input.text,
      ...(input.threadTs ? { threadTs: input.threadTs } : {}),
      ...(input.relatedRecords?.length ? { relatedRecords: [...input.relatedRecords] } : {}),
    });
    return { status: this.#backend.wasPosted(id) ? "posted" : "pending", id };
  }

  async dm(message: SlackDirectMessage): Promise<SlackPostReceipt> {
    const input = parseDm(message);
    const user = await this.#backend.resolveUser(input.user);
    const id = await this.#backend.submitDm(this.#queue, {
      userId: user.id,
      ...(user.name ? { userName: user.name } : {}),
      ...(user.email ? { userEmail: user.email } : {}),
      text: input.text,
      ...(input.relatedRecords?.length ? { relatedRecords: [...input.relatedRecords] } : {}),
    });
    return { status: this.#backend.wasPosted(id) ? "posted" : "pending", id };
  }

  async listChannels(): Promise<SlackChannel[]> {
    const channels = await this.#backend.listChannels();
    await this.#authorize({
      title: "List Slack channels",
      description: `Listed ${channels.length} public Slack channels.`,
      fields: [{ label: "Workspace", kind: "inline", value: this.#backend.teamId }],
    });
    return channels;
  }

  async findUser(email: string): Promise<SlackUser | null> {
    const address = parseEmail(email);
    const user = await this.#backend.findUser(address);
    await this.#authorize({
      title: "Look up a Slack user",
      description: user
        ? "Found a Slack user by email address."
        : "Looked up a Slack user by email address; there was none.",
      fields: [{ label: "Email", kind: "inline", value: address }],
    });
    return user;
  }

  async listRecentPosts(): Promise<SlackPostRecord[]> {
    const rows = this.#backend.listRecentPosts();
    await this.#authorize({
      title: "List recent Slack posts",
      description: `Listed ${rows.length} recent messages sent through this binding.`,
    });
    return rows;
  }

  #authorize(description: ObservationDescription): Promise<void> {
    return this.#queue.authorizeObservation(description);
  }

  [Symbol.dispose](): void {
    this.#queue[Symbol.dispose]();
  }
}

export class SlackPostGatekeeper
  extends DurableObject<Env, FacetProps>
  implements Gatekeeper<SlackPostSession>
{
  readonly #journal = new ActionJournal<TaggedAction<Actions>>(this.ctx.storage.kv, {
    namespace: "slack",
  });

  readonly #host: SlackHost = {
    post: (id, payload) => this.#applyPost(id, payload),
    dm: (id, payload) => this.#applyDm(id, payload),
    recordRejected: (id, kind, target, text) =>
      this.#record({ id, kind, target, text: snippet(text), status: "rejected" }),
  };

  // Tokens are cached per facet instance, so a run of calls costs one account RPC, not one each.
  #token: CachedToken | undefined;
  #channels: { at: number; list: SlackChannel[] } | undefined;

  #actions() {
    return actions.bind(this.#journal, this.#host);
  }

  #account() {
    return accountStub(this.ctx, this.ctx.props.accountId);
  }

  async #getToken(options: {
    forceRefresh: boolean;
    staleToken?: CachedToken;
  }): Promise<CachedToken> {
    const cached = this.#token;
    if (
      !options.forceRefresh &&
      cached !== undefined &&
      (cached.expiresAt === undefined || cached.expiresAt > Date.now() + TOKEN_SAFETY_MS)
    ) {
      return cached;
    }
    if (options.forceRefresh && options.staleToken) {
      this.#token = undefined;
      const verdict = await this.#account().reportCredentialsRejected(options.staleToken.identity);
      if (verdict === "expired") throw new CredentialsExpiredError(EXPIRED_MESSAGE);
    }
    const { creds, identity } = await this.#account().getCredentials();
    const token: CachedToken = {
      token: creds.token,
      identity,
      teamId: creds.teamId,
      ...(creds.expiresAt !== undefined ? { expiresAt: creds.expiresAt } : {}),
    };
    this.#token = token;
    return token;
  }

  /** Runs a Slack call with the cached token, refreshing once if Slack refuses it. */
  #withToken<T>(call: (token: string) => Promise<T>): Promise<T> {
    return withAuthRetry<CachedToken, T>(
      {
        getToken: (options) => this.#getToken(options),
        isAuthError: isSlackAuthError,
        // A refused token means Slack did nothing, so the call can run again.
        replayable: true,
      },
      async (token) => {
        if (token.teamId !== this.ctx.props.teamId) {
          throw new ActionApplyError("This Slack connection now points at a different workspace.");
        }
        return call(token.token);
      },
    );
  }

  #slack(method: string, params: Record<string, string | undefined>) {
    const endpoints = slackEndpoints(this.env);
    return this.#withToken((token) => callSlack(endpoints, method, params, token));
  }

  async #listChannels(): Promise<SlackChannel[]> {
    if (this.#channels && Date.now() - this.#channels.at < CHANNEL_CACHE_MS) {
      return this.#channels.list;
    }
    const list: SlackChannel[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_CHANNEL_PAGES; page++) {
      const data = await this.#slack("conversations.list", {
        types: "public_channel",
        exclude_archived: "true",
        limit: String(CHANNEL_PAGE_SIZE),
        cursor,
      });
      for (const raw of Array.isArray(data.channels) ? data.channels : []) {
        const channel = toChannel(raw);
        if (channel) list.push(channel);
      }
      const next = asRecord(data.response_metadata).next_cursor;
      if (typeof next !== "string" || next === "") break;
      cursor = next;
    }
    this.#channels = { at: Date.now(), list };
    return list;
  }

  async #resolveChannel(channel: string): Promise<{ id: string; name?: string }> {
    if (isChannelId(channel)) {
      const known = (await this.#listChannels()).find((c) => c.id === channel);
      return known ? { id: known.id, name: known.name } : { id: channel };
    }
    const name = channel.replace(/^#/, "");
    const found = (await this.#listChannels()).find((c) => c.name === name);
    if (!found) throw new Error(`No public Slack channel is named #${name}.`);
    return { id: found.id, name: found.name };
  }

  async #findUser(email: string): Promise<SlackUser | null> {
    try {
      const data = await this.#slack("users.lookupByEmail", { email });
      return toUser(data.user);
    } catch (error) {
      if (error instanceof SlackApiError && error.code === "users_not_found") return null;
      throw error;
    }
  }

  async #resolveUser(user: string): Promise<{ id: string; name?: string; email?: string }> {
    if (isUserId(user)) {
      try {
        const found = toUser((await this.#slack("users.info", { user })).user);
        return found ? { id: found.id, name: found.name } : { id: user };
      } catch (error) {
        if (error instanceof SlackApiError && error.code === "user_not_found") {
          throw new Error("No Slack user has that id.");
        }
        throw error;
      }
    }
    const found = await this.#findUser(user);
    if (!found) throw new Error("No Slack user in this workspace has that email address.");
    return { id: found.id, name: found.name, email: user };
  }

  /** Posts, classifying a failure by what Slack can have done. */
  async #postMessage(channel: string, text: string, threadTs?: string): Promise<string> {
    try {
      const data = await this.#slack("chat.postMessage", { channel, text, thread_ts: threadTs });
      return typeof data.ts === "string" ? data.ts : "";
    } catch (error) {
      if (error instanceof ActionApplyError || error instanceof CredentialsExpiredError)
        throw error;
      if (error instanceof SlackApiError) {
        // Slack answered ok:false: nothing was posted. Rate limits are worth another attempt.
        if (error.isRateLimited) throw new Error(error.message);
        throw new ActionApplyError(error.message);
      }
      throw new ActionOutcomeUnknownError(
        `Slack did not confirm the message, so it may or may not have been posted: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async #applyPost(id: number, payload: PostPayload): Promise<void> {
    const ts = await this.#postMessage(payload.channelId, payload.text, payload.threadTs);
    this.#record({
      id,
      kind: "post",
      target: channelLabel(payload),
      text: snippet(payload.text),
      status: "posted",
      ts,
      postedAt: new Date().toISOString(),
    });
  }

  async #applyDm(id: number, payload: DmPayload): Promise<void> {
    let channel: string;
    try {
      const data = await this.#slack("conversations.open", { users: payload.userId });
      const opened = asRecord(data.channel).id;
      if (typeof opened !== "string") throw new Error("Slack did not return the DM channel.");
      channel = opened;
    } catch (error) {
      // Opening the DM posts nothing; a Slack refusal is final, anything else is retryable.
      if (error instanceof SlackApiError && !error.isRateLimited) {
        throw new ActionApplyError(error.message);
      }
      throw error;
    }
    const ts = await this.#postMessage(channel, payload.text);
    this.#record({
      id,
      kind: "dm",
      target: userLabel(payload),
      text: snippet(payload.text),
      status: "posted",
      ts,
      postedAt: new Date().toISOString(),
    });
  }

  #record(entry: HistoryEntry): void {
    const kv = this.ctx.storage.kv;
    kv.put(historyKey(entry.id), entry);
    const keys = [...kv.list<HistoryEntry>({ prefix: HISTORY_PREFIX })].map(([key]) => key);
    for (const key of keys.slice(0, Math.max(0, keys.length - HISTORY_LIMIT))) kv.delete(key);
  }

  #listRecentPosts(): SlackPostRecord[] {
    const settled = [
      ...this.ctx.storage.kv.list<HistoryEntry>({ prefix: HISTORY_PREFIX, reverse: true }),
    ].map(([, entry]): SlackPostRecord => ({ ...entry }));
    const pending = this.#journal.listPending().map(
      ({ id, action }): SlackPostRecord =>
        action.kind === "post"
          ? {
              id,
              kind: "post",
              target: channelLabel(action.payload),
              text: snippet(action.payload.text),
              status: "pending",
            }
          : {
              id,
              kind: "dm",
              target: userLabel(action.payload),
              text: snippet(action.payload.text),
              status: "pending",
            },
    );
    return [...pending, ...settled].sort((a, b) => b.id - a.id).slice(0, LIST_LIMIT);
  }

  async describe(): Promise<ResourceDescription> {
    const teamId = this.ctx.props.teamId;
    return {
      url: workspaceUrl(teamId),
      title: "Slack (post messages)",
      snippet:
        "Post messages to channels and send direct messages as the CRM's Slack app. Each one waits for approval.",
      suggestedBindingName: "SLACK_POST",
      tsType: "SlackPostSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /** None: every Slack message is reviewed. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return this.#actions().autoApprovableKinds();
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<SlackPostSession> {
    const backend: SessionBackend = {
      submitPost: (queue, payload) => this.#actions().submit(queue, "post", payload),
      submitDm: (queue, payload) => this.#actions().submit(queue, "dm", payload),
      wasPosted: (id) => this.#journal.wasApplied(id),
      resolveChannel: (channel) => this.#resolveChannel(channel),
      resolveUser: (user) => this.#resolveUser(user),
      listChannels: () => this.#listChannels(),
      findUser: (email) => this.#findUser(email),
      listRecentPosts: () => this.#listRecentPosts(),
      teamId: this.ctx.props.teamId,
    };
    // The queue is disposed when this call returns, so the session keeps its own copy.
    return new SlackPostSessionImpl(backend, approvalQueue.dup());
  }

  async getAgentCatalog(): Promise<AgentCatalog | null> {
    return null;
  }

  /** Admits every collaborator: reads cover public channels and this binding's own posts. */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  async removeObserver(_id: string): Promise<void> {}

  async verifyObserverAccess(
    observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
    _subresources: string[],
  ): Promise<{ allowedObserverIds: string[] }> {
    return { allowedObserverIds: observers.map((observer) => observer.id) };
  }

  /** Posts an approved message, exactly once. */
  async applyAction(action: number): Promise<void> {
    await this.#actions().apply(requireActionId(action));
  }

  /** Drops a rejected message; it is never posted. */
  async rejectAction(action: number): Promise<void> {
    await this.#actions().reject(requireActionId(action));
  }

  revertAction(_action: number): Promise<void> {
    throw new Error("A posted Slack message cannot be withdrawn through this binding.");
  }
}

// ── Vendor and public routes ────────────────────────────────────────

export class GatekeeperVendor extends WorkerEntrypoint<Env> {
  /**
   * The public connect routes, proxied by ros-app from https://<crm-origin>/gatekeeper/slack-post/*:
   * `GET {BASE_URL}/connect/<account>/<nonce>` redirects to Slack's consent page, and
   * `GET {BASE_URL}/oauth` is Slack's redirect back, ending on the Workshop handoff page.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
    const url = new URL(request.url);
    const prefix = basePath(this.env);
    if (!url.pathname.startsWith(`${prefix}/`)) return new Response("Not Found", { status: 404 });
    const segments = url.pathname.slice(prefix.length + 1).split("/");

    if (segments.length === 3 && segments[0] === "connect") {
      const [, accountId = "", nonce = ""] = segments;
      if (!HEX_ID.test(accountId) || !HEX_ID.test(nonce))
        return htmlResponse(INVALID_LINK_HTML, 400);
      const client = clientOf(this.env);
      if (!client) return htmlResponse(NOT_CONFIGURED_HTML, 500);
      const begun = await accountStub(this.ctx, accountId).beginOAuth(nonce);
      if (begun === null) return htmlResponse(INVALID_LINK_HTML, 400);
      const authorize = new URL(`${slackEndpoints(this.env).oauthBase}/authorize`);
      authorize.searchParams.set("client_id", client.id);
      authorize.searchParams.set("scope", begun.scopes.join(","));
      authorize.searchParams.set("redirect_uri", redirectUri(this.env));
      authorize.searchParams.set("state", `${accountId}:${begun.oauthNonce}`);
      return new Response(null, {
        status: 302,
        headers: {
          Location: authorize.toString(),
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      });
    }

    if (segments.length === 1 && segments[0] === "oauth") {
      const error = url.searchParams.get("error");
      if (error) {
        return htmlResponse(
          errorPageHtml(
            "Slack authorization was not completed",
            `Slack said: ${error.slice(0, 100)}`,
          ),
          400,
        );
      }
      const [accountId = "", oauthNonce = ""] = (url.searchParams.get("state") ?? "").split(":");
      const code = url.searchParams.get("code") ?? "";
      if (!HEX_ID.test(accountId) || !HEX_ID.test(oauthNonce) || code === "") {
        return htmlResponse(INVALID_LINK_HTML, 400);
      }
      let handoff: ConnectHandoff | null;
      try {
        handoff = await accountStub(this.ctx, accountId).acceptCode(code, oauthNonce);
      } catch (failure) {
        const detail = failure instanceof Error ? failure.message : "Start the connection again.";
        return htmlResponse(errorPageHtml("Slack could not be connected", detail), 400);
      }
      if (handoff === null) return htmlResponse(INVALID_LINK_HTML, 400);
      return htmlResponse(connectHandoffPageHtml(handoff));
    }

    return new Response("Not Found", { status: 404 });
  }

  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Slack (post messages)",
      url: "https://slack.com",
      logo: SLACK_ICON,
      color: "#f4ede4",
      tagline: "Post messages and DMs",
      description:
        "Let automations and extensions post to Slack channels and send direct messages as the " +
        "CRM's Slack app. Every message is shown for approval before it is sent. Uses the same " +
        "Slack app as the read-only Slack connection.",
      providesAuth: false,
    };
  }

  async versionTag(): Promise<string | undefined> {
    return workerVersionTag(this.env);
  }

  async connectAccount(
    callback: Fetcher<GatekeeperConnectCallback>,
    options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    const scopes = scopesFor(options?.resourceUrlPatterns);
    const namespace = this.ctx.exports.SlackPostUserAccount;
    const id = namespace.newUniqueId();
    const nonce = await namespace.get(id).beginConnect(callback, scopes);
    return { url: connectUrl(this.env, id.toString(), nonce) };
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [WORKSPACE_RESOURCE];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

export default GatekeeperVendor;
