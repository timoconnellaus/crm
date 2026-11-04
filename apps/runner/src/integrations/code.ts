// `codemode:<gatekeeper>` host modules (ADR 0050, ADR 0110): what extension tools and Code Mode
// scripts reach a connected gatekeeper through. The module is the gatekeeper's name; its methods
// are `connections()`, `call(connectionId, resource, method, args)` and `types(connectionId,
// resource)`. Calls go to the connection's integration host as the caller, so the gate, outbound
// approvals and observations apply exactly as for MCP's integration.call. An extension principal
// never owns a personal connection, so extension code reaches org connections only.
import {
  type ActingUser,
  type Actor,
  type Origin,
  type PendingApproval,
  ROLES,
  type Role,
} from "@crm/core";
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

/** An automation run's cascade position, for the origin of its gatekeeper calls. */
export interface RunAsContext {
  automationId: string;
  runId: string;
  extensionId: string;
  depth: number;
  chain: string[];
  rootEventId: string;
  /** Test mode (ADR 0133): nothing reaches the gatekeeper. */
  test: boolean;
}

interface BoundRow extends Row {
  owner_email: string;
  owner_name: string;
  owner_role: string;
  owner_deactivated_at: string | null;
}

/**
 * `codemode:<gatekeeper>` in an automation run (ADR 0170): the connection id a step passes is a
 * declared slot, resolved to the connection a person bound to it. The call is made as that
 * connection's owner (actor `automation`, origin with the automation and run), so personal
 * connections work and outbound actions land in the approval queue with the run's origin: a
 * pending one pauses the run like any other review (the caller records it as pending).
 */
export async function boundGatekeeperCall(
  env: Env,
  call: { vendor: string; method: string; args: unknown[]; run: RunAsContext },
): Promise<{ reply: unknown; pending?: PendingApproval }> {
  const fail = (code: string, message: string) => ({
    reply: { ok: false as const, error: { code, message } },
  });
  const { run } = call;
  const bindings = await env.DB.prepare(
    `SELECT b.slot, b.gatekeeper, c.id, c.vendor, c.scope, c.owner_user_id, c.status, c.title,
            c.resources, u.email AS owner_email, u.name AS owner_name, u.role AS owner_role,
            u.deactivated_at AS owner_deactivated_at
     FROM core_automation_binding b
     JOIN core_integration_connection c ON c.id = b.connection_id
     JOIN core_user u ON u.id = c.owner_user_id
     WHERE b.automation_id = ? AND b.revoked_at IS NULL`,
  )
    .bind(run.automationId)
    .all<BoundRow & { slot: string; gatekeeper: string }>();
  const usableRows = bindings.results.filter((b) => b.gatekeeper === call.vendor);
  if (call.method === "connections") {
    return {
      reply: usableRows.map((r) => ({
        id: r.slot,
        title: r.title,
        resources: (
          JSON.parse(r.resources) as { key: string; bindingName: string; tsType: string }[]
        ).map((x) => ({ key: x.key, bindingName: x.bindingName, tsType: x.tsType })),
      })),
    };
  }
  const [slot, resource, method, args] = call.args as [string, string, string, unknown[]];
  const row = usableRows.find((r) => r.slot === slot);
  if (!row) {
    const message = `No ${call.vendor} connection is bound to “${String(slot)}” for ${run.automationId}`;
    if (call.method === "types") throw new Error(message);
    return fail("forbidden", message);
  }
  if (row.status !== "active" || row.owner_deactivated_at) {
    const message = `The connection bound to “${slot}” (${row.title}) is not usable: ${row.status}`;
    if (call.method === "types") throw new Error(message);
    return fail("forbidden", message);
  }
  const bound = (JSON.parse(row.resources) as { key: string; bindingName: string }[]).find(
    (r) => r.key === resource || r.bindingName.toLowerCase() === String(resource).toLowerCase(),
  );
  if (!bound) {
    const message = `No resource ${String(resource)} on ${row.title}`;
    if (call.method === "types") throw new Error(message);
    return fail("forbidden", message);
  }
  const runtime = integrationRuntime(env);
  if (call.method === "types") {
    return { reply: await runtime.types({ connectionId: row.id, resource: bound.key }) };
  }
  if (run.test) {
    // Test mode writes nothing and sends nothing: the call is described, not made.
    return {
      reply: {
        ok: true,
        value: {
          test: true,
          wouldCall: { slot, connection: row.title, resource: bound.key, method: String(method) },
        },
      },
    };
  }
  const role = (ROLES as readonly string[]).includes(row.owner_role)
    ? (row.owner_role as Role)
    : "viewer";
  try {
    const result = await runtime.call({
      connectionId: row.id,
      resource: bound.key,
      method: String(method),
      args: Array.isArray(args) ? args : [],
      caller: {
        actor: "automation",
        userId: row.owner_user_id,
        userName: row.owner_name,
        role,
        origin: {
          surface: "automation",
          automationId: run.automationId,
          runId: run.runId,
          extensionId: run.extensionId,
          depth: run.depth,
          chain: run.chain,
          rootEventId: run.rootEventId,
        },
        reason: `Automation ${run.automationId} (${slot})`,
      },
    });
    const pending = result.pending[0];
    return {
      reply: { ok: true, value: result } satisfies Envelope,
      ...(pending ? { pending } : {}),
    };
  } catch (error) {
    return fail(
      (error as { code?: string }).code ?? "integration_error",
      error instanceof Error ? error.message : String(error),
    );
  }
}
