// The configurator capability (`ui`) startResourceConfigurator() hands the host. Host/UI-only: it
// is the only way to set an endpoint's signing secret, and agent-facing sessions never reach it.

import type { WebhookScheme } from "../types.js";

/** The form's values: flat strings, as the configurator runtime keeps them. */
export type EndpointConfiguratorValues = {
  endpointId?: string | null;
  scheme?: string | null;
  /** A provider-issued secret (Stripe's `whsec_…`, Slack's signing secret); empty to generate one. */
  secret?: string | null;
  /** The secret `configure()` returned, shown once. */
  issuedSecret?: string | null;
  /** The public URL `configure()` returned. */
  deliveryUrl?: string | null;
  error?: string | null;
};

/** The endpoint's state, as `status()` reports it. Never the secret. */
export type EndpointConfiguratorStatus = {
  endpointId: string;
  url: string;
  configured: boolean;
  scheme: WebhookScheme | null;
  configuredAt: string | null;
  hookEnabled: boolean;
  accepted: number;
  duplicates: number;
  rejected: number;
  lastReceivedAt: string | null;
  lastRejectedAt: string | null;
  lastRejectionReason: string | null;
};

/** What `configure()` returns. */
export type EndpointConfigured = {
  endpointId: string;
  scheme: WebhookScheme;
  /** Returned this once; never readable again. */
  secret: string;
  /** The public URL to give the external system. */
  url: string;
};

export interface EndpointConfiguratorRpc {
  /** `webhook://endpoint/<endpointId>`. */
  resourceUrl(endpointId: unknown): Promise<string>;
  /**
   * Sets the scheme and secret: `{ endpointId, scheme, secret? }`. Without `secret`, generates one
   * (32 random bytes, hex).
   */
  configure(input: unknown): Promise<EndpointConfigured>;
  status(endpointId: unknown): Promise<EndpointConfiguratorStatus>;
}
