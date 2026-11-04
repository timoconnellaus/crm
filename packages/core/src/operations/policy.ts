// policy.* operations: read and change the org's approval-policy preset (ADR 0011). Changing it
// is admin-only and human-only: no AI or automation can loosen (or tighten) its own gate.
import { z } from "zod";
import {
  APPROVAL_POLICY_SETTING,
  approvalPolicySchema,
  isLoosening,
  POLICY_PRESETS,
  PRESET_MATRICES,
} from "../gate.ts";
import { defineOperation } from "../operation.ts";
import { loadApprovalPolicy } from "../settings.ts";

const policyOutput = z.object({
  preset: z.enum(POLICY_PRESETS),
  /** The full actor × risk matrix the preset applies, for display. */
  matrix: z.record(z.string(), z.record(z.string(), z.unknown())),
});

export const policyGet = defineOperation({
  name: "policy.get",
  description:
    "Get the org's approval policy: the active preset (cautious, balanced or autonomous) and " +
    "the actor × risk-class matrix it applies. The deploy-time floor is not included. Read-only.",
  input: z.object({}),
  output: policyOutput,
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(_input, ctx) {
    const policy = await loadApprovalPolicy(ctx.db);
    return { preset: policy.preset, matrix: PRESET_MATRICES[policy.preset] };
  },
});

export const policyUpdate = defineOperation({
  name: "policy.update",
  description:
    "Change the org's approval-policy preset. Admins only, and only a human can call it: AI " +
    "assistants, MCP clients and automations are refused. The deploy-time floor still applies " +
    "on top of any preset.",
  input: approvalPolicySchema,
  output: policyOutput.extend({ previousPreset: z.enum(POLICY_PRESETS), loosened: z.boolean() }),
  permission: "policy:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const before = await loadApprovalPolicy(ctx.db);
    ctx.write(
      ctx.db
        .insertInto("core_settings")
        .values({
          key: APPROVAL_POLICY_SETTING,
          value: JSON.stringify({ preset: input.preset }),
          updated_at: ctx.now,
          updated_by: ctx.user.id,
        })
        .onConflict((oc) =>
          oc.column("key").doUpdateSet({
            value: JSON.stringify({ preset: input.preset }),
            updated_at: ctx.now,
            updated_by: ctx.user.id,
          }),
        ),
    );
    ctx.recordChange({
      object: "settings",
      id: APPROVAL_POLICY_SETTING,
      action: "update",
      before: { preset: before.preset },
      after: { preset: input.preset },
    });
    return {
      preset: input.preset,
      matrix: PRESET_MATRICES[input.preset],
      previousPreset: before.preset,
      loosened: isLoosening(before.preset, input.preset),
    };
  },
});

export const policyOperations = [policyGet, policyUpdate] as const;
