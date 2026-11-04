/** The `ui` capability `startResourceConfigurator` hands the sender configurator. */
export interface SenderConfiguratorRpc {
  /** The domains a sender address may use (ALLOWED_SENDER_DOMAINS). Empty: none is allowed. */
  allowedDomains(): Promise<string[]>;
}

/** The sender configurator's form values. */
export type SenderConfiguratorValues = {
  address?: string | null;
};
