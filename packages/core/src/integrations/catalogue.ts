// The gatekeepers this release ships (ADR 0007, ADR 0050). Each is a Worker bound to ros-runner as
// `GATEKEEPER_<NAME>` (entrypoint `GatekeeperVendor`); an admin enables them per deployment. The
// catalogue is static so Settings → Integrations can list them without waking any gatekeeper.

export type ConnectKind = "oauth" | "auto";
export type SyncKind = "mail" | "calendar";

export interface CatalogueEntry {
  /** The vendor name: `GATEKEEPER_<UPPER_SNAKE>` binding, `/gatekeeper/<vendor>/*` routes. */
  vendor: string;
  title: string;
  description: string;
  /** OAuth popup flow, or an auto-provisioned account (`createAccount()`). */
  connect: ConnectKind;
  /** Who may create connections: personal (any member) and/or org (admins). */
  scopes: readonly ("personal" | "org")[];
  /** An auto-provisioned singleton exposed to every actor (web search, ADR 0050 amendment). */
  singleton?: boolean;
  /** Resource kinds the sync service reads, by urlPattern prefix. */
  sync?: Partial<Record<SyncKind, readonly string[]>>;
  /** Another gatekeeper connected in the same flow and connection (Slack posting). */
  companion?: string;
  /** Only offered in development and tests (the fake OAuth provider). */
  devOnly?: boolean;
}

export const CATALOGUE: readonly CatalogueEntry[] = [
  {
    vendor: "google",
    title: "Google Workspace",
    description: "Gmail, Google Calendar and Drive. Syncs mail and meetings onto timelines.",
    connect: "oauth",
    scopes: ["personal", "org"],
    sync: {
      mail: ["https://mail.google.com/"],
      calendar: ["https://calendar.google.com/"],
    },
  },
  {
    vendor: "microsoft",
    title: "Microsoft 365",
    description: "Outlook mail, Outlook Calendar and SharePoint. Syncs mail and meetings.",
    connect: "oauth",
    scopes: ["personal", "org"],
    sync: {
      mail: ["https://outlook.office.com/"],
      calendar: ["https://outlook.office.com/calendar"],
    },
  },
  {
    vendor: "slack",
    title: "Slack",
    description:
      "Read channels and threads, and post messages and DMs (with the Slack posting gatekeeper, " +
      "through the same Slack app).",
    connect: "oauth",
    scopes: ["personal", "org"],
    companion: "slack-post",
  },
  {
    vendor: "slack-post",
    title: "Slack (post messages)",
    description: "Post to channels and send DMs as the CRM's Slack bot.",
    connect: "oauth",
    scopes: ["org"],
  },
  {
    vendor: "mcp",
    title: "MCP server",
    description: "Connect any remote MCP server and use its tools through a gatekeeper.",
    connect: "oauth",
    scopes: ["personal", "org"],
  },
  {
    vendor: "email",
    title: "Inbound email",
    description: "Receive mail at a CRM address (Cloudflare Email Routing).",
    connect: "oauth",
    scopes: ["org"],
  },
  {
    vendor: "email-send",
    title: "Email sending",
    description: "Send email from the CRM's own addresses (Cloudflare Email Service).",
    connect: "auto",
    scopes: ["org"],
  },
  {
    vendor: "zoominfo",
    title: "ZoomInfo",
    description: "Manual, approved 'Enrich now' on people and organisations. No polling.",
    connect: "oauth",
    scopes: ["org"],
  },
  {
    vendor: "websearch",
    title: "Web search",
    description: "Search the public web (Cloudflare Web Search). Searches are observations.",
    connect: "auto",
    scopes: ["personal", "org"],
    singleton: true,
  },
  {
    vendor: "webhook",
    title: "Inbound webhooks",
    description:
      "External systems post signed events to the CRM. Bad signatures are rejected; good ones " +
      "become typed events for automations.",
    connect: "auto",
    scopes: ["org"],
  },
  {
    vendor: "fake",
    title: "Fake provider (development)",
    description: "A fake OAuth provider with a mailbox and calendar, for development and tests.",
    connect: "oauth",
    scopes: ["personal", "org"],
    sync: { mail: ["fake://mailbox/"], calendar: ["fake://calendar/"] },
    devOnly: true,
  },
];

export function catalogueEntry(vendor: string): CatalogueEntry | undefined {
  return CATALOGUE.find((entry) => entry.vendor === vendor);
}

/** `GATEKEEPER_<NAME>`: the ros-runner service binding of a vendor. */
export function vendorBinding(vendor: string): string {
  return `GATEKEEPER_${vendor.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

/** Which sync kind a resource URL feeds, for a vendor, if any. */
export function syncKindOf(vendor: string, url: string): SyncKind | null {
  const entry = catalogueEntry(vendor);
  // Calendar first: a mailbox prefix can be a prefix of the calendar one (Outlook).
  for (const kind of ["calendar", "mail"] as const) {
    if (entry?.sync?.[kind]?.some((prefix) => url.startsWith(prefix))) return kind;
  }
  return null;
}
