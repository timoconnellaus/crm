// plan.get (ADR 0211): the hosted plan's entitlements, read-only, with current usage. There is no
// plan.set: only the hosted control plane writes core_entitlements (through the D1 REST API).
import { z } from "zod";
import {
  BILLING_URL,
  countActiveUsers,
  countLiveRecords,
  entitlementsSchema,
  loadEntitlements,
} from "../entitlements.ts";
import { defineOperation } from "../operation.ts";

export const planGet = defineOperation({
  name: "plan.get",
  description:
    "The deployment's hosted plan (free, team, business or enterprise) and its limits: users, " +
    "records (people plus organisations; null = unlimited) and whether the platform's AI is " +
    "included, with current usage. managed is false on a self-hosted install, which has no " +
    "limits. Admins only. Read-only: plans change only through billing.",
  input: z.object({}),
  output: z.object({
    managed: z.boolean().describe("False: self-hosted, no limits"),
    entitlements: entitlementsSchema.nullable(),
    usage: z.object({
      users: z.number().describe("Active people who can sign in (support users never count)"),
      records: z.number().describe("Live people plus organisations"),
    }),
    billingUrl: z.string().nullable().describe("Where to upgrade, when managed"),
  }),
  permission: "settings:manage",
  risk: "read",
  mcp: { idempotent: true },
  async handler(_input, ctx) {
    const [entitlements, users, records] = await Promise.all([
      loadEntitlements(ctx.db, { fresh: true }),
      countActiveUsers(ctx.db),
      countLiveRecords(ctx.db),
    ]);
    return {
      managed: entitlements !== null,
      entitlements,
      usage: { users, records },
      billingUrl: entitlements ? BILLING_URL : null,
    };
  },
});

export const planOperations = [planGet] as const;
