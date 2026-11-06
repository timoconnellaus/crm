// Installing and updating copies (ADR 0347). Everything here runs inside an operation: reads now,
// writes queued for its batch, so an install or update lands whole or not at all.
//
//   source version ──normalise──► adapt ──► base (the install's manifest)
//                                             └─► items and what they became (the copy)
//
// A copy is "unchanged" while its items still equal the base. The comparison reads what each item
// became (a routine's definition, a view's spec), so editing a routine in My routines changes the
// copy just as editing a skill does.
import {
  accessWidening,
  type AccessWidening,
  canonicalJson,
  compareVersions,
  manifestFingerprint,
  membersGetCopies,
  type PluginItem,
  type PluginManifest,
  planUpdate,
  type UpdatePlan,
} from "@relationship-os/agent-plugins";
import type { CoreDatabase } from "@relationship-os/db";
import type { Kysely } from "kysely";
import { ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import type { HandlerContext } from "../operation.ts";
import {
  type ConnectionNeedBody,
  EXTENSION_KINDS,
  itemName,
  NEED_KINDS,
  pluginKinds,
} from "./kinds.ts";
import {
  createTarget,
  MATERIALISERS,
  removeTarget,
  type Target,
  targetsOf,
} from "./materialise.ts";
import { locate, type PluginSource } from "./sources.ts";
import { type Adaptation, type Install, itemsOf, type StoredItem } from "./store.ts";

type Db = Kysely<CoreDatabase>;

// ---------------------------------------------------------------------------------------------
// Preparing a version

/** Bodies parsed, so defaults apply and later compares see like with like. */
export function normalise(manifest: PluginManifest): PluginManifest {
  return { ...manifest, items: manifest.items.map((item) => pluginKinds.normalise(item)) };
}

const isCapitalised = (text: string) => /^\p{Lu}/u.test(text);

function swapWords(text: string, from: string, to: string): string {
  const word = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, "giu"), (hit) =>
    isCapitalised(hit) ? to.charAt(0).toUpperCase() + to.slice(1) : to,
  );
}

function swapDeep<T>(value: T, swap: Adaptation): T {
  if (typeof value === "string") return swapWords(value, swap.from, swap.to) as T;
  if (Array.isArray(value)) return value.map((v) => swapDeep(v, swap)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, swapDeep(v, swap)]),
    ) as T;
  }
  return value;
}

/**
 * The swaps a plugin allows: a connection need's alternatives. The assistant may only pick one of
 * these, so adapting can never add something the plugin did not offer.
 */
export function assertAdaptations(manifest: PluginManifest, swaps: readonly Adaptation[]) {
  for (const swap of swaps) {
    const allowed = manifest.items.some((item) => {
      if (!(NEED_KINDS as readonly string[]).includes(item.kind)) return false;
      const need = item.body as ConnectionNeedBody;
      return (
        need.service === swap.from && need.alternatives.some((a) => a.service === swap.to)
      );
    });
    if (!allowed) {
      throw new ValidationError(`This plugin cannot use ${swap.to} in place of ${swap.from}`, {
        field: "adaptations",
      });
    }
  }
}

/** The copy's version of a manifest: each swap applied, the needs pointing at the new service. */
export function adapt(manifest: PluginManifest, swaps: readonly Adaptation[]): PluginManifest {
  let out = manifest;
  for (const swap of swaps) {
    const items = out.items.map((item) => {
      if (!(NEED_KINDS as readonly string[]).includes(item.kind)) return swapDeep(item, swap);
      const need = item.body as ConnectionNeedBody;
      const alternative = need.alternatives.find((a) => a.service === swap.to);
      if (need.service !== swap.from || !alternative) return swapDeep(item, swap);
      return {
        ...item,
        label: alternative.label,
        body: {
          ...need,
          service: alternative.service,
          vendors: alternative.vendors,
          alternatives: [],
          reason: swapWords(need.reason, swap.from, swap.to),
        },
      };
    });
    out = {
      ...out,
      items,
      access: {
        ...out.access,
        connections: out.access.connections.map((c) => (c === swap.from ? swap.to : c)),
        words: out.access.words.map((w) => swapWords(w, swap.from, swap.to)),
      },
    };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Connections

export interface NeedStatus {
  key: string;
  service: string;
  label: string;
  level: "personal" | "workspace";
  reason: string;
  met: boolean;
  /** Connected services the plugin could use instead. */
  swap: { service: string; label: string } | null;
}

/** Each connection the plugin needs, against what this person (or the workspace) has. */
export async function needStatus(
  db: Db,
  items: readonly PluginItem[],
  userId: string | null,
): Promise<NeedStatus[]> {
  const needs = items.filter((i) => (NEED_KINDS as readonly string[]).includes(i.kind));
  if (!needs.length) return [];
  const rows = await db
    .selectFrom("core_integration_connection")
    .select(["vendor", "scope", "owner_user_id"])
    .where("status", "=", "active")
    .execute();
  const held = (vendors: readonly string[], level: string) =>
    rows.some(
      (r) =>
        vendors.includes(r.vendor) &&
        (r.scope === "org" || (level === "personal" && r.owner_user_id === userId)),
    );
  return needs.map((item) => {
    const need = item.body as ConnectionNeedBody;
    const met = need.integration === "mcp" ? held(["mcp"], need.level) : held(need.vendors, need.level);
    const swap = met ? undefined : need.alternatives.find((a) => held(a.vendors, need.level));
    return {
      key: item.key,
      service: need.service,
      label: item.label,
      level: need.level,
      reason: need.reason,
      met,
      swap: swap ? { service: swap.service, label: swap.label } : null,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Applying items

/** The people something is made for. Org-wide things are one shared row. */
export async function holdersOf(
  db: Db,
  install: Pick<Install, "scope" | "ownerUserId" | "role" | "members">,
): Promise<string[]> {
  switch (install.scope) {
    case "personal":
      return [install.ownerUserId as string];
    case "team":
      return [...install.members];
    case "role": {
      const rows = await db
        .selectFrom("core_user")
        .select("id")
        .where("role", "=", install.role as never)
        .execute();
      return rows.map((r) => r.id);
    }
    case "org":
      return [""];
  }
}

function targetHolders(kind: string, scope: string, holders: readonly string[]): string[] {
  const m = MATERIALISERS[kind];
  if (!m) return [];
  return m.perPerson(scope) ? holders.filter(Boolean) : [""];
}

const isPreset = (item: Pick<PluginItem, "kind">) => item.kind === "assistantPreset";
const isExtension = (item: Pick<PluginItem, "kind">) =>
  (EXTENSION_KINDS as readonly string[]).includes(item.kind);

function queueItem(
  ctx: HandlerContext,
  installId: string,
  item: PluginItem,
  state: { state: "active" | "waiting" | "offered"; reason: string | null },
) {
  const values = {
    kind: item.kind,
    name: itemName(item.kind, item.body),
    label: item.label,
    description: item.description ?? null,
    body: JSON.stringify(item.body),
    state: state.state,
    state_reason: state.reason,
  };
  ctx.write(
    ctx.db
      .insertInto("core_plugin_item")
      .values({ install_id: installId, key: item.key, ...values })
      .onConflict((oc) => oc.columns(["install_id", "key"]).doUpdateSet(values)),
  );
}

export interface ApplyInput {
  installId: string;
  scope: Install["scope"];
  installedBy: string;
  holders: readonly string[];
  next: readonly PluginItem[];
  /** Why routines must wait, when a connection is missing. */
  waiting: string | null;
}

/** Makes the copy equal `next`: adds, rewrites and removes items and what they became. */
export async function applyItems(ctx: HandlerContext, input: ApplyInput): Promise<void> {
  const { installId, scope, holders, next } = input;
  const held = await itemsOf(ctx.db, [installId]);
  const targets = await targetsOf(ctx.db, installId);
  const heldByKey = new Map(held.map((i) => [i.key, i]));
  const nextKeys = new Set(next.map((i) => i.key));

  for (const item of held) {
    if (nextKeys.has(item.key)) continue;
    for (const target of targets.filter((t) => t.item_key === item.key)) {
      await removeTarget(ctx, item.kind, target);
    }
    ctx.write(
      ctx.db
        .deleteFrom("core_plugin_item")
        .where("install_id", "=", installId)
        .where("key", "=", item.key),
    );
  }

  for (const item of next) {
    const before = heldByKey.get(item.key);
    const needs = (NEED_KINDS as readonly string[]).includes(item.kind);
    const state = isPreset(item)
      ? { state: before?.state ?? ("offered" as const), reason: null }
      : isExtension(item)
        ? { state: "waiting" as const, reason: "Waiting for an admin's approval" }
        : needs
          ? { state: before?.state ?? ("active" as const), reason: before?.stateReason ?? null }
          : { state: "active" as const, reason: null };
    queueItem(ctx, installId, item, state);

    for (const holder of targetHolders(item.kind, scope, holders)) {
      const target = targets.find(
        (t) => t.item_key === item.key && t.holder_user_id === holder,
      );
      if (target) await MATERIALISERS[item.kind]?.update(ctx, item, target);
      else {
        await createTarget(ctx, installId, {
          item,
          holder,
          installedBy: input.installedBy,
          waiting: input.waiting,
        });
      }
    }
  }
}

/** Marks the items of unmet needs, so the Installed page can say what it waits for. */
export function queueNeedStates(
  ctx: HandlerContext,
  installId: string,
  needs: readonly NeedStatus[],
) {
  for (const need of needs) {
    ctx.write(
      ctx.db
        .updateTable("core_plugin_item")
        .set({
          state: need.met ? "active" : "waiting",
          state_reason: need.met ? null : need.reason,
        })
        .where("install_id", "=", installId)
        .where("key", "=", need.key),
    );
  }
}

export function waitingReason(needs: readonly NeedStatus[]): string | null {
  const missing = needs.filter((n) => !n.met).map((n) => n.label);
  return missing.length ? `Waiting for ${missing.join(" and ")}` : null;
}

/** Offers a person's extension code for review: nothing is installed until an admin approves. */
export async function proposeExtensions(
  ctx: HandlerContext,
  installId: string,
  items: readonly PluginItem[],
): Promise<void> {
  const code = items.filter(isExtension);
  if (!code.length) return;
  if (!ctx.extensionHost) {
    throw new ValidationError("This plugin has an extension, and extensions cannot run here");
  }
  const caller = { actor: ctx.actor, user: ctx.user, origin: ctx.origin };
  for (const item of code) {
    const { id, files } = item.body as { id: string; files: Record<string, string> };
    await ctx.pipeline.invoke("extension.write", { id, files, replace: true }, caller);
    const proposed = (await ctx.pipeline.invoke(
      "extension.propose",
      { id, message: `From the ${installId} plugin install` },
      caller,
    )) as { status: string; message?: string };
    if (proposed.status === "check_failed") {
      throw new ValidationError(
        `${item.label} did not pass the extension checks: ${proposed.message ?? "see the extension"}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Reading a copy

async function currentItem(db: Db, item: StoredItem, targets: readonly Target[]) {
  const read = MATERIALISERS[item.kind]?.read;
  const own = targets.filter((t) => t.item_key === item.key);
  if (!read || !own.length) return stripped(item);
  // A locked copy is the same for everyone and only admins change it: the stored item is the copy.
  const now = await read(db, own[0] as Target);
  if (!now) return null;
  return stripped({ ...item, label: now.label ?? item.label, body: now.body });
}

function stripped(item: StoredItem): PluginItem {
  return {
    kind: item.kind,
    key: item.key,
    label: item.label,
    ...(item.description ? { description: item.description } : {}),
    body: item.body,
  };
}

/** The copy as it stands. An item the person deleted is simply not in it. */
export async function currentItems(db: Db, install: Install): Promise<PluginItem[]> {
  const items = await itemsOf(db, [install.id]);
  if (install.locked) return items.map(stripped);
  const targets = await targetsOf(db, install.id);
  const read = await Promise.all(items.map((item) => currentItem(db, item, targets)));
  return read.filter((i): i is PluginItem => i !== null);
}

const content = (items: readonly PluginItem[]) =>
  canonicalJson(
    [...items]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((i) => ({ key: i.key, label: i.label, body: i.body })),
  );

export const sameItems = (a: readonly PluginItem[], b: readonly PluginItem[]) =>
  content(a) === content(b);

export interface CopyState {
  /** What changed from what it came from, by item label. */
  changed: string[];
  unchanged: boolean;
  plan: UpdatePlan;
  upstream: PluginManifest | null;
  upstreamFingerprint: string | null;
  widening: AccessWidening;
}

const NO_WIDENING: AccessWidening = { operations: [], connections: [], schema: [] };

/** The newest version the copy's source has, prepared the way this copy was. */
export async function upstreamOf(
  ctx: Pick<HandlerContext, "db" | "marketplace">,
  install: Install,
): Promise<{ manifest: PluginManifest; fingerprint: string } | null> {
  let located: Awaited<ReturnType<typeof locate>>;
  try {
    located = await locate(ctx, {
      id: install.pluginId,
      source: install.row.source as PluginSource,
    });
  } catch {
    // A marketplace that cannot be reached is no reason to fail a page: no update for now.
    return null;
  }
  if (!located) return null;
  const clean = normalise(located.manifest);
  return {
    manifest: adapt(clean, install.adaptations),
    fingerprint: await manifestFingerprint(clean),
  };
}

export async function copyState(
  ctx: Pick<HandlerContext, "db" | "marketplace">,
  install: Install,
): Promise<CopyState> {
  const mine = await currentItems(ctx.db, install);
  const base = install.manifest.items;
  const baseByKey = new Map(base.map((i) => [i.key, i]));
  const changed = [
    ...mine.filter((i) => {
      const was = baseByKey.get(i.key);
      return !was || !sameItems([i], [was]);
    }),
    ...base.filter((i) => !mine.some((m) => m.key === i.key)),
  ].map((i) => i.label);
  const unchanged = changed.length === 0;
  const upstream = await upstreamOf(ctx, install);
  const newer =
    upstream !== null &&
    upstream.fingerprint !== install.row.fingerprint &&
    compareVersions(upstream.manifest.version, install.row.version) > 0 &&
    upstream.manifest.version !== install.row.skipped_version;
  const widening =
    upstream && newer
      ? accessWidening(pluginKinds.accessOf(install.manifest), pluginKinds.accessOf(upstream.manifest))
      : NO_WIDENING;
  return {
    changed,
    unchanged,
    plan: planUpdate({ following: install.row.following === 1, newer, unchanged, widening }),
    upstream: upstream?.manifest ?? null,
    upstreamFingerprint: upstream?.fingerprint ?? null,
    widening,
  };
}

/** Moves a copy onto a version: its items become `items`, and `manifest` the new base. */
export async function moveTo(
  ctx: HandlerContext,
  install: Install,
  input: {
    manifest: PluginManifest;
    fingerprint: string;
    items: readonly PluginItem[];
  },
): Promise<void> {
  const needs = await needStatus(ctx.db, input.items, install.ownerUserId);
  await applyItems(ctx, {
    installId: install.id,
    scope: install.scope,
    installedBy: install.row.installed_by,
    holders: membersGetCopies(install) ? [] : await holdersOf(ctx.db, install),
    next: input.items,
    waiting: waitingReason(needs),
  });
  queueNeedStates(ctx, install.id, needs);
  ctx.write(
    ctx.db
      .updateTable("core_plugin_install")
      .set({
        version: input.manifest.version,
        fingerprint: input.fingerprint,
        manifest: JSON.stringify(input.manifest),
        previous_manifest: install.row.manifest,
        name: input.manifest.name,
        skipped_version: null,
        updated_at: ctx.now,
      })
      .where("id", "=", install.id),
  );
}

// ---------------------------------------------------------------------------------------------
// New copies

export interface NewCopy {
  manifest: PluginManifest;
  fingerprint: string;
  source: PluginSource;
  scope: Install["scope"];
  ownerUserId: string | null;
  role?: string | null;
  teamName?: string | null;
  members?: readonly string[];
  locked: boolean;
  parentInstallId?: string | null;
  adaptations: readonly Adaptation[];
  following?: boolean;
}

export function queueInstallRow(ctx: HandlerContext, copy: NewCopy): string {
  const id = newId("pluginInstall");
  ctx.write(
    ctx.db.insertInto("core_plugin_install").values({
      id,
      plugin_id: copy.manifest.id,
      name: copy.manifest.name,
      publisher: copy.manifest.publisher,
      source: copy.source,
      scope: copy.scope,
      owner_user_id: copy.ownerUserId,
      role: copy.role ?? null,
      team_name: copy.teamName ?? null,
      locked: copy.locked ? 1 : 0,
      parent_install_id: copy.parentInstallId ?? null,
      version: copy.manifest.version,
      fingerprint: copy.fingerprint,
      manifest: JSON.stringify(copy.manifest),
      previous_manifest: null,
      adaptations: JSON.stringify(copy.adaptations),
      following: copy.following === false ? 0 : 1,
      detached_at: copy.following === false ? ctx.now : null,
      skipped_version: null,
      installed_by: ctx.user.id,
      created_at: ctx.now,
      updated_at: ctx.now,
    }),
  );
  for (const user of copy.members ?? []) {
    ctx.write(ctx.db.insertInto("core_plugin_member").values({ install_id: id, user_id: user }));
  }
  return id;
}

/** A copy with its items and what they became. Returns its id. */
export async function queueNewCopy(ctx: HandlerContext, copy: NewCopy): Promise<string> {
  const id = queueInstallRow(ctx, copy);
  const scoped = {
    scope: copy.scope,
    ownerUserId: copy.ownerUserId,
    role: copy.role ?? null,
    members: copy.members ?? [],
  };
  const needs = await needStatus(ctx.db, copy.manifest.items, copy.ownerUserId);
  await applyItems(ctx, {
    installId: id,
    scope: copy.scope,
    installedBy: ctx.user.id,
    holders: membersGetCopies({ scope: copy.scope, locked: copy.locked })
      ? []
      : await holdersOf(ctx.db, scoped),
    next: copy.manifest.items,
    waiting: waitingReason(needs),
  });
  queueNeedStates(ctx, id, needs);
  return id;
}

/** Removes a copy and everything it made. */
export async function queueRemoveCopy(ctx: HandlerContext, install: Install): Promise<void> {
  const items = await itemsOf(ctx.db, [install.id]);
  const targets = await targetsOf(ctx.db, install.id);
  for (const target of targets) {
    const item = items.find((i) => i.key === target.item_key);
    if (item) await removeTarget(ctx, item.kind, target);
  }
  ctx.write(
    ctx.db.deleteFrom("core_plugin_item").where("install_id", "=", install.id),
    ctx.db.deleteFrom("core_plugin_member").where("install_id", "=", install.id),
    ctx.db
      .updateTable("core_plugin_merge")
      .set({ status: "kept", decided_at: ctx.now })
      .where("install_id", "=", install.id)
      .where("status", "=", "proposed"),
    ctx.db.deleteFrom("core_plugin_install").where("id", "=", install.id),
  );
}

/** Copies of an unlocked team or role install, one per member. */
export async function childrenOf(db: Db, parentId: string) {
  const rows = await db
    .selectFrom("core_plugin_install")
    .select("id")
    .where("parent_install_id", "=", parentId)
    .execute();
  return rows.map((r) => r.id);
}
