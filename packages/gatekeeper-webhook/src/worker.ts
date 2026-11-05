// ros-gatekeeper-webhook: inbound webhooks. External systems POST signed events to
// `${BASE_URL}/in/:endpointId`. The default fetch handler bounds the body and hands it to the
// endpoint's WebhookEndpoint Durable Object, which verifies the signature, shapes a typed
// WebhookEvent and delivers it to the hook the CRM bound through `WebhookSession.subscribe()`.
// README.md explains the design.
//
// No capnweb-validate decorators (the CRM's Vite dev server runs this Worker as an auxiliary
// worker and cannot transform them): every RPC input is checked by the guards in validate.ts.

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
  HookController,
  HookInitiator,
  HookTargetMetadata,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@relationship-os/gatekeeper-interface/gatekeeper";
import {
  stripTrailingSlashes,
  workerVersionTag,
} from "@relationship-os/gatekeeper-interface/gatekeeper";
import type { EndpointConfiguratorRpc } from "./configurator/endpoint-configurator-types.js";
import { type EndpointStatus, type StoredInitiator, WebhookEndpoint } from "./endpoint.js";
import type {
  WebhookEndpointInfo,
  WebhookEvent,
  WebhookEventHook,
  WebhookScheme,
  WebhookSession,
} from "./types.js";
import TYPES_CODE from "./types.txt";
import {
  assertEndpointId,
  ENDPOINT_URL_PATTERN,
  endpointIdFromUrl,
  endpointUrl,
  isEndpointId,
  parseConfigureInput,
  parseListLimit,
} from "./validate.js";

export type { EndpointStatus, WebhookEndpointInfo, WebhookEvent, WebhookEventHook, WebhookSession };
export { WebhookEndpoint };

/** The largest body accepted; a larger one is answered 413. */
// Not exported: a Worker's main module may export only handlers and classes (workerd refuses a
// constant export at startup).
const MAX_BODY_BYTES = 256 * 1024;
/** Request headers handed to the endpoint DO: at most this many, each value at most this long. */
const MAX_HEADERS = 100;
const MAX_HEADER_VALUE = 8 * 1024;

const WEBHOOK_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>" +
        "<path d='M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2'/>" +
        "<path d='m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06'/>" +
        "<path d='m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8'/></svg>",
    ),
};

const ENDPOINT_RESOURCE: SupportedResource = {
  urlPattern: ENDPOINT_URL_PATTERN,
  title: "Webhook endpoint",
  description: "Receive signed events that an external system posts to a CRM URL.",
  icon: WEBHOOK_ICON,
  grantable: true,
};

/** The inert frame startResourceConfigurator() serves until the CRM renders configurator specs. */
const CONFIGURATOR_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Webhook endpoint</title></head>
  <body>
    <p>Configure this webhook endpoint from the CRM's integration settings.</p>
  </body>
</html>`;

type Env = Cloudflare.Env;
type EndpointProps = { endpointId: string };
/** WebhookEventHook as the hook generics need it: an RpcTarget. */
type WebhookHookTarget = RpcTarget & WebhookEventHook;

/** The public base deliveries are posted under, without a trailing slash. */
export function baseUrl(env: Env): string {
  const configured: string = env.BASE_URL;
  return stripTrailingSlashes(configured || "http://localhost:5173/gatekeeper/webhook");
}

/** The public URL external systems POST to for `endpointId`. */
export function deliveryUrl(env: Env, endpointId: string): string {
  return `${baseUrl(env)}/in/${endpointId}`;
}

function endpointStub(env: Env, endpointId: string): DurableObjectStub<WebhookEndpoint> {
  return env.WEBHOOK_ENDPOINT.get(env.WEBHOOK_ENDPOINT.idFromName(endpointId));
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Reads at most `limit` bytes of the body, or undefined if it is longer. */
async function readBounded(request: Request, limit: number): Promise<Uint8Array | undefined> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function headerRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  let count = 0;
  for (const [name, value] of headers) {
    if (++count > MAX_HEADERS) break;
    record[name.toLowerCase()] = value.slice(0, MAX_HEADER_VALUE);
  }
  return record;
}

/** The endpoint id of a delivery path, `<base path>/in/<id>`, or undefined. */
function deliveryEndpointId(env: Env, pathname: string): string | undefined {
  const basePath = new URL(baseUrl(env)).pathname.replace(/\/+$/, "");
  const prefix = `${basePath}/in/`;
  if (!pathname.startsWith(prefix)) return undefined;
  const id = pathname.slice(prefix.length);
  return isEndpointId(id) ? id : undefined;
}

/** `POST ${BASE_URL}/in/:endpointId`: one webhook delivery. */
async function handleDelivery(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const endpointId = deliveryEndpointId(env, url.pathname);
  if (endpointId === undefined) return json(404, { ok: false, error: "not found" });
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json; charset=utf-8", allow: "POST" },
    });
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return json(413, { ok: false, error: "payload too large" });
  const body = await readBounded(request, MAX_BODY_BYTES);
  if (body === undefined) return json(413, { ok: false, error: "payload too large" });

  const result = await endpointStub(env, endpointId).receive(headerRecord(request.headers), body);
  return json(result.status, result.body);
}

// =======================================================================================
// The agent-facing session.

class WebhookSessionImpl extends RpcTarget implements WebhookSession {
  readonly #env: Env;
  readonly #ctx: DurableObjectState<EndpointProps>;
  readonly #endpointId: string;
  readonly #approvalQueue: RpcStub<ApprovalQueue>;

  constructor(
    env: Env,
    ctx: DurableObjectState<EndpointProps>,
    endpointId: string,
    approvalQueue: RpcStub<ApprovalQueue>,
  ) {
    super();
    this.#env = env;
    this.#ctx = ctx;
    this.#endpointId = endpointId;
    this.#approvalQueue = approvalQueue;
  }

  /** The endpoint's public URL, scheme and whether its secret is set. Never the secret. */
  async getEndpoint(): Promise<WebhookEndpointInfo> {
    const status = await endpointStub(this.#env, this.#endpointId).status(this.#endpointId);
    return {
      endpointId: this.#endpointId,
      url: deliveryUrl(this.#env, this.#endpointId),
      scheme: status.scheme ?? "hmac-sha256",
      configured: status.configured,
    };
  }

  /** Asks the host to bind `hook`; it fires once a human approves and the host enables it. */
  async subscribe(hook: RpcStub<WebhookHookTarget>): Promise<void> {
    if (hook === null || (typeof hook !== "object" && typeof hook !== "function")) {
      throw new TypeError("subscribe() takes a stub implementing WebhookEventHook.");
    }
    const props: EndpointProps = { endpointId: this.#endpointId };
    const controller = this.#ctx.exports.WebhookHookController({ props });
    // The RPC stub types of two Fetcher<HookController<…>> instantiations do not unify (the email
    // gatekeeper hits the same), so the call is typed by the interface's own signature.
    const queue = this.#approvalQueue as unknown as Pick<ApprovalQueue, "bindHook">;
    await queue.bindHook<WebhookHookTarget>(
      controller as unknown as Fetcher<HookController<WebhookHookTarget>>,
      hook,
      {
        title: `Receive webhook events (${this.#endpointId})`,
        description:
          `Deliver each verified event posted to webhook endpoint \`${this.#endpointId}\` ` +
          `(${deliveryUrl(this.#env, this.#endpointId)}).`,
      },
    );
  }

  /** The most recent verified events, newest first, after recording the read. */
  async listEvents(options?: { limit?: number }): Promise<WebhookEvent[]> {
    const limit = parseListLimit(options);
    await this.#approvalQueue.authorizeObservation({
      title: `List webhook events (${this.#endpointId})`,
      description: `Read up to ${limit} recent events received at webhook endpoint \`${this.#endpointId}\`.`,
    });
    return endpointStub(this.#env, this.#endpointId).listEvents(limit);
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]();
  }
}

// =======================================================================================
// The per-endpoint gatekeeper facet.

export class WebhookEndpointGatekeeper
  extends DurableObject<Env, EndpointProps>
  implements Gatekeeper<WebhookSession>
{
  #endpointId(): string {
    return assertEndpointId(this.ctx.props.endpointId);
  }

  async describe(): Promise<ResourceDescription> {
    const endpointId = this.#endpointId();
    return {
      url: endpointUrl(endpointId),
      title: `Webhook endpoint ${endpointId}`,
      snippet: `Receive signed events posted to ${deliveryUrl(this.env, endpointId)}.`,
      suggestedBindingName: "WEBHOOK",
      tsType: "WebhookSession",
      hookTsType: "WebhookEventHook",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /** No outbound actions. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<WebhookSession> {
    // The queue is disposed when this call returns, so the session keeps its own copy.
    return new WebhookSessionImpl(this.env, this.ctx, this.#endpointId(), approvalQueue.dup());
  }

  async getAgentCatalog(): Promise<AgentCatalog | null> {
    return null;
  }

  /** Admits every collaborator: the endpoint belongs to the deployment, not to one person. */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  async removeObserver(_id: string): Promise<void> {}

  async verifyObserverAccess(
    observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
    _subresources: string[],
  ): Promise<{ allowedObserverIds: string[] }> {
    return { allowedObserverIds: observers.map((observer) => observer.id) };
  }

  applyAction(_action: number): Promise<void> {
    throw new Error("Webhook endpoints implement no actions.");
  }

  rejectAction(_action: number): Promise<void> {
    throw new Error("Webhook endpoints implement no actions.");
  }

  revertAction(_action: number): Promise<void> {
    throw new Error("Webhook endpoints implement no actions.");
  }
}

// =======================================================================================
// Hook controller: the host enables it with an initiator once a human approves the hook.

export class WebhookHookController
  extends WorkerEntrypoint<Env, EndpointProps>
  implements HookController<WebhookHookTarget>
{
  async enable(
    initiator: Fetcher<HookInitiator<WebhookHookTarget>>,
    target: HookTargetMetadata,
  ): Promise<void> {
    if (initiator === null || (typeof initiator !== "object" && typeof initiator !== "function")) {
      throw new TypeError("enable() takes a HookInitiator stub.");
    }
    const workspaceId =
      typeof target?.workspaceId === "string" ? target.workspaceId.slice(0, 200) : "";
    const metadata: HookTargetMetadata = { workspaceId };
    if (typeof target?.gadgetId === "number" && Number.isInteger(target.gadgetId)) {
      metadata.gadgetId = target.gadgetId;
    }
    const endpointId = assertEndpointId(this.ctx.props.endpointId);
    await endpointStub(this.env, endpointId).setHook(
      initiator as unknown as StoredInitiator,
      metadata,
    );
  }

  async disable(): Promise<void> {
    const endpointId = assertEndpointId(this.ctx.props.endpointId);
    await endpointStub(this.env, endpointId).setHook(null);
  }
}

// =======================================================================================
// The configurator capability: host/UI-only. It is the only way to set an endpoint's secret.

export class EndpointConfiguratorUi extends RpcTarget implements EndpointConfiguratorRpc {
  readonly #env: Env;

  constructor(env: Env) {
    super();
    this.#env = env;
  }

  /** The resource URL for `endpointId`. */
  async resourceUrl(endpointId: unknown): Promise<string> {
    return endpointUrl(assertEndpointId(endpointId));
  }

  /**
   * Sets the endpoint's scheme and signing secret, generating a secret (32 random bytes, hex) when
   * none is given. The secret is returned here once and is never readable again.
   */
  async configure(
    input: unknown,
  ): Promise<{ endpointId: string; scheme: WebhookScheme; secret: string; url: string }> {
    const { endpointId, scheme, secret: given } = parseConfigureInput(input);
    const secret = given ?? generateSecret();
    await endpointStub(this.#env, endpointId).configure(endpointId, scheme, secret);
    return { endpointId, scheme, secret, url: deliveryUrl(this.#env, endpointId) };
  }

  /** The endpoint's configuration and delivery counts. Never the secret. */
  async status(endpointId: unknown): Promise<EndpointStatus & { url: string }> {
    const id = assertEndpointId(endpointId);
    const status = await endpointStub(this.#env, id).status(id);
    return { ...status, url: deliveryUrl(this.#env, id) };
  }
}

function generateSecret(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// =======================================================================================
// Account, verifier and vendor.

export class WebhookAccount extends WorkerEntrypoint<Env> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return { displayName: "Inbound webhooks", avatar: WEBHOOK_ICON };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [ENDPOINT_RESOURCE];
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<WebhookSession>>;
    resource: SupportedResource;
  }> {
    const endpointId = endpointIdFromUrl(url);
    const props: EndpointProps = { endpointId };
    return {
      class: this.ctx.exports.WebhookEndpointGatekeeper({ props }) as unknown as DurableObjectClass<
        Gatekeeper<WebhookSession>
      >,
      resource: ENDPOINT_RESOURCE,
    };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern !== ENDPOINT_URL_PATTERN) {
      throw new Error(`Unsupported resource type: ${String(resourceUrlPattern).slice(0, 200)}`);
    }
    return {
      iframeHtml: CONFIGURATOR_HTML,
      ui: new RpcStub(new EndpointConfiguratorUi(this.env)),
    };
  }

  /** Nothing to revoke: an account holds no credentials; endpoints belong to the deployment. */
  async revoke(): Promise<void> {}

  reconnect(): Promise<{ url: string }> {
    throw new Error("Inbound webhooks have no connect flow.");
  }

  commitReconnect(_stageId: string): Promise<void> {
    throw new Error("Inbound webhooks have no connect flow.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.WebhookVerifier({}) as unknown as Fetcher<GatekeeperUserVerifier>;
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }
}

/** The trivial verifier that goes with admitting every observer. */
export class WebhookVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

/**
 * The vendor, and the Worker's default entrypoint: its `fetch` serves the public delivery route
 * (`POST ${BASE_URL}/in/:endpointId`), which the CRM proxies from /gatekeeper/webhook/*.
 */
export class GatekeeperVendor extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Promise<Response> {
    return handleDelivery(request, this.env);
  }

  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Inbound webhooks",
      url: baseUrl(this.env),
      logo: WEBHOOK_ICON,
      tagline: "Receive signed events from external systems",
      description:
        "Give external systems (GitHub, Stripe, Slack or anything that signs with HMAC-SHA256) a " +
        "CRM URL to post events to. Signatures are verified; verified events reach automations.",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }

  async versionTag(): Promise<string | undefined> {
    return workerVersionTag(this.env);
  }

  /** Mints a new account. All accounts are alike: none holds credentials. */
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.WebhookAccount({}) as unknown as Fetcher<GatekeeperUser>;
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("Inbound webhooks are auto-provisioned and have no connect flow.");
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [ENDPOINT_RESOURCE];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

export default GatekeeperVendor;
