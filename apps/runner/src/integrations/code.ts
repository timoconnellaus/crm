// `codemode:<gatekeeper>` host modules (ADR 0050, ADR 0110): what extension tools and Code Mode
// scripts reach a connected gatekeeper through. The module is the gatekeeper's name; its methods
// are `connections()`, `call(connectionId, resource, method, args)` and `types(connectionId,
// resource)`. Calls go to the connection's integration host as the caller, so the gate, outbound
// approvals and observations apply exactly as for MCP's integration.call. An extension principal
// never owns a personal connection, so extension code reaches org connections only.
import type { ActingUser, Actor, Origin } from "@relationship-os/core";
import { integrationRuntime } from "./runtime.ts";

export interface GatekeeperCall {
  vendor: string;
  method: string;
  args: unknown[];
  user: ActingUser;
  actor: Actor;
  origin: Origin;
  reason?: string | undefined;
}

type Envelope =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string } };

interface Row {
  id: string;
  vendor: string;
  scope: string;
  owner_user_id: string;
  status: string;
  title: string;
  resources: string;
}

async function usable(env: Env, call: GatekeeperCall): Promise<Row[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, vendor, scope, owner_user_id, status, title, resources
     FROM core_integration_connection
     WHERE vendor = ? AND status = 'active' AND (scope = 'org' OR owner_user_id = ?)`,
  )
    .bind(call.vendor, call.user.id)
    .all<Row>();
  return results;
}

export async function gatekeeperCall(env: Env, call: GatekeeperCall): Promise<unknown> {
  const rows = await usable(env, call);
  if (call.method === "connections") {
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      resources: (
        JSON.parse(r.resources) as { key: string; bindingName: string; tsType: string }[]
      ).map((x) => ({ key: x.key, bindingName: x.bindingName, tsType: x.tsType })),
    }));
  }
  const [connectionId, resource, method, args] = call.args as [string, string, string, unknown[]];
  const row = rows.find((r) => r.id === connectionId);
  const fail = (message: string) => ({ ok: false as const, error: { code: "forbidden", message } });
  if (!row) {
    const reply = fail(`No usable ${call.vendor} connection ${String(connectionId)}`);
    return call.method === "types" ? Promise.reject(new Error(reply.error.message)) : reply;
  }
  const bound = (JSON.parse(row.resources) as { key: string; bindingName: string }[]).find(
    (r) => r.key === resource || r.bindingName.toLowerCase() === String(resource).toLowerCase(),
  );
  if (!bound) {
    const reply = fail(`No resource ${String(resource)} on ${row.title}`);
    return call.method === "types" ? Promise.reject(new Error(reply.error.message)) : reply;
  }
  const runtime = integrationRuntime(env);
  if (call.method === "types") return runtime.types({ connectionId: row.id, resource: bound.key });
  try {
    const value = await runtime.call({
      connectionId: row.id,
      resource: bound.key,
      method: String(method),
      args: Array.isArray(args) ? args : [],
      caller: {
        actor: call.actor,
        userId: call.user.id,
        userName: call.user.name,
        role: call.user.role,
        origin: call.origin,
        reason: call.reason,
      },
    });
    return { ok: true, value } satisfies Envelope;
  } catch (error) {
    return {
      ok: false,
      error: {
        code: (error as { code?: string }).code ?? "integration_error",
        message: error instanceof Error ? error.message : String(error),
      },
    } satisfies Envelope;
  }
}
