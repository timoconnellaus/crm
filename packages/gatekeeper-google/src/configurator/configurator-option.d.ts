// Vendored from cloudflare/cloudflare-os@a3ba4746b58f packages/gatekeeper-google/src/configurator/configurator-option.d.ts (Apache-2.0). Modified locally: see UPSTREAM.md in this package.
/**
 * Autocomplete row a configurator RPC returns. Local so server code can import
 * configurator types without pulling `@relationship-os/gatekeeper-configurator-ui`'s global `JSX`.
 */
export type ConfiguratorOption = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
};
