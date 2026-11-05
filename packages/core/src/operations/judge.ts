// judge.* operations (ADR 0230, ADR 0234): Settings → AI's Judge section. The judge's key status
// and route, its per-placement switches, the adjudicator's reviewer, a Test call, the key itself,
// and spend per placement. Admin-only and human-only (`policy:manage`, as the adjudicator's
// settings), and never exposed to MCP: switching off a fail-closed placement, or removing the key
// the adjudicator's reviewer depends on, loosens approval, which only a human admin may do
// (AGENTS.md). Changes are audited like any write. Keys are never read, stored or returned here:
// the view says only where the key is (BYOK, a Worker secret, or none).
import { z } from "zod";
import {
  adjudicatorReviewer,
  loadAdjudicatorSettings,
  loadWrittenPolicy,
} from "../adjudicator/run.ts";
import { JUDGE_KEY_SECRET } from "../ai/admin.ts";
import { ConfigError, OperationError, ValidationError } from "../errors.ts";
import { JEV_MODEL, JEV_PRICE, judgeKeyStatus } from "../judge/jev.ts";
import { loadJudgeSettings } from "../judge/load.ts";
import {
  JUDGE_PLACEMENTS,
  type JudgePlacementId,
  SWITCHABLE_PLACEMENTS,
} from "../judge/placements.ts";
import { MAX_POLICY_RULES, policyRules } from "../judge/policy-rules.ts";
import { noul } from "../judge/questions.ts";
import { JUDGE_SETTINGS, type JudgeSettings, resolvePlacements } from "../judge/settings.ts";
import { failureOf, type JudgeFault, type JudgeUnavailable } from "../judge/types.ts";
import { judgeSpend } from "../judge/usage.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";

/** Spend in the view covers this many days. */
export const JUDGE_SPEND_DAYS = 30;

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
  /** Calls and spend over the last JUDGE_SPEND_DAYS days, from the judge's own count. */
  spend: z.object({ calls: z.number(), inputTokens: z.number(), costUsd: z.number() }),
});

const judgeView = z.object({
  /** The judge has a reachable key: every switched-on placement asks it. */
  on: z.boolean(),
  /** Where the key is, never the key. */
  keySource: z.enum(["byok", "secret"]).nullable(),
  viaGateway: z.boolean(),
  /** Where calls go when there is a key: the deployment's AI Gateway, or straight to TypeSafe. */
  route: z.enum(["gateway", "direct"]).nullable(),
  /** A hosted workspace: the key is a workspace secret and calls go straight to TypeSafe. */
  hosted: z.boolean(),
  /** A configuration problem (BYOK claimed without a gateway), when there is one. */
  problem: z.string().nullable(),
  /** Whether Settings → AI can store the key here, and if not, what is missing. */
  keyStore: z.object({
    available: z.boolean(),
    via: z.enum(["cloudflare", "control-plane"]).nullable(),
    missing: z.array(z.string()),
  }),
  model: z.string(),
  pricePerMillionInputTokensUsd: z.number(),
  spendDays: z.number(),
  placements: z.array(placementView),
  /** Who reviews for the policy adjudicator: Jev by default when the judge has a key. */
  adjudicatorReviewer: z.enum(["llm", "jev"]),
  /** The admin's choice (null: the default, Jev with a key). */
  adjudicatorReviewerSetting: z.enum(["llm", "jev"]).nullable(),
  /** The written policy's rules as the Jev reviewer reads them (count), and the most it takes. */
  policyRules: z.number().nullable(),
  maxPolicyRules: z.number(),
});

async function view(ctx: HandlerContext, settings: JudgeSettings) {
  const env = ctx.aiEnv ?? {};
  const key = judgeKeyStatus(env);
  const resolved = resolvePlacements(env.JUDGE_PLACEMENTS, settings);
  const adjudicator = await loadAdjudicatorSettings(ctx.db);
  const policy = await loadWrittenPolicy(ctx.db);
  const spend = new Map(
    (await judgeSpend(ctx.db, JUDGE_SPEND_DAYS, ctx.now)).map((s) => [s.placement, s]),
  );
  const status = ctx.aiAdmin?.status();
  const hosted = Boolean(env.AI_PLATFORM_GATEWAY_ID?.trim()) || Boolean(status?.hosted);
  const canStore = Boolean(ctx.aiAdmin?.setJudgeKey) && Boolean(status?.api);
  return {
    on: key.keySource !== null,
    keySource: key.keySource,
    viaGateway: key.viaGateway,
    route:
      key.keySource === null ? null : key.viaGateway ? ("gateway" as const) : ("direct" as const),
    hosted,
    problem: key.problem,
    keyStore: {
      available: canStore,
      via: canStore ? (hosted ? ("control-plane" as const) : ("cloudflare" as const)) : null,
      missing: canStore ? [] : (status?.missing ?? ["Settings → AI cannot reach Cloudflare"]),
    },
    model: JEV_MODEL,
    pricePerMillionInputTokensUsd: JEV_PRICE.inputPerMillionUsd,
    spendDays: JUDGE_SPEND_DAYS,
    placements: JUDGE_PLACEMENTS.map((p) => {
      const s = spend.get(p.id);
      return {
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
        spend: {
          calls: s?.calls ?? 0,
          inputTokens: s?.inputTokens ?? 0,
          costUsd: s?.costUsd ?? 0,
        },
      };
    }),
    adjudicatorReviewer: adjudicatorReviewer(adjudicator, key.keySource !== null),
    adjudicatorReviewerSetting: adjudicator.reviewer ?? null,
    policyRules: policy ? policyRules(policy.text).length : null,
    maxPolicyRules: MAX_POLICY_RULES,
  };
}

export const judgeGet = defineOperation({
  name: "judge.get",
  description:
    "The judge (Jev): whether it has a key, where the key is held and where calls go (never the " +
    "key), the pinned model, each placement with its switch, fail mode, the data it sends and its " +
    "spend over the last 30 days, and the policy adjudicator's reviewer. Admins only, people " +
    "only. Read-only.",
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

/** The Test button's question: a fixed sentence, no record content (placement `judge.test`). */
export const JUDGE_TEST_QUESTION = { greeting: noul("Is `word` a greeting?") };

export const judgeTest = defineOperation({
  name: "judge.test",
  description:
    "Make one live call to the judge with a fixed sentence (no CRM data) and report whether it " +
    "answered, how long it took and which model answered, or why it could not. Admins only, " +
    "people only.",
  input: z.object({}),
  output: z.object({
    ok: z.boolean(),
    model: z.string().nullable(),
    latencyMs: z.number(),
    /** Why it did not answer: a JudgeUnavailable reason or `fault`. */
    reason: z.string().nullable(),
    detail: z.string().nullable(),
  }),
  permission: "policy:manage",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(_input, ctx) {
    const started = Date.now();
    if (!ctx.judge) {
      return { ok: false, model: null, latencyMs: 0, reason: "off", detail: null };
    }
    const outcome = await ctx.judge.ask({
      placement: "judge.test",
      state: { word: "hello" },
      questions: JUDGE_TEST_QUESTION,
    });
    if (outcome.status === "answered") {
      return {
        ok: true,
        model: outcome.model,
        latencyMs: outcome.latencyMs || Date.now() - started,
        reason: null,
        detail: null,
      };
    }
    const failed = outcome as JudgeUnavailable | JudgeFault;
    return {
      ok: false,
      model: null,
      latencyMs: Date.now() - started,
      reason: failureOf(failed),
      // The judge's detail is redacted of every credential it sent (jev.ts).
      detail: failed.detail?.slice(0, 300) ?? null,
    };
  },
});

export const judgeSetKey = defineOperation({
  name: "judge.setKey",
  description:
    "Store or remove the judge's TypeSafe API key (admins): the Worker secret TYPESAFE_API_KEY on " +
    "ros-app and ros-runner through the Cloudflare API, or, on a hosted workspace, a workspace " +
    "secret set through the control plane. It takes effect within seconds. The key is never " +
    "written to the database, the audit log or any response. Removing it turns the judge off, " +
    "and the policy adjudicator falls back to the LLM reviewer unless it is set to Jev.",
  input: z.object({
    apiKey: z
      .string()
      .trim()
      .min(8)
      .max(4096)
      .nullable()
      .describe("The TypeSafe API key, or null to remove it"),
  }),
  output: z.object({ stored: z.boolean(), targets: z.array(z.string()) }),
  permission: "policy:manage",
  risk: "write",
  actors: ["human"],
  // `apiKey` already matches the pipeline's secret-name redaction; listed to be explicit.
  redact: ["apiKey"],
  mcp: { expose: false },
  auditSummary: (output) => output,
  async handler(input, ctx) {
    const admin = ctx.aiAdmin;
    if (!admin?.setJudgeKey || !admin.status().api) {
      throw new ConfigError(
        admin?.status().hosted
          ? `The control plane is not configured: ${admin.status().missing.join(", ")}`
          : "Storing the key needs CLOUDFLARE_ACCOUNT_ID and the CLOUDFLARE_API_TOKEN secret (docs/deploying.md), or set the TYPESAFE_API_KEY secret with wrangler",
      );
    }
    let targets: string[];
    try {
      ({ targets } = await admin.setJudgeKey(input.apiKey));
    } catch (error) {
      throw new OperationError(
        "config",
        `Could not ${input.apiKey === null ? "remove" : "store"} the key: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    ctx.recordChange({
      object: "ai_settings",
      id: `key:${JUDGE_KEY_SECRET}`,
      action: "update",
      // Whether a key is held, never the key.
      before: { keyStore: ctx.aiEnv?.TYPESAFE_API_KEY ? "secret" : null },
      after: { keyStore: input.apiKey === null ? null : "secret" },
    });
    return { stored: input.apiKey !== null, targets };
  },
});

export const judgeOperations = [judgeGet, judgeUpdate, judgeTest, judgeSetKey] as const;
