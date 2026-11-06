// What an erase reaches in plugins (ADR 0320, ADR 0347). A skill saved from a chat, a merge proposal
// or a workspace plugin may name the erased subject: the assistant writes them from what was just
// said. Each stored copy of the text is scrubbed: the items, the base manifests, the workspace
// registry and open merge proposals. A copy that named them stops following updates, so the same
// words cannot come back from upstream. What was published to the marketplace is out of reach:
// `plugin.publish` refuses text that looks like a person's details, and this is why.
import type { ConversationScrub } from "../assistant/scrub.ts";
import { mentions, scrubPattern, scrubValue } from "../assistant/scrub.ts";
import type { HandlerContext } from "../operation.ts";

/** Scrubs JSON text field by field, so the structure survives. */
function clean(text: string, pattern: RegExp): string {
  return JSON.stringify(scrubValue(JSON.parse(text) as unknown, pattern));
}

export async function queueErasePlugins(
  ctx: HandlerContext,
  scrub: ConversationScrub,
): Promise<number> {
  const pattern = scrubPattern(scrub);
  if (!pattern) return 0;
  let count = 0;

  const items = await ctx.db.selectFrom("core_plugin_item").selectAll().execute();
  const touched = new Set<string>();
  for (const item of items) {
    if (!mentions([item.label, item.description, item.body], pattern)) continue;
    count += 1;
    touched.add(item.install_id);
    ctx.write(
      ctx.db
        .updateTable("core_plugin_item")
        .set({
          label: scrubValue(item.label, pattern),
          description: item.description === null ? null : scrubValue(item.description, pattern),
          body: clean(item.body, pattern),
        })
        .where("install_id", "=", item.install_id)
        .where("key", "=", item.key),
    );
  }

  const installs = await ctx.db
    .selectFrom("core_plugin_install")
    .select(["id", "name", "manifest", "previous_manifest", "adaptations", "following"])
    .execute();
  for (const row of installs) {
    const named = mentions([row.name, row.manifest, row.previous_manifest], pattern);
    if (!named && !touched.has(row.id)) continue;
    if (named) count += 1;
    ctx.write(
      ctx.db
        .updateTable("core_plugin_install")
        .set({
          name: scrubValue(row.name, pattern),
          manifest: clean(row.manifest, pattern),
          previous_manifest:
            row.previous_manifest === null ? null : clean(row.previous_manifest, pattern),
          following: 0,
          detached_at: ctx.now,
          updated_at: ctx.now,
        })
        .where("id", "=", row.id),
    );
  }

  const registry = await ctx.db.selectFrom("core_plugin_registry").selectAll().execute();
  for (const row of registry) {
    if (!mentions([row.name, row.manifest], pattern)) continue;
    count += 1;
    ctx.write(
      ctx.db
        .updateTable("core_plugin_registry")
        .set({
          name: scrubValue(row.name, pattern),
          manifest: clean(row.manifest, pattern),
          updated_at: ctx.now,
        })
        .where("plugin_id", "=", row.plugin_id)
        .where("version", "=", row.version),
    );
  }

  const merges = await ctx.db.selectFrom("core_plugin_merge").select(["id", "proposal"]).execute();
  for (const row of merges) {
    if (!mentions(row.proposal, pattern)) continue;
    count += 1;
    ctx.write(
      ctx.db
        .updateTable("core_plugin_merge")
        .set({ proposal: clean(row.proposal, pattern) })
        .where("id", "=", row.id),
    );
  }

  const requests = await ctx.db
    .selectFrom("core_plugin_request")
    .select(["id", "name"])
    .execute();
  for (const row of requests) {
    if (!mentions(row.name, pattern)) continue;
    count += 1;
    ctx.write(
      ctx.db
        .updateTable("core_plugin_request")
        .set({ name: scrubValue(row.name, pattern) })
        .where("id", "=", row.id),
    );
  }
  return count;
}
