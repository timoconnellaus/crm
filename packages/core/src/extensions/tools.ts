// Extension tools as operations (ADR 0023): `x.<extension>.<tool>`, built from installed
// manifests, so they appear in the registry (and so as MCP tools) next to core operations. The
// handler runs the tool in the sandbox through the extension host.
import type { CoreDatabase } from "@crm/db";
import type { ExtensionManifest, ToolManifest } from "@crm/sdk";
import type { Kysely } from "kysely";
import { z } from "zod";
import { ForbiddenError, OperationError } from "../errors.ts";
import { type AnyOperation, defineOperation } from "../operation.ts";
import { requireHost } from "./install.ts";

export const TOOL_OPERATION_RE = /^x\.([a-z][a-z0-9]{1,29})\.([a-z][a-zA-Z0-9]{0,39})$/;

function schemaFrom(json: Record<string, unknown>, fallback: z.ZodType): z.ZodType {
  try {
    return z.fromJSONSchema(json as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    return fallback;
  }
}

const cache = new Map<string, AnyOperation>();

/** The operation for one tool of an installed manifest. */
export function toolOperation(
  manifest: ExtensionManifest,
  name: string,
  tool: ToolManifest,
): AnyOperation {
  const opName = `x.${manifest.id}.${name}`;
  const key = `${opName}@${manifest.version}:${JSON.stringify(tool)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const op = defineOperation({
    name: opName,
    description: `${tool.description} (Extension tool from ${manifest.label ?? manifest.id} ${manifest.version}.)`,
    input: schemaFrom(tool.inputSchema, z.record(z.string(), z.unknown())),
    output: schemaFrom(tool.outputSchema, z.unknown()),
    permission: tool.risk === "read" ? "records:read" : "records:write",
    risk: tool.risk,
    async handler(input, ctx) {
      const row = await ctx.db
        .selectFrom("core_extensions")
        .select(["status", "commit_oid"])
        .where("id", "=", manifest.id)
        .executeTakeFirst();
      if (row?.status !== "active") {
        throw new ForbiddenError(
          `Extension ${manifest.id} is ${row?.status ?? "not installed"}; its tools cannot run`,
          { extension: manifest.id, status: row?.status ?? null },
        );
      }
      const result = await requireHost(ctx).runTool({
        id: manifest.id,
        commit: row.commit_oid,
        tool: name,
        input,
        caller: { actor: ctx.actor, userId: ctx.user.id },
      });
      if (!result.ok) {
        throw new OperationError("extension_error", result.error.message, {
          extension: manifest.id,
          tool: name,
          code: result.error.code,
          runId: result.runId,
          quarantined: result.quarantined,
          ...(result.error.details === undefined ? {} : { details: result.error.details }),
        });
      }
      return result.value as never;
    },
  });
  cache.set(key, op);
  return op;
}

async function manifests(db: Kysely<CoreDatabase>, id?: string): Promise<ExtensionManifest[]> {
  let query = db.selectFrom("core_extensions").select(["manifest", "status"]);
  if (id) query = query.where("id", "=", id);
  const rows = await query.execute();
  return rows.map((row) => JSON.parse(row.manifest) as ExtensionManifest);
}

/** Every installed extension tool as an operation (for registry listings and MCP). */
export async function loadExtensionOperations(db: Kysely<CoreDatabase>): Promise<AnyOperation[]> {
  const ops: AnyOperation[] = [];
  for (const manifest of await manifests(db)) {
    for (const [name, tool] of Object.entries(manifest.tools ?? {})) {
      ops.push(toolOperation(manifest, name, tool));
    }
  }
  return ops;
}

/** Resolves `x.<extension>.<tool>` to its operation, or undefined. */
export async function resolveExtensionOperation(
  db: Kysely<CoreDatabase>,
  name: string,
): Promise<AnyOperation | undefined> {
  const match = TOOL_OPERATION_RE.exec(name);
  if (!match) return undefined;
  const [, id, tool] = match as unknown as [string, string, string];
  const [manifest] = await manifests(db, id);
  const spec = manifest?.tools?.[tool];
  return manifest && spec ? toolOperation(manifest, tool, spec) : undefined;
}
