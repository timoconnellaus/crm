// The port between the operations registry and the integration host (ADRs 0050, 0110). crm-runner
// implements it (one integration host Durable Object per connection, which owns the gatekeeper
// accounts, facets and hooks); crm-app reaches the same implementation over the RUNNER service
// binding. Integration operations receive it through the invocation context, so packages/core
// never imports the runtime or the gatekeeper interface.
import type { PendingApproval } from "../errors.ts";
import type { Actor, Origin, Permission, Role } from "../principals.ts";

/** One resource bound on a connection: a facet the host owns, keyed within the connection. */
export interface BoundResource {
  /** Stable key of the facet within its connection (a hash of the resource URL). */
  key: string;
  url: string;
  /** The SupportedResource urlPattern it matched. */
  pattern: string;
  title: string;
  /** The session type agents code against (`GmailSession`), from the facet's describe(). */
  tsType: string;
  bindingName: string;
  hookTsType?: string | undefined;
}

/** Who is calling a gatekeeper session, so its ApprovalQueue routes and records as them. */
export interface IntegrationCaller {
  actor: Actor;
  userId: string;
  userName: string;
  role: Role;
  origin: Origin;
  grantedPermissions?: readonly Permission[] | undefined;
  reason?: string | undefined;
}

/** The result of a session call made through `integration.call`. */
export interface IntegrationCallResult {
  /** The method's result, as JSON (RPC stubs in it are described, not returned). */
  value: unknown;
  /** Outbound actions the call submitted that are waiting for approval. */
  pending: PendingApproval[];
  /** Outbound actions the call submitted that applied at once (auto-approved). */
  applied: { action: number; actionKind: string | null; title: string }[];
}

export interface ConnectStart {
  /** The provider's connect page (a bearer capability): open it in a popup. */
  url: string;
  /**
   * The per-flow nonce the popup keeps in sessionStorage and sends back with the ticket. The
   * host activates the staged account only for this nonce and the user who started the flow.
   */
  nonce: string;
}

export interface ConnectRedeemed {
  accountLabel: string | null;
  /** A further connect step for the same connection (a companion gatekeeper), if any. */
  next: (ConnectStart & { vendor: string }) | null;
}

/** What a sync source on a connection does (ADR 0112). */
export interface SyncConfig {
  /** The bound resource (key) holding mail, or null to stop syncing mail. */
  mail: string | null;
  /** The bound resource (key) holding calendar events, or null. */
  calendar: string | null;
  /** How far back the first sync reads. Default 90 days. */
  backfillDays?: number | undefined;
}

export interface IntegrationRuntime {
  /** Vendors whose gatekeeper Worker is bound in this deployment (`GATEKEEPER_<NAME>`). */
  availableVendors(): Promise<string[]>;
  /** Starts an OAuth connect flow for a new connection (the D1 mirror row already exists). */
  startConnect(input: {
    connectionId: string;
    vendor: string;
    userId: string;
    /** The CRM's public origin, where the popup is handed back (/connect/handoff). */
    appOrigin?: string | undefined;
  }): Promise<ConnectStart>;
  /** Mints an auto-provisioned account (web search, email sending, webhooks): no OAuth. */
  provision(input: { connectionId: string; vendor: string; userId: string }): Promise<{
    accountLabel: string | null;
  }>;
  /** Redeems the handoff ticket from the connect popup over the initiating user's session. */
  redeem(input: {
    connectionId: string;
    ticket: string;
    nonce: string;
    userId: string;
  }): Promise<ConnectRedeemed>;
  /** Starts a reconnect for an expired connection (same ticket and nonce handoff). */
  reconnect(input: {
    connectionId: string;
    userId: string;
    appOrigin?: string | undefined;
  }): Promise<ConnectStart>;
  /** Revokes the account and drops facets, hooks and sync. */
  disconnect(input: { connectionId: string }): Promise<void>;
  /** Creates (or returns) the facet for a resource URL on the connection. */
  bindResource(input: { connectionId: string; url: string }): Promise<BoundResource>;
  unbindResource(input: { connectionId: string; key: string }): Promise<void>;
  /** The resource types the connection's account offers (and its companion's), for pickers. */
  supportedResources(input: {
    connectionId: string;
  }): Promise<
    { urlPattern: string; title: string; description: string; grantable: boolean; vendor: string }[]
  >;
  /** Calls a method of the account's resource configurator `ui` capability (resource pickers). */
  configure(input: {
    connectionId: string;
    pattern: string;
    method: string;
    args: unknown[];
  }): Promise<unknown>;
  /** Calls a top-level method of a bound resource's session, as `caller`. */
  call(input: {
    connectionId: string;
    resource: string;
    method: string;
    args: unknown[];
    caller: IntegrationCaller;
  }): Promise<IntegrationCallResult>;
  /** The TypeScript declarations agents code against for a bound resource. */
  types(input: { connectionId: string; resource: string }): Promise<string>;
  /** Approval: applies a mirrored outbound action on its facet (in order per facet). */
  applyOutbound(input: { connectionId: string; facetKey: string; action: number }): Promise<void>;
  /** Rejection (or expiry): tells the facet to drop the action. */
  rejectOutbound(input: {
    connectionId: string;
    facetKey: string;
    action: number;
  }): Promise<{ restart?: boolean } | undefined>;
  /** Configures mail and calendar sync for the connection (ADR 0112). */
  setSync(input: { connectionId: string; config: SyncConfig }): Promise<void>;
  /** Runs a sync pass now (catch-up, or the next backfill chunk). */
  syncNow(input: { connectionId: string }): Promise<void>;
}

/** Blob storage for email bodies (R2, ADR 0112). */
export interface BlobStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(keys: string[]): Promise<void>;
}
