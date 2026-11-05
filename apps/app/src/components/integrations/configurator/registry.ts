// Which configurator spec renders the resource picker for a gatekeeper's resource type. Mirrors how
// each vendored gatekeeper's `startResourceConfigurator(resourceUrlPattern)` picks its frame
// (`packages/gatekeeper-*/src/<vendor>.ts`); the specs are loaded lazily, each in its own chunk.
import type { ConfiguratorUISpec } from "@relationship-os/gatekeeper-configurator-ui";

/** Specs by `<vendor>/<name>`; `configurator-spec:` is resolved by vite-plugin.ts. */
const SPECS = {
  "google/bigquery": () => import("configurator-spec:google/bigquery"),
  "google/calendar": () => import("configurator-spec:google/calendar"),
  "google/chat-account": () => import("configurator-spec:google/chat-account"),
  "google/chat-space": () => import("configurator-spec:google/chat-space"),
  "google/chat-thread": () => import("configurator-spec:google/chat-thread"),
  "google/drive": () => import("configurator-spec:google/drive"),
  "google/gmail": () => import("configurator-spec:google/gmail"),
  "microsoft/calendar": () => import("configurator-spec:microsoft/calendar"),
  "microsoft/outlook": () => import("configurator-spec:microsoft/outlook"),
  "microsoft/sharepoint": () => import("configurator-spec:microsoft/sharepoint"),
  "slack/workspace": () => import("configurator-spec:slack/workspace"),
  "slack/conversation": () => import("configurator-spec:slack/conversation"),
  "slack/thread": () => import("configurator-spec:slack/thread"),
  "mcp/server": () => import("configurator-spec:mcp/server"),
  "email/email": () => import("configurator-spec:email/email"),
  "zoominfo/account": () => import("configurator-spec:zoominfo/account"),
  "email-send/sender": () => import("configurator-spec:email-send/sender"),
  "webhook/endpoint": () => import("configurator-spec:webhook/endpoint"),
} as const;

export type ConfiguratorSpecName = keyof typeof SPECS;

export type ConfiguratorEntry = {
  vendor: string;
  /**
   * The resource type's `urlPattern`. For a vendor whose patterns depend on its deployment (email's
   * base URL) or that picks one spec for every pattern (MCP), an example; see `match`.
   */
  resourceUrlPattern: string;
  spec: ConfiguratorSpecName;
  /** How `resourceUrlPattern` is compared: exactly (the default), any pattern, or by its ending. */
  match?: "any" | "suffix";
  suffix?: string;
};

const DRIVE_PATTERNS = [
  "https://drive.google.com/drive/my-drive",
  "https://drive.google.com/drive/folders/:folderId",
  "https://drive.google.com/file/d/:fileId/view",
  "https://docs.google.com/document/d/:docId/*",
  "https://docs.google.com/spreadsheets/d/:spreadsheetId/*",
  "https://docs.google.com/presentation/d/:presentationId/*",
];

/** Every configurator the shipped gatekeepers use. */
export const CONFIGURATORS: readonly ConfiguratorEntry[] = [
  // gatekeeper-google: google.ts startResourceConfigurator, patterns from resources.ts.
  {
    vendor: "google",
    resourceUrlPattern: "https://bigquery.googleapis.com/:projectId/*",
    spec: "google/bigquery",
  },
  { vendor: "google", resourceUrlPattern: "https://mail.google.com/*", spec: "google/gmail" },
  {
    vendor: "google",
    resourceUrlPattern: "https://calendar.google.com/calendar/:calendarId/*",
    spec: "google/calendar",
  },
  { vendor: "google", resourceUrlPattern: "https://chat.google.com/", spec: "google/chat-account" },
  {
    vendor: "google",
    resourceUrlPattern: "https://chat.google.com/:kind(room|dm)/:spaceId",
    spec: "google/chat-space",
  },
  {
    vendor: "google",
    resourceUrlPattern: "https://chat.google.com/:kind(room|dm)/:spaceId/:threadId{/:messageId}?",
    spec: "google/chat-thread",
  },
  // Drive, and every type grouped with it, share one picker.
  ...DRIVE_PATTERNS.map(
    (resourceUrlPattern): ConfiguratorEntry => ({
      vendor: "google",
      resourceUrlPattern,
      spec: "google/drive",
    }),
  ),
  // gatekeeper-microsoft: microsoft.ts, patterns from microsoft-env.ts.
  {
    vendor: "microsoft",
    resourceUrlPattern: "https://outlook.office.com/*",
    spec: "microsoft/outlook",
  },
  {
    vendor: "microsoft",
    resourceUrlPattern: "https://outlook.office.com/calendar/*",
    spec: "microsoft/calendar",
  },
  {
    vendor: "microsoft",
    resourceUrlPattern: "https://*.sharepoint.com/*",
    spec: "microsoft/sharepoint",
  },
  // gatekeeper-slack: slack.ts. `https://*` is the whole workspace.
  { vendor: "slack", resourceUrlPattern: "https://*", spec: "slack/workspace" },
  {
    vendor: "slack",
    resourceUrlPattern: "https://app.slack.com/client/:teamId/:conversationId",
    spec: "slack/conversation",
  },
  {
    vendor: "slack",
    resourceUrlPattern: "https://*.slack.com/archives/:conversationId/:messageId",
    spec: "slack/thread",
  },
  // gatekeeper-mcp: mcp.ts uses its one frame whatever the pattern (`https://*` or `http://*`).
  { vendor: "mcp", resourceUrlPattern: "https://*", spec: "mcp/server", match: "any" },
  { vendor: "mcp", resourceUrlPattern: "http://*", spec: "mcp/server", match: "any" },
  // gatekeeper-email: `${BASE_URL}/mailbox/:user`, its base URL set per deployment.
  {
    vendor: "email",
    resourceUrlPattern: "http://localhost:8787/gatekeeper/email/mailbox/:user",
    spec: "email/email",
    match: "suffix",
    suffix: "/mailbox/:user",
  },
  // gatekeeper-zoominfo: zoominfo.ts, its one whole-account resource.
  { vendor: "zoominfo", resourceUrlPattern: "https://*", spec: "zoominfo/account" },
  // gatekeeper-email-send (ours): sender.ts SENDER_URL_PATTERN.
  {
    vendor: "email-send",
    resourceUrlPattern: "email-send://sender/:address",
    spec: "email-send/sender",
  },
  // gatekeeper-webhook (ours): validate.ts ENDPOINT_URL_PATTERN.
  {
    vendor: "webhook",
    resourceUrlPattern: "webhook://endpoint/:endpointId",
    spec: "webhook/endpoint",
  },
  // TODO(stage 6): gatekeeper-slack-post (ours, `slack-post://workspace/:teamId`) has no spec yet;
  // add it here once it exports one.
];

/** The entry for a vendor's resource type, or null when it has no configurator. */
export function configuratorEntryFor(
  vendor: string,
  resourceUrlPattern: string,
): ConfiguratorEntry | null {
  const entries = CONFIGURATORS.filter((entry) => entry.vendor === vendor);
  return (
    entries.find((entry) => !entry.match && entry.resourceUrlPattern === resourceUrlPattern) ??
    entries.find(
      (entry) =>
        entry.match === "any" ||
        (entry.match === "suffix" &&
          entry.suffix !== undefined &&
          resourceUrlPattern.endsWith(entry.suffix)),
    ) ??
    null
  );
}

type SpecModule = {
  default: ConfiguratorUISpec<unknown>;
  createConfiguratorSpec?: () => ConfiguratorUISpec<unknown>;
};

/** Loads a spec by name, as a fresh instance (its module state starts afresh, as in a new frame). */
export async function loadConfiguratorSpec(
  name: ConfiguratorSpecName,
): Promise<ConfiguratorUISpec<unknown>> {
  const module = (await SPECS[name]()) as SpecModule;
  return module.createConfiguratorSpec ? module.createConfiguratorSpec() : module.default;
}

/**
 * The spec that renders the picker for `resourceUrlPattern` of `vendor`, or null when there is
 * none. Each call returns a fresh instance: load one per form you show, as upstream opens a frame.
 */
export async function configuratorSpecFor(
  vendor: string,
  resourceUrlPattern: string,
): Promise<ConfiguratorUISpec<unknown> | null> {
  const entry = configuratorEntryFor(vendor, resourceUrlPattern);
  return entry ? loadConfiguratorSpec(entry.spec) : null;
}
