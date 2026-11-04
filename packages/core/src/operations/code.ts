// Code Mode (stage 3b, ADR 0042): the MCP `code` tool. A short ES module the client model writes runs
// in a Dynamic Worker (no network) and calls operations through `codemode:crm` as the connected
// user's own actor (mcp), with their role and token scopes, through the same gate and simulation
// as the tools: a bulk change still becomes one pending action, and reads see the session's
// pending changes.
//
// Limits (ADR 0043): it needs `records:write` (a script can change records); one script per user at
// a time (the runner's per-user gate answers `concurrency_limit`); and a per-user rate limit, which
// crm-app applies by wrapping its host with `withCodeModeRateLimit`.
import { z } from "zod";
import { ForbiddenError, RateLimitedError } from "../errors.ts";
import type { ExtensionHost } from "../extensions/host.ts";
import { requireHost } from "../extensions/install.ts";
import { defineOperation } from "../operation.ts";
import { type RateLimitBinding, rateLimit } from "../rate-limit.ts";

export const CODE_MAX_BYTES = 50_000;

const DESCRIPTION = `Run a short JavaScript/TypeScript ES module against the CRM, for work that takes many calls or some logic: looping over search results, joining data, computing a report, preparing one bulk change. It runs in a sandbox with no network, for at most 30 seconds and 100 operation calls, as you (same permissions, approval policy and audit as the other tools: a change that needs approval is queued, not applied, and your later reads in the script see it as pending).

Import { crm } from "codemode:crm" and call operations by name: await crm.call("person.list", { filter: …, limit: 50 }). Names and inputs are the ones describe_operations lists (person.get, person.list, person.updateMany, organisation.list, activity.log, record.list, query.sql, search.global, …). A failed call throws an Error with .code and .details; a call queued for approval returns { status: "pending_approval", actionId, … } instead of its result. Export default an async function (or a value); its return value (JSON) comes back as "value", with console.log/info/warn/error output as "logs".

To change many records, prefer ONE *Many call (e.g. person.updateMany with up to 100 ids) over a loop of single updates: it is atomic and becomes one reviewable change. Pass the input "reason" to say why; it is stored on anything queued.

Example, tagging every person at an organisation:

import { crm } from "codemode:crm";
export default async function () {
  const page = await crm.call("person.list", {
    filter: { field: "organisationId", op: "eq", value: "org_01J…" },
    fields: ["id", "displayName"],
    limit: 100,
  });
  const ids = page.items.map((p) => p.id);
  console.log("tagging", ids.length, "people");
  const result = await crm.call("person.updateMany", { ids, addTags: ["offsite-2026"] });
  return { tagged: ids.length, result };
}`;

const resultSchema = z.object({
  ok: z.boolean(),
  value: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  logs: z.array(z.object({ level: z.string(), message: z.string() })),
  operations: z.array(
    z.object({
      operation: z.string(),
      ok: z.boolean(),
      code: z.string().optional(),
      pendingActionId: z.string().optional(),
      ms: z.number(),
    }),
  ),
  pending: z.array(z.unknown()),
  durationMs: z.number(),
  truncated: z.boolean().optional(),
});

export const codeRun = defineOperation({
  name: "code.run",
  description: DESCRIPTION,
  input: z.object({
    code: z
      .string()
      .min(1)
      .max(CODE_MAX_BYTES)
      .describe('The ES module source; import { crm } from "codemode:crm"'),
    reason: z
      .string()
      .trim()
      .max(1000)
      .optional()
      .describe("Why: stored on any change the script queues for approval"),
  }),
  output: resultSchema,
  // A script can change records, so it needs write permission even when it only reads.
  permission: "records:write",
  risk: "write",
  // Never queued itself: every operation the script calls goes through the gate on its own.
  bookkeeping: true,
  actors: ["mcp", "assistant"],
  redact: ["code"],
  mcp: { curated: true, title: "Run code", toolName: "code" },
  auditSummary: (output) => ({
    ok: output.ok,
    operations: output.operations.length,
    pending: output.pending.length,
  }),
  async handler(input, ctx) {
    const host = requireHost(ctx);
    if (ctx.actor !== "mcp" && ctx.actor !== "assistant") {
      throw new ForbiddenError("Code Mode runs only for MCP clients and the assistant");
    }
    const reason = input.reason ?? ctx.reason;
    const result = await host.runCode({
      code: input.code,
      caller: {
        actor: ctx.actor,
        user: ctx.user,
        origin: {
          surface: ctx.origin.surface === "ui" ? "ui" : "mcp",
          ...(ctx.origin.clientId ? { clientId: ctx.origin.clientId } : {}),
          ...(ctx.origin.clientName ? { clientName: ctx.origin.clientName } : {}),
          ...(ctx.origin.sessionId ? { sessionId: ctx.origin.sessionId } : {}),
        },
        ...(ctx.grantedPermissions ? { grantedPermissions: [...ctx.grantedPermissions] } : {}),
        ...(reason ? { reason } : {}),
      },
    });
    if (!result.ok && result.error?.code === "concurrency_limit") {
      throw new RateLimitedError(result.error.message, { limit: "concurrency", perUser: 1 });
    }
    return result;
  },
});

/**
 * The host with Code Mode's per-user rate limit (the Workers Rate Limiting binding
 * CODE_MODE_RATE_LIMIT in crm-app). Over the limit, `runCode` throws RateLimitedError before
 * anything reaches the runner. A missing binding allows the call (see rateLimit).
 */
export function withCodeModeRateLimit(
  host: ExtensionHost,
  binding: RateLimitBinding | undefined,
): ExtensionHost {
  return {
    ...host,
    async runCode(input) {
      const limited = await rateLimit(binding, `code:${input.caller.user.id}`);
      if (!limited.ok) {
        throw new RateLimitedError(
          `Too many Code Mode runs; retry in ${limited.retryAfterSeconds}s`,
          { retryAfterSeconds: limited.retryAfterSeconds },
        );
      }
      return host.runCode(input);
    },
  };
}

export const codeOperations = [codeRun] as const;
