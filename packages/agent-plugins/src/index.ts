// @relationship-os/agent-plugins (ADR 0347, ADR 0350): assistant plugins. The `plugin.json`
// schema, Agent Plugins import, fingerprinting, the three-way diff, the merge-proposal protocol and
// scope resolution arrive in stage 17's W7. Until then this is the package's home.

/** The scopes a plugin can be installed in. */
export const PLUGIN_SCOPES = ["personal", "team", "org"] as const;
export type PluginScope = (typeof PLUGIN_SCOPES)[number];
