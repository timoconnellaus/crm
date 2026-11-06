// plugin.* and marketplace.search (ADR 0347). Reads and proposals are open to the assistant; every
// change to what a person has (install, update, merge, stop, remove) is `actors: ["human"]`, so a
// model proposes and a person presses the button, as for extensions. Only the update cron acts on
// its own, and only for what a person already agreed to: an unchanged copy that asks for nothing new.
//
// These never queue for review (`bookkeeping`): plugins change no records, and a person does each
// of these on purpose. What reaches further (an extension in an org plugin) goes through
// extension.propose and waits in the approvals queue like any other.
import { type A2uiPart, a2uiPartSchema, prepareCard } from "@relationship-os/agent-a2ui";
import {
  canEdit,
  canInstall,
  compareItems,
  effectiveInstalls,
  type ItemCompare,
  manifestFingerprint,
  MERGE_INSTRUCTIONS,
  membersGetCopies,
  type MergeAnswer,
  mergeAnswerSchema,
  mergedItems,
  mergeQuestions,
  type PluginManifest,
  pluginIdSchema,
  pluginItemSchema,
  pluginListingSchema,
  pluginManifestSchema,
  pluginVersionSchema,
  planMerge,
  proposeMerge,
  accessWidening,
  widens,
} from "@relationship-os/agent-plugins";
import { z } from "zod";
import { CARD_STATUS } from "../assistant/events.ts";
import { assertRoutine, routineDefinitionSchema } from "../assistant/routines.ts";
import { duplicateOf, memoryRows, queueMemoryRefs, memoryRefs, customersNamedIn, idOrEmailIn } from "../assistant/memory.ts";
import { ConfigError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.ts";
import { requireHost } from "../extensions/install.ts";
import { newId } from "../ids.ts";
import { askPluginPreset, pluginPresetState } from "../judge/questions/plugin-preset.ts";
import { placementAvailable } from "../judge/types.ts";
import { judgeUsageStatement } from "../judge/usage.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { adapt, assertAdaptations, childrenOf, copyState, type CopyState, currentItems, holdersOf, moveTo, needStatus, normalise, proposeExtensions, queueInstallRow, queueNeedStates, queueNewCopy, queueRemoveCopy, sameItems, upstreamOf } from "../plugins/engine.ts";
import { FIRST_PARTY_PLUGINS } from "../plugins/first-party.ts";
import { EXTENSION_KINDS, itemName, pluginKinds, } from "../plugins/kinds.ts";
import { MATERIALISERS, targetsOf } from "../plugins/materialise.ts";
import { comingNames, installCard, previewPlugin } from "../plugins/preview.ts";
import { pluginSkill } from "../plugins/resolve.ts";
import { locate, localListings, MARKETPLACE_MODES, type MarketplaceMode, marketplaceMode, PLUGIN_MARKETPLACE_SETTING, PLUGIN_SOURCES } from "../plugins/sources.ts";
import { effectiveFor, type Install, installsFor, itemsForViewer, itemsOf, loadInstall, SKILL_KINDS, viewerOf } from "../plugins/store.ts";
import { loadGeneralSettings } from "../settings.ts";

const installId = z
  .string()
  .regex(/^pli_[0-9A-Za-z]{10,40}$/)
  .describe("An installed plugin's id (pli_…)");
const mergeId = z.string().regex(/^plm_[0-9A-Za-z]{10,40}$/);
const requestId = z.string().regex(/^plr_[0-9A-Za-z]{10,40}$/);
const sourceSchema = z.enum(PLUGIN_SOURCES);
const adaptationSchema = z.object({
  from: z.string().min(1).max(80),
  to: z.string().min(1).max(80),
});

const scopeSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("personal") }),
    z.object({
      kind: z.literal("team"),
      name: z.string().trim().min(1).max(80).describe("What the team is called"),
      members: z.array(z.string().min(1).max(64)).min(1).max(200),
      locked: z.boolean().default(false),
    }),
    z.object({
      kind: z.literal("role"),
      role: z.enum(["viewer", "member", "admin"]),
      locked: z.boolean().default(false),
    }),
    z.object({ kind: z.literal("org") }),
  ])
  .default({ kind: "personal" });

const compareSchema = z.object({
  key: z.string(),
  kind: z.string(),
  label: z.string(),
  status: z.string(),
  theirs: z.array(z.object({ kind: z.string(), text: z.string() })),
  yours: z.array(z.object({ kind: z.string(), text: z.string() })),
  merged: z.array(z.object({ kind: z.string(), text: z.string() })),
});

const wideningSchema = z.object({
  operations: z.array(z.string()),
  connections: z.array(z.string()),
  schema: z.array(z.string()),
});

const itemViewSchema = z.object({
  key: z.string(),
  kind: z.string(),
  kindLabel: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  state: z.string(),
  stateReason: z.string().nullable(),
  /** Shown and editable here (a skill's text); others are changed where they live. */
  editable: z.boolean(),
  body: z.record(z.string(), z.unknown()),
});

const installViewSchema = z.object({
  id: z.string(),
  plugin: z.string(),
  name: z.string(),
  publisher: z.string(),
  source: sourceSchema,
  version: z.string(),
  scope: z.enum(["personal", "team", "role", "org"]),
  scopeLabel: z.string(),
  locked: z.boolean(),
  following: z.boolean(),
  detachedAt: z.string().nullable(),
  changed: z.array(z.string()),
  canEdit: z.boolean(),
  /** Others' installs it is shadowing or a parent, for the admin list. */
  own: z.boolean(),
  update: z.object({
    plan: z.enum(["none", "detached", "auto", "approve", "compare"]),
    version: z.string().nullable(),
    widening: wideningSchema,
    whatsNew: z.array(z.string()),
  }),
  canGoBack: z.boolean(),
  waiting: z.array(z.string()),
  offered: z.array(z.string()),
  items: z.array(itemViewSchema),
});
type InstallView = z.infer<typeof installViewSchema>;

const previewSchema = z.object({
  adds: z.array(z.object({ kind: z.string(), label: z.string(), description: z.string().nullable() })),
  access: z.array(z.string()),
  needs: z.array(
    z.object({
      key: z.string(),
      service: z.string(),
      label: z.string(),
      level: z.string(),
      reason: z.string(),
      met: z.boolean(),
      swap: z.object({ service: z.string(), label: z.string() }).nullable(),
    }),
  ),
  routines: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      when: z.string(),
      gates: z.array(z.string()),
      fired: z.number().nullable(),
      days: z.number(),
      note: z.string().nullable(),
    }),
  ),
  checks: z.array(z.object({ text: z.string(), passed: z.boolean() })),
  risks: z.array(z.string()),
  swaps: z.array(z.object({ from: z.string(), to: z.string(), label: z.string() })),
  presets: z.array(z.string()),
});

const isAdmin = (ctx: HandlerContext) => ctx.user.role === "admin";
const viewer = (ctx: HandlerContext) => viewerOf(ctx.user);

function scopeLabel(install: Install): string {
  switch (install.scope) {
    case "personal":
      return "Your copy";
    case "team":
      return install.row.team_name ?? "A team";
    case "role":
      return `Everyone with the ${install.role} role`;
    case "org":
      return "Everyone";
  }
}

async function viewOf(ctx: HandlerContext, install: Install, state?: CopyState): Promise<InstallView> {
  const s = state ?? (await copyState(ctx, install));
  const items = await itemsOf(ctx.db, [install.id]);
  return {
    id: install.id,
    plugin: install.pluginId,
    name: install.row.name,
    publisher: install.row.publisher,
    source: install.row.source,
    version: install.row.version,
    scope: install.scope,
    scopeLabel: scopeLabel(install),
    locked: install.locked,
    following: install.row.following === 1,
    detachedAt: install.row.detached_at,
    changed: s.changed,
    canEdit: canEdit(install, viewer(ctx)),
    own: install.ownerUserId === ctx.user.id,
    update: {
      plan: s.plan,
      version: s.upstream && s.plan !== "none" ? s.upstream.version : null,
      widening: s.widening,
      whatsNew: s.plan === "none" ? [] : (s.upstream?.whatsNew ?? []),
    },
    canGoBack: install.row.previous_manifest !== null,
    waiting: items.filter((i) => i.state === "waiting").map((i) => i.stateReason ?? i.label),
    offered: items.filter((i) => i.state === "offered").map((i) => i.key),
    items: items.map((i) => ({
      key: i.key,
      kind: i.kind,
      kindLabel: pluginKinds.get(i.kind)?.label ?? i.kind,
      label: i.label,
      description: i.description ?? null,
      state: i.state,
      stateReason: i.stateReason,
      editable: !MATERIALISERS[i.kind] && canEdit(install, viewer(ctx)),
      body: (SKILL_KINDS as readonly string[]).includes(i.kind) ? i.body : {},
    })),
  };
}

async function requireInstall(ctx: HandlerContext, id: string): Promise<Install> {
  const install = await loadInstall(ctx.db, id);
  const mine = install
    ? effectiveInstalls([install], viewer(ctx)).length > 0 || isAdmin(ctx)
    : false;
  if (!install || !mine) throw new NotFoundError("plugin", id);
  return install;
}

async function requireEditable(ctx: HandlerContext, id: string): Promise<Install> {
  const install = await requireInstall(ctx, id);
  if (!canEdit(install, viewer(ctx))) {
    throw new ForbiddenError(
      install.locked
        ? `An admin locked ${install.row.name}. Make your own copy to change it.`
        : `Only an admin can change ${install.row.name}`,
    );
  }
  return install;
}

async function installedBy(ctx: HandlerContext) {
  return installsFor(ctx.db, viewer(ctx));
}

// ---------------------------------------------------------------------------------------------
// Reading

export const pluginList = defineOperation({
  name: "plugin.list",
  description:
    "Plugins: what you have installed and any update each has, what you can install (built-in " +
    "and your workspace's), and for admins everything installed for teams. Read-only. For the " +
    "marketplace use marketplace.search.",
  input: z.object({ query: z.string().trim().max(120).optional() }),
  output: z.object({
    installed: z.array(installViewSchema),
    available: z.array(
      pluginListingSchema.extend({
        source: sourceSchema,
        status: z.string().optional(),
        marketplaceStatus: z.string().nullable().optional(),
        installed: z.boolean(),
      }),
    ),
    workspace: z.array(
      z.object({
        plugin: z.string(),
        version: z.string(),
        name: z.string(),
        status: z.enum(["proposed", "published"]),
        marketplaceStatus: z.string().nullable(),
        marketplaceReason: z.string().nullable(),
      }),
    ),
    marketplace: z.enum(MARKETPLACE_MODES),
    marketplaceAvailable: z.boolean(),
    requests: z.array(
      z.object({
        id: z.string(),
        plugin: z.string(),
        name: z.string(),
        publisher: z.string(),
        version: z.string(),
        requestedBy: z.string(),
        requester: z.string(),
        status: z.string(),
      }),
    ),
  }),
  permission: "records:read",
  risk: "read",
  actors: ["human", "assistant"],
  mcp: { title: "List plugins", idempotent: true },
  async handler(input, ctx) {
    const v = viewer(ctx);
    const all = await installedBy(ctx);
    const effective = new Set(effectiveInstalls(all, v).map((i) => i.id));
    const shown = all.filter((i) => effective.has(i.id) || (isAdmin(ctx) && i.scope !== "personal"));
    const installed = await Promise.all(shown.map((i) => viewOf(ctx, i)));
    const have = new Set(installed.map((i) => i.plugin));
    const listings = await localListings(ctx.db, input.query);
    const registry = await ctx.db
      .selectFrom("core_plugin_registry")
      .select(["plugin_id", "version", "name", "status", "marketplace_status", "marketplace_reason"])
      .where("status", "=", "published")
      .orderBy("updated_at", "desc")
      .execute();
    const requests = await ctx.db
      .selectFrom("core_plugin_request as r")
      .innerJoin("core_user as u", "u.id", "r.requested_by")
      .select(["r.id", "r.plugin_id", "r.name", "r.publisher", "r.version", "r.requested_by", "r.status", "u.name as requester"])
      .where((eb) =>
        isAdmin(ctx)
          ? eb("r.status", "=", "pending")
          : eb.and([eb("r.requested_by", "=", ctx.user.id), eb("r.status", "<>", "declined")]),
      )
      .orderBy("r.created_at")
      .limit(100)
      .execute();
    return {
      installed,
      available: listings.map((l) => ({ ...l, installed: have.has(l.id) })),
      workspace: registry.map((r) => ({
        plugin: r.plugin_id,
        version: r.version,
        name: r.name,
        status: r.status,
        marketplaceStatus: r.marketplace_status,
        marketplaceReason: r.marketplace_reason,
      })),
      marketplace: await marketplaceMode(ctx.db),
      marketplaceAvailable: Boolean(ctx.marketplace),
      requests: requests.map((r) => ({
        id: r.id,
        plugin: r.plugin_id,
        name: r.name,
        publisher: r.publisher,
        version: r.version,
        requestedBy: r.requested_by,
        requester: r.requester,
        status: r.status,
      })),
    };
  },
});

export const pluginGet = defineOperation({
  name: "plugin.get",
  description:
    "One plugin before or after installing: what it adds, what it asks to reach, what is new, " +
    "and your copy if you have one. Give an id from plugin.list or marketplace.search. Read-only.",
  input: z.object({
    plugin: pluginIdSchema,
    source: sourceSchema.optional(),
    version: pluginVersionSchema.optional(),
  }),
  output: z.object({
    manifest: z.object({
      id: z.string(),
      name: z.string(),
      version: z.string(),
      publisher: z.string(),
      description: z.string(),
      whatsNew: z.array(z.string()),
      access: z.array(z.string()),
      connections: z.array(z.string()),
      items: z.array(
        z.object({ kind: z.string(), label: z.string(), description: z.string().nullable() }),
      ),
    }),
    source: sourceSchema,
    installed: installViewSchema.nullable(),
  }),
  permission: "records:read",
  risk: "read",
  actors: ["human", "assistant"],
  mcp: { title: "Show a plugin", idempotent: true },
  async handler(input, ctx) {
    const located = await locate(ctx, {
      id: input.plugin,
      version: input.version,
      source: input.source,
    });
    if (!located) throw new NotFoundError("plugin", input.plugin);
    const { manifest, source } = located;
    const access = pluginKinds.accessOf(manifest);
    const mine = (await effectiveFor(ctx.db, viewer(ctx))).find((i) => i.pluginId === input.plugin);
    return {
      manifest: {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        publisher: manifest.publisher,
        description: manifest.description,
        whatsNew: manifest.whatsNew,
        access: access.words,
        connections: access.connections,
        items: manifest.items.map((i) => ({
          kind: pluginKinds.get(i.kind)?.label ?? i.kind,
          label: i.label,
          description: i.description ?? null,
        })),
      },
      source,
      installed: mine ? await viewOf(ctx, mine) : null,
    };
  },
});

export const marketplaceSearch = defineOperation({
  name: "marketplace.search",
  description:
    "Search the hosted marketplace's reviewed plugins. Empty when an admin turned it off or this " +
    "deployment has none. Read-only.",
  input: z.object({ query: z.string().trim().max(120).optional() }),
  output: z.object({
    available: z.boolean(),
    listings: z.array(pluginListingSchema),
  }),
  permission: "records:read",
  risk: "read",
  actors: ["human", "assistant"],
  mcp: { title: "Search the plugin marketplace", idempotent: true },
  async handler(input, ctx) {
    const client = ctx.marketplace;
    if (!client || (await marketplaceMode(ctx.db)) === "off") {
      return { available: false, listings: [] };
    }
    try {
      const { listings } = await client.search({ query: input.query });
      return { available: true, listings };
    } catch {
      return { available: false, listings: [] };
    }
  },
});

export const pluginContributions = defineOperation({
  name: "plugin.contributions",
  description:
    "What your plugins add around the app: Cmd-K quick actions and saved searches, record panels " +
    "for one object, widgets to add to a dashboard, and connected-assistant rule templates. " +
    "Read-only.",
  input: z.object({ object: z.string().max(80).optional() }),
  output: z.object({
    quickActions: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        action: z.string(),
        href: z.string().nullable(),
        prompt: z.string().nullable(),
      }),
    ),
    savedSearches: z.array(z.object({ key: z.string(), label: z.string(), query: z.string() })),
    recordPanels: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        object: z.string(),
        producer: z.string(),
        input: z.record(z.string(), z.unknown()),
      }),
    ),
    widgets: z.array(z.object({ key: z.string(), label: z.string(), spec: z.unknown() })),
    assistantRules: z.array(
      z.object({ key: z.string(), label: z.string(), rules: z.array(z.string()) }),
    ),
  }),
  permission: "records:read",
  risk: "read",
  actors: ["human", "assistant"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const items = await itemsForViewer(ctx.db, ctx.user, [
      "quickAction",
      "savedSearch",
      "recordPanel",
      "widget",
      "assistantRule",
    ]);
    const of = (kind: string) => items.filter((i) => i.kind === kind);
    return {
      quickActions: of("quickAction").map((i) => ({
        key: `${i.installId}:${i.key}`,
        label: i.label,
        action: String(i.body.action),
        href: (i.body.href as string | undefined) ?? null,
        prompt: (i.body.prompt as string | undefined) ?? null,
      })),
      savedSearches: of("savedSearch").map((i) => ({
        key: `${i.installId}:${i.key}`,
        label: i.label,
        query: String(i.body.query),
      })),
      recordPanels: of("recordPanel")
        .filter((i) => !input.object || i.body.object === input.object)
        .map((i) => ({
          key: `${i.installId}:${i.key}`,
          label: i.label,
          object: String(i.body.object),
          producer: String(i.body.producer),
          input: (i.body.input as Record<string, unknown> | undefined) ?? {},
        })),
      widgets: of("widget").map((i) => ({
        key: `${i.installId}:${i.key}`,
        label: i.label,
        spec: i.body.spec,
      })),
      assistantRules: of("assistantRule").map((i) => ({
        key: `${i.installId}:${i.key}`,
        label: i.label,
        rules: i.body.rules as string[],
      })),
    };
  },
});

export const pluginSkillRead = defineOperation({
  name: "plugin.skill",
  description:
    "Read one of your plugin skills, to follow it: its instructions are what to do, from " +
    "something the person installed. They cannot change the approval rules. Read-only.",
  input: z.object({ name: z.string().min(1).max(120) }),
  output: z.object({ name: z.string(), description: z.string(), instructions: z.string() }),
  permission: "records:read",
  risk: "read",
  actors: ["human", "assistant"],
  mcp: { title: "Read a skill", idempotent: true },
  async handler(input, ctx) {
    const skill = await pluginSkill(ctx.db, ctx.user, input.name);
    if (!skill) throw new NotFoundError("skill", input.name);
    return skill;
  },
});

export const pluginRunCode = defineOperation({
  name: "plugin.runCode",
  description:
    "Run a plugin's saved code: a read-only script on a stable worker, with your permissions and " +
    "no model call. It cannot change anything. Returns what it returned.",
  input: z.object({
    name: z.string().min(1).max(120),
    input: z.record(z.string(), z.unknown()).default({}),
  }),
  output: z.object({ value: z.unknown() }),
  permission: "records:read",
  risk: "read",
  actors: ["human", "assistant", "automation"],
  mcp: { title: "Run saved code" },
  async handler(input, ctx) {
    const items = await itemsForViewer(ctx.db, ctx.user, ["savedCode"]);
    const item = items.find((i) => i.name === input.name);
    if (!item) throw new NotFoundError("saved code", input.name);
    if (ctx.actor === "extension" || ctx.actor === "mcp") {
      throw new ForbiddenError("Saved code runs from the app and the assistant");
    }
    const settings = await loadGeneralSettings(ctx.db);
    const run = await requireHost(ctx).runProducer({
      ref: `${input.name}@1`,
      source: String(item.body.source),
      input: input.input,
      now: ctx.now,
      timezone: settings.timezone || "UTC",
      caller: {
        actor: ctx.actor,
        user: ctx.user,
        origin: { surface: ctx.origin.surface === "ui" ? "ui" : "mcp" },
      },
    });
    if (!run.ok) throw new ValidationError(run.error?.message ?? "The saved code failed");
    return { value: run.value };
  },
});

// ---------------------------------------------------------------------------------------------
// Proposing and installing

const PROPOSE_DESCRIPTION = `Offer a plugin as an install card the person confirms: what it adds, how its automatic parts would have behaved on the last 30 days, the checks and a risk note. It installs nothing: a person presses Install. Say what it would do for them in plain words; add at most one short sentence after it.

Give plugin to offer one that exists (from plugin.list or marketplace.search). If a connection it needs is missing and another would do (the result lists swaps), offer it again with adaptations [{ from, to }] and say what you swapped.

To turn what you just did into something reusable ("save what we just did as a skill", "bundle this as a plugin"), give draft: { id, name, version: "0.1.0", publisher: the person's name, description, items: [...] } instead. A skill item: { kind: "skill", key, label, body: { name: "<word>.<word>", description, instructions } }. Write general instructions: no customer names, email addresses or record ids. Other kinds: routine (body as offer_standing_help's definition), producer, savedView, quickAction, assistantPreset, agentProfile.`;

const draftSchema = z
  .record(z.string(), z.unknown())
  .describe("A plugin.json, for a new skill or plugin");

function checked(manifest: PluginManifest, scope: Install["scope"]) {
  const issues = pluginKinds.check(manifest);
  if (issues.length) {
    throw new ValidationError(issues.map((i) => i.message).join("; "), { field: "items" });
  }
  const wrong = pluginKinds.outOfScope(manifest, scope);
  if (wrong.length) {
    throw new ValidationError(
      `${wrong.map((i) => i.label).join(", ")} cannot be installed at this scope`,
      { field: "scope" },
    );
  }
  return normalise(manifest);
}

/** The scope a plugin's items fit, for offering it: the narrowest that holds them all. */
function fittingScope(manifest: PluginManifest): Install["scope"] {
  return pluginKinds.outOfScope(manifest, "personal").length ? "org" : "personal";
}

export const pluginPropose = defineOperation({
  name: "plugin.propose",
  description: PROPOSE_DESCRIPTION,
  input: z
    .object({
      plugin: pluginIdSchema.optional(),
      source: sourceSchema.optional(),
      version: pluginVersionSchema.optional(),
      draft: draftSchema.optional(),
      adaptations: z.array(adaptationSchema).max(5).default([]),
      scope: scopeSchema,
    })
    .refine((v) => Boolean(v.plugin) !== Boolean(v.draft), "Give a plugin or a draft"),
  output: z.object({
    status: z.literal(CARD_STATUS),
    part: a2uiPartSchema,
    plugin: z.string(),
    version: z.string(),
    source: sourceSchema,
    fingerprint: z.string(),
    preview: previewSchema,
  }),
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human", "assistant"],
  mcp: { curated: true, title: "Offer a plugin", toolName: "offer_plugin" },
  async handler(input, ctx) {
    let manifest: PluginManifest;
    let source: "first_party" | "workspace" | "marketplace" = "workspace";
    if (input.draft) {
      const parsed = pluginManifestSchema.safeParse(input.draft);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new ValidationError(`${first?.path.join(".") || "draft"}: ${first?.message}`, {
          field: "draft",
        });
      }
      manifest = parsed.data;
      if (FIRST_PARTY_PLUGINS.some((p) => p.id === manifest.id)) {
        throw new ValidationError("That id belongs to a built-in plugin", { field: "draft.id" });
      }
    } else {
      const located = await locate(ctx, {
        id: input.plugin as string,
        version: input.version,
        source: input.source,
      });
      if (!located) throw new NotFoundError("plugin", input.plugin as string);
      manifest = located.manifest;
      source = located.source;
    }
    const scope = input.scope.kind === "personal" ? fittingScope(manifest) : input.scope.kind;
    const clean = checked(manifest, scope);
    assertAdaptations(clean, input.adaptations);
    const fingerprint = await manifestFingerprint(clean);
    const preview = await previewPlugin(ctx, clean, input.adaptations);
    if (input.draft) {
      const values = {
        name: clean.name,
        manifest: JSON.stringify(clean),
        fingerprint,
        updated_at: ctx.now,
      };
      ctx.write(
        ctx.db
          .insertInto("core_plugin_registry")
          .values({
            plugin_id: clean.id,
            version: clean.version,
            ...values,
            status: "proposed",
            marketplace_status: null,
            marketplace_id: null,
            marketplace_reason: null,
            created_by: ctx.user.id,
            created_at: ctx.now,
          })
          .onConflict((oc) =>
            oc
              .columns(["plugin_id", "version"])
              .doUpdateSet(values)
              .where("status", "=", "proposed"),
          ),
      );
    }
    const part = installCard(clean, preview, {
      plugin: clean.id,
      version: clean.version,
      source,
      fingerprint,
      adaptations: input.adaptations,
      ...(scope === "org" ? { scope: { kind: "org" } } : {}),
    });
    return {
      status: CARD_STATUS,
      part,
      plugin: clean.id,
      version: clean.version,
      source,
      fingerprint,
      preview,
    };
  },
});

const installResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("installed"), install: installViewSchema, copies: z.number() }),
  z.object({ status: z.literal("requested"), requestId: z.string(), message: z.string() }),
]);

async function marketplaceGate(
  ctx: HandlerContext,
  manifest: PluginManifest,
): Promise<z.infer<typeof installResult> | null> {
  const mode: MarketplaceMode = await marketplaceMode(ctx.db);
  if (mode === "off") throw new ForbiddenError("An admin turned the marketplace off");
  if (mode === "anyone" || isAdmin(ctx)) return null;
  const held = await ctx.db
    .selectFrom("core_plugin_request")
    .select(["id", "status"])
    .where("plugin_id", "=", manifest.id)
    .where("requested_by", "=", ctx.user.id)
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  if (held?.status === "approved") return null;
  if (held?.status === "pending") {
    return {
      status: "requested",
      requestId: held.id,
      message: "You've already asked. An admin will decide.",
    };
  }
  const id = newId("pluginRequest");
  ctx.write(
    ctx.db.insertInto("core_plugin_request").values({
      id,
      plugin_id: manifest.id,
      name: manifest.name,
      publisher: manifest.publisher,
      version: manifest.version,
      requested_by: ctx.user.id,
      decided_by: null,
      decided_at: null,
      created_at: ctx.now,
    }),
  );
  return { status: "requested", requestId: id, message: "An admin has to approve this first." };
}

export const pluginInstall = defineOperation({
  name: "plugin.install",
  description:
    "Install a plugin as a copy in its scope. People only: this is the install card's Install " +
    "button, and a model can never do it. Personal scope needs no admin; team, role and org do. " +
    "A plugin's routines go on now, unless a connection is missing, when they wait for it. " +
    "Pressing it twice installs once.",
  input: z.object({
    plugin: pluginIdSchema,
    version: pluginVersionSchema,
    source: sourceSchema,
    /** What the card showed: if the plugin changed since, this refuses it. */
    fingerprint: z.string().max(100),
    adaptations: z.array(adaptationSchema).max(5).default([]),
    scope: scopeSchema,
  }),
  output: installResult,
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const scope = input.scope;
    if (!canInstall(scope.kind, viewer(ctx))) {
      throw new ForbiddenError("Only an admin can install a plugin for other people");
    }
    const located = await locate(ctx, {
      id: input.plugin,
      version: input.version,
      source: input.source,
    });
    if (!located) throw new NotFoundError("plugin", input.plugin);
    const clean = checked(located.manifest, scope.kind);
    const fingerprint = await manifestFingerprint(clean);
    if (fingerprint !== input.fingerprint) {
      throw new ConflictError("This plugin changed since you were shown it. Look at it again.");
    }
    assertAdaptations(clean, input.adaptations);
    if (located.source === "marketplace") {
      const gated = await marketplaceGate(ctx, clean);
      if (gated) return gated;
    }

    const held = await installedBy(ctx);
    const same = held.find(
      (i) =>
        i.pluginId === clean.id &&
        i.scope === scope.kind &&
        (scope.kind !== "personal" || i.ownerUserId === ctx.user.id),
    );
    if (same) {
      return { status: "installed" as const, install: await viewOf(ctx, same), copies: 0 };
    }

    const manifest = adapt(clean, input.adaptations);
    // Validates what the routines refer to and that they can run, before anything is written.
    await previewChecks(ctx, manifest);
    const locked = (scope.kind === "team" || scope.kind === "role") && scope.locked;
    const copy = {
      manifest,
      fingerprint,
      source: located.source,
      adaptations: input.adaptations,
    };
    const id = await queueNewCopy(ctx, {
      ...copy,
      scope: scope.kind,
      ownerUserId: scope.kind === "personal" ? ctx.user.id : null,
      role: scope.kind === "role" ? scope.role : null,
      teamName: scope.kind === "team" ? scope.name : null,
      members: scope.kind === "team" ? scope.members : [],
      locked,
    });
    let copies = 0;
    if (membersGetCopies({ scope: scope.kind, locked })) {
      const members = await holdersOf(ctx.db, {
        scope: scope.kind,
        ownerUserId: null,
        role: scope.kind === "role" ? scope.role : null,
        members: scope.kind === "team" ? scope.members : [],
      });
      for (const member of members) {
        await queueNewCopy(ctx, {
          ...copy,
          scope: "personal",
          ownerUserId: member,
          locked: false,
          parentInstallId: id,
        });
        copies += 1;
      }
    }
    if (scope.kind === "org") await proposeExtensions(ctx, id, manifest.items);
    return ctx.afterCommit(async () => {
      const install = await loadInstall(ctx.db, id);
      return {
        status: "installed" as const,
        install: await viewOf(ctx, install as Install),
        copies,
      };
    });
  },
});

async function previewChecks(ctx: HandlerContext, manifest: PluginManifest) {
  const coming = comingNames(manifest.items);
  for (const item of manifest.items) {
    if (item.kind === "routine") {
      await assertRoutine(ctx, routineDefinitionSchema.parse(item.body), coming);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Updating

/** The quiet line in the chat, the same weight as "Saved to memory". */
function updatedLine(install: Install, version: string): A2uiPart {
  const text = `${install.row.name} updated to ${version} by itself, since you hadn't changed your copy.`;
  return prepareCard(
    {
      a2ui: 1,
      root: {
        type: "pluginUpdated",
        text,
        actions: [
          { kind: "open", label: "What's new", href: `/plugins/${install.pluginId}` },
          {
            kind: "operation",
            label: `Go back to ${install.row.version}`,
            operation: "plugin.update",
            input: { id: install.id, goBack: true },
            done: `Back on ${install.row.version}`,
          },
        ],
      },
    },
    { source: "host", text },
  );
}

async function goBack(ctx: HandlerContext, install: Install) {
  if (!install.row.previous_manifest) throw new ValidationError("There is no version to go back to");
  const previous = pluginManifestSchema.parse(JSON.parse(install.row.previous_manifest));
  const version = install.row.version;
  await moveTo(ctx, install, {
    manifest: previous,
    fingerprint: await manifestFingerprint(previous),
    items: previous.items,
  });
  ctx.write(
    ctx.db
      .updateTable("core_plugin_install")
      .set({ skipped_version: version, previous_manifest: null, updated_at: ctx.now })
      .where("id", "=", install.id),
  );
}

export const pluginUpdate = defineOperation({
  name: "plugin.update",
  description:
    "Move an unchanged copy to the newest version: the Update button, or the update check by " +
    "itself when the version asks for nothing new. New access always waits for a person, who " +
    "passes approveAccess. A changed copy needs plugin.mergeProposal instead. goBack returns to " +
    "the version before. People only.",
  input: z.object({
    id: installId,
    approveAccess: z.boolean().default(false),
    goBack: z.boolean().default(false),
  }),
  output: z.object({
    status: z.enum(["updated", "back", "none", "needs_approval", "needs_merge"]),
    version: z.string(),
  }),
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human", "automation"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const person = ctx.actor === "human";
    const install = person
      ? await requireEditable(ctx, input.id)
      : await loadInstall(ctx.db, input.id);
    if (!install) throw new NotFoundError("plugin", input.id);
    if (input.goBack) {
      if (!person) throw new ForbiddenError("Only a person can go back");
      await goBack(ctx, install);
      return { status: "back" as const, version: install.row.version };
    }
    const state = await copyState(ctx, install);
    const held = install.row.version;
    if (state.plan === "none" || state.plan === "detached" || !state.upstream) {
      return { status: "none" as const, version: held };
    }
    if (state.plan === "compare") return { status: "needs_merge" as const, version: held };
    // Only a person, who has seen what it asks for, can agree to more.
    if (state.plan === "approve" && !(person && input.approveAccess)) {
      return { status: "needs_approval" as const, version: held };
    }
    const manifest = state.upstream;
    await moveTo(ctx, install, {
      manifest,
      fingerprint: state.upstreamFingerprint as string,
      items: manifest.items,
    });
    if (install.scope === "org" && !sameExtensions(install.manifest, manifest)) {
      await proposeExtensions(ctx, install.id, manifest.items);
    }
    const owner = install.ownerUserId;
    return ctx.afterCommit(async () => {
      if (!person && owner && ctx.assistantThreads) {
        await ctx.assistantThreads
          .postCard(owner, updatedLine(install, manifest.version))
          .catch(() => undefined);
      }
      return { status: "updated" as const, version: manifest.version };
    });
  },
});

function sameExtensions(a: PluginManifest, b: PluginManifest) {
  const of = (m: PluginManifest) =>
    m.items.filter((i) => (EXTENSION_KINDS as readonly string[]).includes(i.kind));
  return sameItems(of(a), of(b));
}

async function comparing(ctx: HandlerContext, install: Install) {
  const upstream = await upstreamOf(ctx, install);
  if (!upstream) throw new NotFoundError("newer version of", install.row.name);
  const mine = await currentItems(ctx.db, install);
  return { upstream, mine, base: install.manifest.items };
}

const compareOutput = z.object({
  name: z.string(),
  from: z.string(),
  to: z.string(),
  changed: z.array(z.string()),
  widening: wideningSchema,
  items: z.array(compareSchema),
});

export const pluginCompare = defineOperation({
  name: "plugin.compare",
  description:
    "Compare your copy with the newest version: their changes, your edits and what a merge would " +
    "leave, item by item. Read-only.",
  input: z.object({ id: installId }),
  output: compareOutput,
  permission: "records:read",
  risk: "read",
  actors: ["human", "assistant"],
  mcp: { title: "Compare with the new version", idempotent: true },
  async handler(input, ctx) {
    const install = await requireInstall(ctx, input.id);
    const { upstream, mine, base } = await comparing(ctx, install);
    const state = await copyState(ctx, install);
    return {
      name: install.row.name,
      from: install.row.version,
      to: upstream.manifest.version,
      changed: state.changed,
      widening: accessWidening(
        pluginKinds.accessOf(install.manifest),
        pluginKinds.accessOf(upstream.manifest),
      ),
      items: compareItems(planMerge(base, mine, upstream.manifest.items)),
    };
  },
});

function parseAnswer(text: string): MergeAnswer | null {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!json) return null;
  try {
    const parsed = mergeAnswerSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function changeLines(lines: readonly { kind: string; text: string }[]): string[] {
  return lines
    .filter((l) => l.kind !== "same")
    .slice(0, 10)
    .map((l) => `${l.kind === "add" ? "+" : "-"} ${l.text}`.slice(0, 300));
}

function mergeCard(input: {
  install: Install;
  version: string;
  mergeId: string;
  compare: readonly ItemCompare[];
  widening: boolean;
}): A2uiPart {
  const { install, version, compare } = input;
  const merged = compare
    .flatMap((c) => c.merged)
    .slice(0, 60)
    .map((l) => ({ kind: l.kind as "add" | "remove" | "same", text: l.text.slice(0, 300) }));
  const name = `${install.row.name} ${version}`.slice(0, 120);
  return prepareCard(
    {
      a2ui: 1,
      root: {
        type: "pluginUpdate",
        name,
        note: "You've changed your copy, so I've combined their changes with yours. Please check it.",
        upstream: compare.flatMap((c) => changeLines(c.theirs)).slice(0, 10),
        yours: compare.flatMap((c) => changeLines(c.yours)).slice(0, 10),
        merged,
        actions: [
          {
            kind: "operation",
            label: "Apply",
            style: "primary",
            operation: "plugin.applyMerge",
            input: { id: install.id, merge: input.mergeId, action: "apply", approveAccess: input.widening },
            done: `Updated to ${version}. Your edits are kept.`,
          },
          {
            kind: "operation",
            label: "Keep mine",
            style: "secondary",
            operation: "plugin.applyMerge",
            input: { id: install.id, merge: input.mergeId, action: "keep" },
            done: "Kept your copy as it is.",
          },
          {
            kind: "open",
            label: "Review",
            style: "ghost",
            href: `/plugins/compare/${install.id}`,
          },
        ],
      },
    },
    { source: "host", text: `${install.row.name} ${version} is out, and you've changed your copy.` },
  );
}

const storedProposal = z.object({
  manifest: pluginManifestSchema,
  fingerprint: z.string(),
  items: z.array(pluginItemSchema),
  resolved: z.array(
    z.object({ id: z.string(), source: z.string(), why: z.string().optional() }),
  ),
});

export const pluginMergeProposal = defineOperation({
  name: "plugin.mergeProposal",
  description:
    "Combine a new version with a changed copy and show it as a card with Apply, Keep mine and " +
    "Review. Everything that merges by rule does; a model is asked only about the places both " +
    "sides changed, and where it cannot help your side is kept. Nothing changes until a person " +
    "presses Apply.",
  input: z.object({ id: installId }),
  output: z.object({
    status: z.literal(CARD_STATUS),
    part: a2uiPartSchema,
    merge: z.string(),
    version: z.string(),
    conflicts: z.number(),
    resolved: z.array(z.object({ id: z.string(), source: z.string(), why: z.string().optional() })),
    items: z.array(compareSchema),
    merged: z.array(pluginItemSchema),
    widening: wideningSchema,
  }),
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human", "assistant"],
  mcp: { title: "Combine an update with your edits" },
  async handler(input, ctx) {
    const install = await requireEditable(ctx, input.id);
    const { upstream, mine, base } = await comparing(ctx, install);
    const theirs = upstream.manifest.items;
    const questions = mergeQuestions(planMerge(base, mine, theirs));
    let answer: MergeAnswer | null = null;
    if (questions.length && ctx.models) {
      try {
        const reply = await ctx.models.run("extract", [
          { role: "system", content: MERGE_INSTRUCTIONS },
          { role: "user", content: JSON.stringify({ conflicts: questions }) },
        ]);
        answer = parseAnswer(reply.text);
      } catch {
        answer = null;
      }
    }
    const proposal = proposeMerge(base, mine, theirs, answer);
    const items = mergedItems(proposal.plan);
    const compare = compareItems(proposal.plan);
    const id = newId("pluginMerge");
    ctx.write(
      ctx.db
        .updateTable("core_plugin_merge")
        .set({ status: "kept", decided_at: ctx.now })
        .where("install_id", "=", install.id)
        .where("status", "=", "proposed"),
      ctx.db.insertInto("core_plugin_merge").values({
        id,
        install_id: install.id,
        version: upstream.manifest.version,
        proposal: JSON.stringify({
          manifest: upstream.manifest,
          fingerprint: upstream.fingerprint,
          items,
          resolved: proposal.resolved,
        }),
        created_by: ctx.user.id,
        created_at: ctx.now,
        decided_at: null,
      }),
    );
    const widening = accessWidening(
      pluginKinds.accessOf(install.manifest),
      pluginKinds.accessOf({ items, access: upstream.manifest.access }),
    );
    return {
      status: CARD_STATUS,
      part: mergeCard({
        install,
        version: upstream.manifest.version,
        mergeId: id,
        compare,
        widening: widens(widening),
      }),
      merge: id,
      version: upstream.manifest.version,
      conflicts: questions.length,
      resolved: proposal.resolved,
      items: compare,
      merged: items,
      widening,
    };
  },
});

export const pluginApplyMerge = defineOperation({
  name: "plugin.applyMerge",
  description:
    "Settle a merge proposal: apply it, take theirs, or keep your copy and skip that version. " +
    "items replaces the merged items with what the person edited on the compare page. People " +
    "only: these are the card's buttons.",
  input: z.object({
    id: installId,
    merge: mergeId,
    action: z.enum(["apply", "theirs", "keep"]),
    items: z.array(pluginItemSchema).max(100).optional(),
    approveAccess: z.boolean().default(false),
  }),
  output: z.object({ status: z.enum(["applied", "kept"]), version: z.string() }),
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const install = await requireEditable(ctx, input.id);
    const row = await ctx.db
      .selectFrom("core_plugin_merge")
      .selectAll()
      .where("id", "=", input.merge)
      .where("install_id", "=", install.id)
      .executeTakeFirst();
    if (!row) throw new NotFoundError("merge proposal", input.merge);
    if (row.status !== "proposed") {
      throw new ConflictError("This proposal was already settled");
    }
    const proposal = storedProposal.parse(JSON.parse(row.proposal));
    const settle = (status: "applied" | "kept") =>
      ctx.write(
        ctx.db
          .updateTable("core_plugin_merge")
          .set({ status, decided_at: ctx.now })
          .where("id", "=", row.id),
      );
    if (input.action === "keep") {
      settle("kept");
      ctx.write(
        ctx.db
          .updateTable("core_plugin_install")
          .set({ skipped_version: row.version, updated_at: ctx.now })
          .where("id", "=", install.id),
      );
      return { status: "kept" as const, version: install.row.version };
    }
    const items =
      input.action === "theirs" ? proposal.manifest.items : (input.items ?? proposal.items);
    const issues = pluginKinds.check({ items });
    if (issues.length) {
      throw new ValidationError(issues.map((i) => i.message).join("; "), { field: "items" });
    }
    const clean = items.map((i) => pluginKinds.normalise(i));
    const widening = accessWidening(
      pluginKinds.accessOf(install.manifest),
      pluginKinds.accessOf({ items: clean, access: proposal.manifest.access }),
    );
    if (widens(widening) && !input.approveAccess) {
      throw new ValidationError("This version asks for more access. Approve it to apply.");
    }
    await previewChecks(ctx, { ...proposal.manifest, items: clean });
    await moveTo(ctx, install, {
      manifest: proposal.manifest,
      fingerprint: proposal.fingerprint,
      items: clean,
    });
    settle("applied");
    return { status: "applied" as const, version: proposal.manifest.version };
  },
});

export const pluginEditItem = defineOperation({
  name: "plugin.editItem",
  description:
    "Change an item of your copy that lives with the plugin, such as a skill's text. Routines, " +
    "views and dashboards are changed where they live, and the copy notices. People only.",
  input: z.object({
    id: installId,
    key: z.string().min(1).max(80),
    label: z.string().trim().min(1).max(120).optional(),
    body: z.record(z.string(), z.unknown()),
  }),
  output: z.object({ ok: z.literal(true) }),
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const install = await requireEditable(ctx, input.id);
    const item = (await itemsOf(ctx.db, [install.id])).find((i) => i.key === input.key);
    if (!item) throw new NotFoundError("plugin item", input.key);
    if (MATERIALISERS[item.kind] && !install.locked) {
      throw new ValidationError(`Change ${item.label} where it lives`);
    }
    const next = { ...item, label: input.label ?? item.label, body: input.body };
    const issues = pluginKinds.check({ items: [next] });
    if (issues.length) {
      throw new ValidationError(issues.map((i) => i.message).join("; "), { field: "body" });
    }
    const clean = pluginKinds.normalise(next);
    ctx.write(
      ctx.db
        .updateTable("core_plugin_item")
        .set({
          label: clean.label,
          name: itemName(clean.kind, clean.body),
          body: JSON.stringify(clean.body),
        })
        .where("install_id", "=", install.id)
        .where("key", "=", item.key),
    );
    if (MATERIALISERS[item.kind]) {
      for (const target of (await targetsOf(ctx.db, install.id)).filter(
        (t) => t.item_key === item.key,
      )) {
        await MATERIALISERS[item.kind]?.update(ctx, clean, target);
      }
    }
    return { ok: true as const };
  },
});

/** Member's own copy of a locked plugin: what they had moves to a detached personal copy. */
async function makeOwnCopy(ctx: HandlerContext, install: Install): Promise<string> {
  const items = await itemsOf(ctx.db, [install.id]);
  const id = queueInstallRow(ctx, {
    manifest: install.manifest,
    fingerprint: install.row.fingerprint,
    source: install.row.source,
    scope: "personal",
    ownerUserId: ctx.user.id,
    locked: false,
    parentInstallId: install.id,
    adaptations: install.adaptations,
    following: false,
  });
  for (const item of items) {
    ctx.write(
      ctx.db.insertInto("core_plugin_item").values({
        install_id: id,
        key: item.key,
        kind: item.kind,
        name: item.name,
        label: item.label,
        description: item.description ?? null,
        body: JSON.stringify(item.body),
        state: item.state,
        state_reason: item.stateReason,
      }),
    );
  }
  ctx.write(
    ctx.db
      .updateTable("core_plugin_target")
      .set({ install_id: id })
      .where("install_id", "=", install.id)
      .where("holder_user_id", "=", ctx.user.id),
  );
  return id;
}

export const pluginDetach = defineOperation({
  name: "plugin.detach",
  description:
    "Stop updates: your copy stays as it is and you hear no more about new versions. On a " +
    "locked plugin, ownCopy makes you your own editable copy, detached from the team's. People " +
    "only.",
  input: z.object({ id: installId, ownCopy: z.boolean().default(false) }),
  output: z.object({ id: z.string(), following: z.literal(false) }),
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    if (input.ownCopy) {
      const install = await requireInstall(ctx, input.id);
      if (install.scope === "personal") {
        throw new ValidationError("This is already your own copy");
      }
      const held = await effectiveFor(ctx.db, viewer(ctx));
      if (!held.some((i) => i.id === install.id)) {
        throw new ValidationError("This plugin is not installed for you");
      }
      return { id: await makeOwnCopy(ctx, install), following: false as const };
    }
    const install = await requireEditable(ctx, input.id);
    ctx.write(
      ctx.db
        .updateTable("core_plugin_install")
        .set({ following: 0, detached_at: ctx.now, updated_at: ctx.now })
        .where("id", "=", install.id),
    );
    return { id: install.id, following: false as const };
  },
});

export const pluginReattach = defineOperation({
  name: "plugin.reattach",
  description:
    "Resume updates, after a compare: give the version you compared with. If your copy differs " +
    "from it, the update waits for a merge. People only.",
  input: z.object({ id: installId, compared: pluginVersionSchema }),
  output: z.object({ id: z.string(), following: z.literal(true) }),
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const install = await requireEditable(ctx, input.id);
    const upstream = await upstreamOf(ctx, install);
    if (!upstream) throw new NotFoundError("source of", install.row.name);
    if (upstream.manifest.version !== input.compared) {
      throw new ConflictError(
        `A newer version came out (${upstream.manifest.version}). Compare again first.`,
      );
    }
    ctx.write(
      ctx.db
        .updateTable("core_plugin_install")
        .set({ following: 1, detached_at: null, skipped_version: null, updated_at: ctx.now })
        .where("id", "=", install.id),
    );
    return { id: install.id, following: true as const };
  },
});

export const pluginUninstall = defineOperation({
  name: "plugin.uninstall",
  description:
    "Remove a copy and what it made: its routines, views, dashboards and skills. Extensions it " +
    "installed stay until an admin removes them, because they hold data. Members' copies of a " +
    "team install stay if they changed them. People only.",
  input: z.object({ id: installId }),
  output: z.object({ removed: z.literal(true), kept: z.number() }),
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const install = await requireEditable(ctx, input.id);
    let kept = 0;
    for (const id of await childrenOf(ctx.db, install.id)) {
      const child = await loadInstall(ctx.db, id);
      if (!child) continue;
      if (sameItems(await currentItems(ctx.db, child), child.manifest.items)) {
        await queueRemoveCopy(ctx, child);
      } else {
        kept += 1;
        ctx.write(
          ctx.db
            .updateTable("core_plugin_install")
            .set({ parent_install_id: null, updated_at: ctx.now })
            .where("id", "=", id),
        );
      }
    }
    await queueRemoveCopy(ctx, install);
    return { removed: true as const, kept };
  },
});

export const pluginCheckNeeds = defineOperation({
  name: "plugin.checkNeeds",
  description:
    "Look again at what a copy is waiting for: a connection now signed in, an extension now " +
    "approved. Starts its routines if nothing is missing. Called by Check again and by the " +
    "update check.",
  input: z.object({ id: installId }),
  output: z.object({ waiting: z.array(z.string()) }),
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human", "automation"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const install =
      ctx.actor === "human"
        ? await requireInstall(ctx, input.id)
        : await loadInstall(ctx.db, input.id);
    if (!install) throw new NotFoundError("plugin", input.id);
    const items = await itemsOf(ctx.db, [install.id]);
    const needs = await needStatus(ctx.db, items, install.ownerUserId);
    queueNeedStates(ctx, install.id, needs);
    const waiting = needs.filter((n) => !n.met).map((n) => n.label);
    for (const item of items) {
      if (!(EXTENSION_KINDS as readonly string[]).includes(item.kind)) continue;
      const { id, version } = item.body as { id: string; version: string };
      const live = await ctx.db
        .selectFrom("core_extensions")
        .select("version")
        .where("id", "=", id)
        .where("status", "=", "active")
        .executeTakeFirst();
      if (live?.version === version) {
        ctx.write(
          ctx.db
            .updateTable("core_plugin_item")
            .set({ state: "active", state_reason: null })
            .where("install_id", "=", install.id)
            .where("key", "=", item.key),
        );
      } else {
        waiting.push(item.label);
      }
    }
    if (!needs.some((n) => !n.met)) {
      const routines = (await targetsOf(ctx.db, install.id)).filter(
        (t) => t.target_kind === "routine",
      );
      for (const target of routines) {
        ctx.write(
          ctx.db
            .updateTable("core_automations")
            .set({ paused_reason: null, paused_at: null, updated_at: ctx.now })
            .where("key", "=", target.target_id)
            .where("paused_reason", "like", "Waiting for %"),
        );
      }
    }
    return { waiting };
  },
});

export const pluginAcceptPreset = defineOperation({
  name: "plugin.acceptPreset",
  description:
    "Save a plugin's starter lines to what your assistant remembers, after you read them. Each " +
    "line is checked first, and any that is not a harmless preference is left out. People only.",
  input: z.object({ id: installId, key: z.string().min(1).max(80) }),
  output: z.object({
    saved: z.array(z.string()),
    refused: z.array(z.object({ line: z.string(), reason: z.string() })),
  }),
  permission: "records:read",
  risk: "write",
  bookkeeping: true,
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const install = await requireInstall(ctx, input.id);
    const item = (await itemsOf(ctx.db, [install.id])).find(
      (i) => i.key === input.key && i.kind === "assistantPreset",
    );
    if (!item) throw new NotFoundError("preset", input.key);
    const { personal } = await memoryRows(ctx.db, ctx.user.id);
    const held = personal.map((l) => ({ id: l.id, text: l.text }));
    const lines = [
      ...((item.body.shortcuts as string[]) ?? []).map((line) => ({ line, kind: "shortcut" as const })),
      ...((item.body.style as string[]) ?? []).map((line) => ({ line, kind: "style" as const })),
    ];
    const useJudge = await placementAvailable(ctx.judge, "plugin.preset");
    const saved: string[] = [];
    const refused: { line: string; reason: string }[] = [];
    let spend = { calls: 0, inputTokens: 0 };
    for (const { line, kind } of lines) {
      // The deterministic checks hold with or without the judge.
      if (idOrEmailIn(line) || (await customersNamedIn(ctx.db, line, ctx.user.name)).names.length) {
        refused.push({ line, reason: "It names a customer or a record" });
        continue;
      }
      if (duplicateOf(line, held)) {
        refused.push({ line, reason: "Your assistant already remembers this" });
        continue;
      }
      if (useJudge && ctx.judge) {
        const asked = await askPluginPreset(ctx.judge, pluginPresetState({ line, kind }));
        if (asked.status === "answered") {
          spend = { calls: spend.calls + 1, inputTokens: spend.inputTokens + asked.inputTokens };
          if (!asked.passed) {
            refused.push({ line, reason: "It tells your assistant to do something" });
            continue;
          }
        }
      }
      const id = newId("memory");
      ctx.write(
        ctx.db.insertInto("core_memory").values({
          id,
          user_id: ctx.user.id,
          kind,
          text: line,
          condition: null,
          condition_label: null,
          status: "active",
          source_thread_id: null,
          source_message_seq: null,
          checked: JSON.stringify({ by: useJudge ? "plugin.preset" : "read_back", plugin: install.pluginId }),
          author_id: ctx.user.id,
          history: null,
          active_since: ctx.now,
          created_at: ctx.now,
          updated_at: ctx.now,
        }),
        ctx.db.insertInto("core_plugin_target").values({
          install_id: install.id,
          item_key: item.key,
          holder_user_id: ctx.user.id,
          target_kind: "memory",
          target_id: id,
          restore: null,
        }),
      );
      queueMemoryRefs(ctx, id, await memoryRefs(ctx.db, line, null, ctx.user.name));
      saved.push(line);
    }
    if (spend.calls) ctx.write(judgeUsageStatement(ctx.db, "plugin.preset", spend, ctx.now));
    ctx.write(
      ctx.db
        .updateTable("core_plugin_item")
        .set({ state: "active", state_reason: null })
        .where("install_id", "=", install.id)
        .where("key", "=", item.key),
    );
    return { saved, refused };
  },
});

// ---------------------------------------------------------------------------------------------
// Publishing and settings

const PRIVATE = /[^\s@]+@[^\s@]+\.[^\s@]+|\b(per|org|tsk|act|rec|usr)_[0-9A-Z]{10,}\b/;

export const pluginPublish = defineOperation({
  name: "plugin.publish",
  description:
    "Publish a plugin: to your workspace's private registry, or submit it to the marketplace, " +
    "where it is reviewed before anyone sees it. What goes to the marketplace leaves this " +
    "workspace and an erase cannot reach it, so text with an email address or a record id is " +
    "refused. Admins, people only.",
  input: z
    .object({
      to: z.enum(["workspace", "marketplace"]),
      manifest: draftSchema.optional().describe("A plugin.json, to publish to the workspace"),
      plugin: pluginIdSchema.optional().describe("One already in the workspace registry"),
      version: pluginVersionSchema.optional(),
      note: z.string().trim().max(1_000).optional(),
    })
    .refine((v) => Boolean(v.manifest) !== Boolean(v.plugin), "Give a manifest or a plugin"),
  output: z.object({
    plugin: z.string(),
    version: z.string(),
    status: z.enum(["published", "in_review", "approved", "rejected"]),
  }),
  permission: "extensions:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    let manifest: PluginManifest;
    if (input.manifest) {
      manifest = pluginManifestSchema.parse(input.manifest);
    } else {
      const row = await ctx.db
        .selectFrom("core_plugin_registry")
        .select("manifest")
        .where("plugin_id", "=", input.plugin as string)
        .$if(Boolean(input.version), (q) => q.where("version", "=", input.version as string))
        .orderBy("created_at", "desc")
        .executeTakeFirst();
      if (!row) throw new NotFoundError("plugin", input.plugin as string);
      manifest = pluginManifestSchema.parse(JSON.parse(row.manifest));
    }
    const issues = pluginKinds.check(manifest);
    if (issues.length) {
      throw new ValidationError(issues.map((i) => i.message).join("; "), { field: "manifest" });
    }
    if (FIRST_PARTY_PLUGINS.some((p) => p.id === manifest.id)) {
      throw new ValidationError("That id belongs to a built-in plugin");
    }
    const clean = normalise(manifest);
    const fingerprint = await manifestFingerprint(clean);
    const values = {
      name: clean.name,
      manifest: JSON.stringify(clean),
      fingerprint,
      status: "published" as const,
      updated_at: ctx.now,
    };
    ctx.write(
      ctx.db
        .insertInto("core_plugin_registry")
        .values({
          plugin_id: clean.id,
          version: clean.version,
          ...values,
          marketplace_status: null,
          marketplace_id: null,
          marketplace_reason: null,
          created_by: ctx.user.id,
          created_at: ctx.now,
        })
        .onConflict((oc) => oc.columns(["plugin_id", "version"]).doUpdateSet(values)),
    );
    if (input.to === "workspace") {
      return { plugin: clean.id, version: clean.version, status: "published" as const };
    }
    if (!ctx.marketplace) throw new ConfigError("This deployment has no marketplace");
    if (PRIVATE.test(JSON.stringify(clean))) {
      throw new ValidationError(
        "It has an email address or a record id in it. Take those out before it leaves this workspace.",
      );
    }
    const result = await ctx.marketplace.submit({
      manifest: clean,
      ...(input.note ? { note: input.note } : {}),
    });
    ctx.write(
      ctx.db
        .updateTable("core_plugin_registry")
        .set({
          marketplace_status: result.status,
          marketplace_id: result.id,
          marketplace_reason: result.reason,
          updated_at: ctx.now,
        })
        .where("plugin_id", "=", clean.id)
        .where("version", "=", clean.version),
    );
    return { plugin: clean.id, version: clean.version, status: result.status };
  },
});

export const pluginDecideRequest = defineOperation({
  name: "plugin.decideRequest",
  description:
    "Approve or decline a member's request for a marketplace plugin. An approved member can then " +
    "install it. Admins, people only.",
  input: z.object({ id: requestId, approve: z.boolean() }),
  output: z.object({ status: z.enum(["approved", "declined"]) }),
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const row = await ctx.db
      .selectFrom("core_plugin_request")
      .select("status")
      .where("id", "=", input.id)
      .executeTakeFirst();
    if (!row) throw new NotFoundError("plugin request", input.id);
    if (row.status !== "pending") throw new ConflictError("This request was already decided");
    const status = input.approve ? ("approved" as const) : ("declined" as const);
    ctx.write(
      ctx.db
        .updateTable("core_plugin_request")
        .set({ status, decided_by: ctx.user.id, decided_at: ctx.now })
        .where("id", "=", input.id),
    );
    return { status };
  },
});

export const pluginUpdateSettings = defineOperation({
  name: "plugin.updateSettings",
  description:
    "Who may install from the marketplace: anyone, members ask an admin first, or off (only " +
    "built-in and workspace plugins). Admins, people only: it can loosen what members may do.",
  input: z.object({ marketplace: z.enum(MARKETPLACE_MODES) }),
  output: z.object({ marketplace: z.enum(MARKETPLACE_MODES) }),
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const value = JSON.stringify(input.marketplace);
    ctx.write(
      ctx.db
        .insertInto("core_settings")
        .values({ key: PLUGIN_MARKETPLACE_SETTING, value, updated_at: ctx.now })
        .onConflict((oc) => oc.column("key").doUpdateSet({ value, updated_at: ctx.now })),
    );
    return input;
  },
});

export const pluginOperations = [
  pluginList,
  pluginGet,
  marketplaceSearch,
  pluginContributions,
  pluginSkillRead,
  pluginRunCode,
  pluginPropose,
  pluginInstall,
  pluginUpdate,
  pluginCompare,
  pluginMergeProposal,
  pluginApplyMerge,
  pluginEditItem,
  pluginDetach,
  pluginReattach,
  pluginUninstall,
  pluginCheckNeeds,
  pluginAcceptPreset,
  pluginPublish,
  pluginDecideRequest,
  pluginUpdateSettings,
] as const;
