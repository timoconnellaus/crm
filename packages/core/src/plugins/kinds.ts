// The item kinds this app accepts in a plugin (ADR 0347), with what each body looks like, where it
// may be installed and what access it implies. Email templates and report definitions join here
// when stages 13 and reports exist: a new kind is one entry and, if it makes something in the
// workspace, one materialiser (materialise.ts).
import { producerNameSchema } from "@relationship-os/agent-a2ui";
import { createKindRegistry, type PluginItemKind } from "@relationship-os/agent-plugins";
import { z } from "zod";
import { routineDefinitionSchema } from "../assistant/routines.ts";
import { dashboardSpecSchema, widgetSpecSchema } from "../dashboards/spec.ts";
import { preferenceChannelsSchema } from "../notifications/preferences.ts";
import { objectViewSpecSchema } from "../views/spec.ts";

const EVERYONE = ["personal", "team", "role", "org"] as const;
const PEOPLE = ["personal", "team", "role"] as const;
const ORG = ["org"] as const;

const skillBody = z.object({
  name: z.string().min(1).max(120).describe("What it is called by, such as meetingPrep.brief"),
  description: z.string().trim().min(1).max(400),
  instructions: z.string().trim().min(1).max(20_000),
});

/** A script that reads as the viewer (ADR 0346). */
const scriptBody = z.object({
  name: producerNameSchema,
  description: z.string().trim().min(1).max(400),
  source: z.string().min(1).max(100_000),
  catalogue: z.number().int().min(1).default(1),
});

const agentProfileBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().trim().min(1).max(400),
  instructions: z.string().trim().min(1).max(10_000),
  role: z.enum(["assistant.subagent"]).optional(),
  defaultGrant: z.object({
    operations: z.array(z.string().min(1).max(120)).max(100),
    caps: z.object({
      changes: z.number().int().min(0).max(1_000),
      notes: z.number().int().min(0).max(1_000),
      tasks: z.number().int().min(0).max(1_000),
    }),
    expiresInHours: z.number().int().min(1).max(168),
  }),
  budget: z.object({
    steps: z.number().int().min(1).max(1_000),
    minutes: z.number().int().min(1).max(240),
    spendUsd: z.number().min(0).max(20),
  }),
});

const presetBody = z.object({
  /** "When I say …, I mean …". */
  shortcuts: z.array(z.string().trim().min(3).max(300)).max(20).default([]),
  /** A writing-style starter. */
  style: z.array(z.string().trim().min(3).max(300)).max(20).default([]),
});

const ruleTemplateBody = z.object({
  /** A contract line in plain English, for connected assistants to start from. */
  rules: z.array(z.string().trim().min(3).max(300)).min(1).max(20),
});

const viewBody = z.object({ spec: objectViewSpecSchema });

const dashboardBody = z.object({
  description: z.string().max(1_000).nullish(),
  spec: dashboardSpecSchema,
});

const widgetBody = z.object({ spec: widgetSpecSchema });

const savedSearchBody = z.object({ query: z.string().trim().min(1).max(200) });

/** Goes somewhere or asks something: a quick action never runs an operation by itself. */
const quickActionBody = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("open"),
    href: z
      .string()
      .max(500)
      .regex(/^\/(?!\/)/, "a path in the app"),
  }),
  z.object({ action: z.literal("ask"), prompt: z.string().trim().min(3).max(500) }),
]);

const recordPanelBody = z.object({
  object: z.string().min(1).max(80),
  /** A saved card, given `{ recordId }`. */
  producer: producerNameSchema,
  input: z.record(z.string(), z.unknown()).default({}),
});

const notificationBody = z.object({
  channels: preferenceChannelsSchema.default({}),
  digest: z.boolean().optional(),
  digestInApp: z.boolean().optional(),
});

const needAlternative = z.object({
  service: z.string().min(1).max(80),
  label: z.string().trim().min(1).max(80),
  vendors: z.array(z.string().min(1).max(60)).min(1).max(10),
});

const connectionBody = z.object({
  /** What the plugin calls it: gmail, calendar, `mcp:pricing`. */
  service: z.string().min(1).max(80),
  /** Connections of these vendors satisfy it. */
  vendors: z.array(z.string().min(1).max(60)).max(10).default([]),
  /** Only the person can sign in to a personal one; an admin adds a workspace one. */
  level: z.enum(["personal", "workspace"]).default("personal"),
  reason: z.string().trim().min(1).max(300),
  /** What the assistant may swap in when this one is missing (Gmail to Outlook). */
  alternatives: z.array(needAlternative).max(5).default([]),
  /** The open Agent Plugins format: an MCP server, to wrap as a gatekeeper connection. */
  integration: z.literal("mcp").optional(),
  server: z.object({ name: z.string().max(120), url: z.string().url() }).optional(),
});
export type ConnectionNeedBody = z.infer<typeof connectionBody>;

/** Files of an extension, or an extension whose job is a workspace automation. */
const extensionBody = z.object({
  id: z.string().min(2).max(30),
  version: z.string().max(40),
  files: z.record(z.string().min(1).max(200), z.string().max(200_000)),
  /** The extension's own request: read and checked again when it is proposed. */
  summary: z.string().trim().max(400).optional(),
});

const memoryLineBody = z.object({ text: z.string().trim().min(3).max(300) });

/** Script calls a person can see: `crm.call("task.listMine", …)`. */
function operationsIn(source: string): string[] {
  return [...source.matchAll(/crm\.call\(\s*["'`]([a-zA-Z.]+)["'`]/g)].map((m) => m[1] as string);
}

const routineAccess: PluginItemKind["access"] = (body) => {
  const message = (body as { message?: { kind?: string } }).message;
  return { operations: message?.kind === "agent" ? ["agent.start"] : [] };
};

const scriptAccess: PluginItemKind["access"] = (body) => ({
  operations: operationsIn(String(body.source)),
});

const connectionAccess: PluginItemKind["access"] = (body) => ({
  connections: [String(body.service)],
});

const extensionAccess: PluginItemKind["access"] = (body) => ({
  // Any new version of code counts as new access, so it always waits for a person.
  schema: [`extension:${String(body.id)}@${String(body.version)}`],
});

export const PLUGIN_KINDS: readonly PluginItemKind[] = [
  { kind: "skill", label: "Skill", scopes: EVERYONE, body: skillBody },
  {
    kind: "savedCode",
    label: "Saved code",
    scopes: EVERYONE,
    body: scriptBody,
    access: scriptAccess,
  },
  { kind: "producer", label: "Chat card", scopes: EVERYONE, body: scriptBody, access: scriptAccess },
  {
    kind: "routine",
    label: "Routine",
    scopes: PEOPLE,
    body: routineDefinitionSchema,
    access: routineAccess,
  },
  {
    kind: "agentProfile",
    label: "Agent profile",
    scopes: EVERYONE,
    body: agentProfileBody,
    access: (body) => ({
      operations: (body as z.infer<typeof agentProfileBody>).defaultGrant.operations.slice(),
    }),
  },
  { kind: "assistantPreset", label: "Assistant preset", scopes: PEOPLE, body: presetBody },
  { kind: "assistantRule", label: "Assistant rules", scopes: EVERYONE, body: ruleTemplateBody },
  { kind: "dashboard", label: "Dashboard", scopes: PEOPLE, body: dashboardBody },
  { kind: "widget", label: "Widget", scopes: EVERYONE, body: widgetBody },
  { kind: "savedView", label: "View", scopes: EVERYONE, body: viewBody },
  { kind: "savedSearch", label: "Saved search", scopes: EVERYONE, body: savedSearchBody },
  { kind: "quickAction", label: "Quick action", scopes: EVERYONE, body: quickActionBody },
  { kind: "recordPanel", label: "Record panel", scopes: EVERYONE, body: recordPanelBody },
  { kind: "notificationPreset", label: "Notification preset", scopes: PEOPLE, body: notificationBody },
  {
    kind: "connectionNeed",
    label: "Connection",
    scopes: EVERYONE,
    body: connectionBody,
    access: connectionAccess,
  },
  { kind: "extension", label: "Extension", scopes: ORG, body: extensionBody, access: extensionAccess },
  {
    kind: "workspaceAutomation",
    label: "Workspace automation",
    scopes: ORG,
    body: extensionBody,
    access: extensionAccess,
  },
  {
    kind: "sharedConnection",
    label: "Shared connection",
    scopes: ORG,
    body: connectionBody,
    access: connectionAccess,
  },
  { kind: "teamMemory", label: "Team memory", scopes: ORG, body: memoryLineBody },
  { kind: "sharedDashboard", label: "Shared dashboard", scopes: ORG, body: dashboardBody },
  { kind: "workspaceSkill", label: "Workspace skill", scopes: ORG, body: skillBody },
];

export const pluginKinds = createKindRegistry(PLUGIN_KINDS);

/** What an item is looked up by, for the kinds that have a name. */
export function itemName(kind: string, body: Record<string, unknown>): string | null {
  switch (kind) {
    case "skill":
    case "workspaceSkill":
    case "savedCode":
    case "producer":
    case "agentProfile":
      return String(body.name);
    default:
      return null;
  }
}

export const EXTENSION_KINDS = ["extension", "workspaceAutomation"] as const;
export const NEED_KINDS = ["connectionNeed", "sharedConnection"] as const;
