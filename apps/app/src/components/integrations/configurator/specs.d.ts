// The vendored configurator specs, as registry.ts imports them through vite-plugin.ts. They are
// type-checked in their own packages (against the authoring API, with `jsxFactory: "h"`); the app's
// program sees only this shape, so `tsc` does not compile vendored sources under the app's settings.
declare module "configurator-spec:*" {
  import type { ConfiguratorUISpec } from "@relationship-os/gatekeeper-configurator-ui";

  /** A fresh instance of the spec, with module state of its own (see vite-plugin.ts). */
  export function createConfiguratorSpec(): ConfiguratorUISpec<unknown>;
  const spec: ConfiguratorUISpec<unknown>;
  export default spec;
}
