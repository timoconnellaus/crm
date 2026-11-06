// Turning a plugin's items into things in the workspace (ADR 0347). Most items need nothing here:
// a skill or a saved card lives in core_plugin_item and is looked up when it is used. These kinds
// make a real row, so the rest of the app (My routines, views, dashboards, memory) sees an ordinary
// thing. core_plugin_target remembers what each item became, for whom, so an update can rewrite it
// and an uninstall can remove it. All of it runs inside an operation and commits in its batch.
import type { PluginItem } from "@relationship-os/agent-plugins";
import type { CoreDatabase } from "@relationship-os/db";
import type { Kysely } from "kysely";
import {
  queueDeleteRoutine,
  queueInsertRoutine,
  queueUpdateRoutine,
  type RoutineDefinition,
  routineDefinitionSchema,
} from "../assistant/routines.ts";
import { validateDashboardSpec } from "../dashboards/run.ts";
import { dashboardSpecSchema } from "../dashboards/spec.ts";
import { newId } from "../ids.ts";
import {
  DEFAULT_PREFERENCES,
  loadPreferences,
  savePreferencesStatement,
  type UserNotificationPreferences,
} from "../notifications/preferences.ts";
import type { HandlerContext } from "../operation.ts";
import { type ObjectViewSpec, objectViewSpecSchema, validateViewSpec } from "../views/spec.ts";

type Db = Kysely<CoreDatabase>;

export interface Target {
  install_id: string;
  item_key: string;
  holder_user_id: string;
  target_kind: string;
  target_id: string;
  restore: string | null;
}

/** What a materialised item holds now. `label` is absent where the row has no name of its own. */
export interface Current {
  label?: string;
  body: Record<string, unknown>;
}

interface MakeInput {
  item: PluginItem;
  holder: string;
  installedBy: string;
  /** A reason to hold it back for now, such as a missing connection. */
  waiting: string | null;
}

interface Materialiser {
  targetKind: string;
  /** One row per person, or one shared row (holder ''). */
  perPerson: (scope: string) => boolean;
  create(ctx: HandlerContext, input: MakeInput): Promise<{ id: string; restore?: string }>;
  update(ctx: HandlerContext, item: PluginItem, target: Target): Promise<void>;
  /** Null: it is gone. Undefined method: only the stored item counts. */
  read?(db: Db, target: Target): Promise<Current | null>;
  remove(ctx: HandlerContext, target: Target): Promise<void>;
}

const everyPerson = () => true;

const routine: Materialiser = {
  targetKind: "routine",
  perPerson: everyPerson,
  async create(ctx, { item, holder, waiting }) {
    const id = newId("routine");
    queueInsertRoutine(ctx, {
      id,
      ownerId: holder,
      definition: routineDefinitionSchema.parse(item.body),
      draftId: id,
      pausedReason: waiting,
    });
    return { id };
  },
  async update(ctx, item, target) {
    const row = await ctx.db
      .selectFrom("core_routine")
      .select(["id", "automation_id"])
      .where("id", "=", target.target_id)
      .executeTakeFirst();
    if (row) queueUpdateRoutine(ctx, row, routineDefinitionSchema.parse(item.body));
  },
  async read(db, target) {
    const row = await db
      .selectFrom("core_routine")
      .select("definition")
      .where("id", "=", target.target_id)
      .executeTakeFirst();
    return row ? { body: JSON.parse(row.definition) as RoutineDefinition } : null;
  },
  async remove(ctx, target) {
    const row = await ctx.db
      .selectFrom("core_routine")
      .select(["id", "automation_id"])
      .where("id", "=", target.target_id)
      .executeTakeFirst();
    if (row) queueDeleteRoutine(ctx, row);
  },
};

const view: Materialiser = {
  targetKind: "view",
  perPerson: (scope) => scope !== "org",
  async create(ctx, { item, holder, installedBy }) {
    const spec = validateViewSpec(objectViewSpecSchema.parse(item.body.spec));
    const id = newId("view");
    ctx.write(
      ctx.db.insertInto("core_views").values({
        id,
        user_id: holder || installedBy,
        object: spec.object,
        name: item.label,
        spec: JSON.stringify(spec),
        position: 1_000,
        shared: holder ? 0 : 1,
        created_at: ctx.now,
        updated_at: ctx.now,
      }),
    );
    return { id };
  },
  async update(ctx, item, target) {
    const spec = validateViewSpec(objectViewSpecSchema.parse(item.body.spec));
    ctx.write(
      ctx.db
        .updateTable("core_views")
        .set({ name: item.label, spec: JSON.stringify(spec), updated_at: ctx.now })
        .where("id", "=", target.target_id),
    );
  },
  async read(db, target) {
    const row = await db
      .selectFrom("core_views")
      .select(["name", "spec"])
      .where("id", "=", target.target_id)
      .executeTakeFirst();
    return row ? { label: row.name, body: { spec: JSON.parse(row.spec) as ObjectViewSpec } } : null;
  },
  async remove(ctx, target) {
    ctx.write(ctx.db.deleteFrom("core_views").where("id", "=", target.target_id));
  },
};

function dashboard(shared: boolean): Materialiser {
  return {
    targetKind: "dashboard",
    perPerson: () => !shared,
    async create(ctx, { item, holder, installedBy }) {
      const spec = await validateDashboardSpec(ctx.db, dashboardSpecSchema.parse(item.body.spec));
      const id = newId("dashboard");
      ctx.write(
        ctx.db.insertInto("core_dashboards").values({
          id,
          owner_id: holder || installedBy,
          title: item.label,
          description: (item.body.description as string | null | undefined) ?? null,
          shared: shared ? 1 : 0,
          spec: JSON.stringify(spec),
          created_at: ctx.now,
          updated_at: ctx.now,
        }),
      );
      return { id };
    },
    async update(ctx, item, target) {
      const spec = await validateDashboardSpec(ctx.db, dashboardSpecSchema.parse(item.body.spec));
      ctx.write(
        ctx.db
          .updateTable("core_dashboards")
          .set({
            title: item.label,
            description: (item.body.description as string | null | undefined) ?? null,
            spec: JSON.stringify(spec),
            updated_at: ctx.now,
          })
          .where("id", "=", target.target_id),
      );
    },
    async read(db, target) {
      const row = await db
        .selectFrom("core_dashboards")
        .select(["title", "description", "spec"])
        .where("id", "=", target.target_id)
        .executeTakeFirst();
      if (!row) return null;
      return {
        label: row.title,
        body: {
          ...(row.description ? { description: row.description } : {}),
          spec: dashboardSpecSchema.parse(JSON.parse(row.spec)),
        },
      };
    },
    async remove(ctx, target) {
      ctx.write(
        ctx.db.deleteFrom("core_dashboards").where("id", "=", target.target_id),
        ctx.db.deleteFrom("core_user_home").where("dashboard_id", "=", target.target_id),
      );
    },
  };
}

function preferencesFrom(
  held: UserNotificationPreferences,
  body: Record<string, unknown>,
): UserNotificationPreferences {
  return {
    channels: { ...held.channels, ...(body.channels as UserNotificationPreferences["channels"]) },
    digest: typeof body.digest === "boolean" ? body.digest : held.digest,
    digestInApp: typeof body.digestInApp === "boolean" ? body.digestInApp : held.digestInApp,
  };
}

const notification: Materialiser = {
  targetKind: "notification_preference",
  perPerson: everyPerson,
  async create(ctx, { item, holder }) {
    const held = (await loadPreferences(ctx.db, [holder])).get(holder) ?? {
      ...DEFAULT_PREFERENCES,
    };
    ctx.write(savePreferencesStatement(ctx.db, holder, preferencesFrom(held, item.body), ctx.now));
    return { id: holder, restore: JSON.stringify(held) };
  },
  async update(ctx, item, target) {
    const held = (await loadPreferences(ctx.db, [target.target_id])).get(target.target_id) ?? {
      ...DEFAULT_PREFERENCES,
    };
    ctx.write(
      savePreferencesStatement(ctx.db, target.target_id, preferencesFrom(held, item.body), ctx.now),
    );
  },
  async remove(ctx, target) {
    if (!target.restore) return;
    ctx.write(
      savePreferencesStatement(
        ctx.db,
        target.target_id,
        JSON.parse(target.restore) as UserNotificationPreferences,
        ctx.now,
      ),
    );
  },
};

const teamMemory: Materialiser = {
  targetKind: "memory",
  perPerson: () => false,
  async create(ctx, { item, installedBy }) {
    const id = newId("memory");
    ctx.write(
      ctx.db.insertInto("core_memory").values({
        id,
        user_id: null,
        kind: "team",
        text: String(item.body.text),
        condition: null,
        condition_label: null,
        status: "active",
        source_thread_id: null,
        source_message_seq: null,
        checked: JSON.stringify({ by: "plugin" }),
        author_id: installedBy,
        history: null,
        active_since: ctx.now,
        created_at: ctx.now,
        updated_at: ctx.now,
      }),
    );
    return { id };
  },
  async update(ctx, item, target) {
    ctx.write(
      ctx.db
        .updateTable("core_memory")
        .set({ text: String(item.body.text), updated_at: ctx.now })
        .where("id", "=", target.target_id),
    );
  },
  async read(db, target) {
    const row = await db
      .selectFrom("core_memory")
      .select("text")
      .where("id", "=", target.target_id)
      .executeTakeFirst();
    return row ? { body: { text: row.text } } : null;
  },
  async remove(ctx, target) {
    ctx.write(
      ctx.db.deleteFrom("core_memory_refs").where("memory_id", "=", target.target_id),
      ctx.db.deleteFrom("core_memory").where("id", "=", target.target_id),
    );
  },
};

export const MATERIALISERS: Readonly<Record<string, Materialiser>> = {
  routine,
  savedView: view,
  dashboard: dashboard(false),
  sharedDashboard: dashboard(true),
  notificationPreset: notification,
  teamMemory,
};

export async function targetsOf(db: Db, installId: string): Promise<Target[]> {
  return db
    .selectFrom("core_plugin_target")
    .selectAll()
    .where("install_id", "=", installId)
    .execute();
}

/** Makes one item for one holder, and records it. */
export async function createTarget(
  ctx: HandlerContext,
  installId: string,
  input: MakeInput,
): Promise<void> {
  const m = MATERIALISERS[input.item.kind];
  if (!m) return;
  const made = await m.create(ctx, input);
  ctx.write(
    ctx.db.insertInto("core_plugin_target").values({
      install_id: installId,
      item_key: input.item.key,
      holder_user_id: input.holder,
      target_kind: m.targetKind,
      target_id: made.id,
      restore: made.restore ?? null,
    }),
  );
}

/** Removes what an item became, and forgets it. */
export async function removeTarget(ctx: HandlerContext, kind: string, target: Target) {
  await MATERIALISERS[kind]?.remove(ctx, target);
  ctx.write(
    ctx.db
      .deleteFrom("core_plugin_target")
      .where("install_id", "=", target.install_id)
      .where("item_key", "=", target.item_key)
      .where("holder_user_id", "=", target.holder_user_id)
      .where("target_id", "=", target.target_id),
  );
}
