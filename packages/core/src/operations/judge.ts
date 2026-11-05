// judge.* operations (ADR 0230): the judge's per-placement switches and where its key is.
// Admin-only and human-only (`policy:manage`, as the adjudicator's settings), and never exposed to
// MCP: switching off a fail-closed placement loosens approval, which only a human admin may do
// (AGENTS.md). Changes are audited like any write. Keys are never read, stored or returned here:
// the view says only where the key is (BYOK, a Worker secret, or none).
import { z } from "zod";
import { adjudicatorReviewer, loadAdjudicatorSettings } from "../adjudicator/run.ts";
import { ValidationError } from "../errors.ts";
import { JEV_MODEL, JEV_PRICE, judgeKeyStatus } from "../judge/jev.ts";
import { loadJudgeSettings } from "../judge/load.ts";
import {
  JUDGE_PLACEMENTS,
  type JudgePlacementId,
  SWITCHABLE_PLACEMENTS,
} from "../judge/placements.ts";
import { JUDGE_SETTINGS, type JudgeSettings, resolvePlacements } from "../judge/settings.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";

const placementView = z.object({
  id: z.string(),
  label: z.string(),
  askedWhen: z.string(),
  failMode: z.string(),
  onFailure: z.string(),
  sends: z.string(),
  sendsRecordContent: z.boolean(),
  switchable: z.boolean(),
  /** False: declared for a later build step and never asked yet. */
  built: z.boolean(),
  /** Asks the judge when it has a key. */
  on: z.boolean(),
  /** Which layer decided `on`: shipped default, deploy var (JUDGE_PLACEMENTS), admin, or fixed. */
  source: z.enum(["shipped", "deploy", "admin", "fixed"]),
});

const judgeView = z.object({
  /** The judge has a reachable key: every switched-on placement asks it. */
  on: z.boolean(),
  /** Where the key is, never the key. */
  keySource: z.enum(["byok", "secret"]).nullable(),
  viaGateway: z.boolean(),
  /** A configuration problem (BYOK claimed without a gateway), when there is one. */
  problem: z.string().nullable(),
  model: z.string(),
  pricePerMillionInputTokensUsd: z.number(),
  placements: z.array(placementView),
  /** Who reviews for the policy adjudicator: Jev by default when the judge has a key. */
  adjudicatorReviewer: z.enum(["llm", "jev"]),
});

async function view(ctx: HandlerContext, settings: JudgeSettings) {
  const env = ctx.aiEnv ?? {};
  const key = judgeKeyStatus(env);
  const resolved = resolvePlacements(env.JUDGE_PLACEMENTS, settings, {
    hosted: Boolean(env.AI_PLATFORM_GATEWAY_ID?.trim()),
  });
  const adjudicator = await loadAdjudicatorSettings(ctx.db);
  return {
    on: key.keySource !== null,
    keySource: key.keySource,
    viaGateway: key.viaGateway,
    problem: key.problem,
    model: JEV_MODEL,
    pricePerMillionInputTokensUsd: JEV_PRICE.inputPerMillionUsd,
    placements: JUDGE_PLACEMENTS.map((p) => ({
      id: p.id,
      label: p.label,
      askedWhen: p.askedWhen,
      failMode: p.failMode,
      onFailure: p.onFailure,
      sends: p.sends,
      sendsRecordContent: p.sendsRecordContent,
      switchable: p.switchable,
      built: p.built,
      ...resolved[p.id as JudgePlacementId],
    })),
    adjudicatorReviewer: adjudicatorReviewer(adjudicator, key.keySource !== null),
  };
}

export const judgeGet = defineOperation({
  name: "judge.get",
  description:
    "The judge (Jev): whether it has a key and where the key is held (never the key), the " +
    "pinned model, and each placement with its switch, fail mode and the data it sends. Admins " +
    "only, people only. Read-only.",
  input: z.object({}),
  output: judgeView,
  permission: "policy:manage",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(_input, ctx) {
    return view(ctx, await loadJudgeSettings(ctx.db));
  },
});

const switchableId = z.string().refine((id) => (SWITCHABLE_PLACEMENTS as string[]).includes(id), {
  message: `A placement with a switch: ${SWITCHABLE_PLACEMENTS.join(", ")}`,
});

export const judgeUpdate = defineOperation({
  name: "judge.update",
  description:
    "Switch judge placements on or off (null returns one to its default). Turning off a " +
    "placement that fails closed lets more changes through without a person, so only a human " +
    "admin can. Admins only, people only.",
  input: z.object({
    placements: z
      .record(switchableId, z.boolean().nullable())
      .describe("Placement id → true (on), false (off) or null (the default)"),
  }),
  output: judgeView,
  permission: "policy:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const entries = Object.entries(input.placements);
    if (!entries.length) throw new ValidationError("Pass at least one placement", {});
    const before = await loadJudgeSettings(ctx.db);
    const placements = { ...before.placements };
    for (const [id, on] of entries) {
      if (on === null) delete placements[id as JudgePlacementId];
      else placements[id as JudgePlacementId] = on;
    }
    const after: JudgeSettings = { placements };
    const value = JSON.stringify(after);
    ctx.write(
      ctx.db
        .insertInto("core_settings")
        .values({ key: JUDGE_SETTINGS, value, updated_at: ctx.now, updated_by: ctx.user.id })
        .onConflict((oc) =>
          oc.column("key").doUpdateSet({ value, updated_at: ctx.now, updated_by: ctx.user.id }),
        ),
    );
    ctx.recordChange({
      object: "settings",
      id: JUDGE_SETTINGS,
      action: "update",
      before: { placements: before.placements },
      after: { placements: after.placements },
    });
    return view(ctx, after);
  },
});

export const judgeOperations = [judgeGet, judgeUpdate] as const;
