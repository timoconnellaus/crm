// adjudicator.* operations (ADR 0031, ADR 0204): the policy adjudicator's settings (mode off /
// shadow / active, confidence threshold), the org's written policy, and the agreement rate of its
// verdicts with people's decisions. All of it is admin-only and human-only: no AI, MCP client,
// automation or extension can read verdicts, loosen the adjudicator or rewrite the policy it
// judges by. Changes are audited like any write.
import { z } from "zod";
import { computeAgreement } from "../adjudicator/agreement.ts";
import { ADJUDICATOR_MODES } from "../adjudicator/judge.ts";
import {
  ADJUDICATOR_SETTING,
  type AdjudicatorSettings,
  DEFAULT_THRESHOLD,
  loadAdjudicatorSettings,
  loadAgreementRows,
  loadWrittenPolicy,
  sha256Hex,
} from "../adjudicator/run.ts";
import { ValidationError } from "../errors.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";

const modeSchema = z.enum(ADJUDICATOR_MODES);
const thresholdSchema = z
  .number()
  .min(0.5)
  .max(1)
  .describe("Verdicts below this confidence go to a person (0.5–1)");

const roleRef = z.object({ provider: z.string(), model: z.string() });

const settingsOutput = z.object({
  mode: modeSchema,
  threshold: z.number(),
  enabledAt: z.string().nullable(),
  policy: z
    .object({
      version: z.number(),
      text: z.string(),
      hash: z.string(),
      createdAt: z.string(),
      createdBy: z.string(),
      createdByName: z.string().nullable(),
    })
    .nullable(),
  /** The models behind the `review` and `assistant` roles, when the deployment has AI. */
  models: z.object({ review: roleRef, assistant: roleRef }).nullable(),
  /**
   * ADR 0031 wants the reviewer independent of the actor: true when `review` resolves to the
   * same provider and model as `assistant`. A warning, not a block.
   */
  sameModelAsAssistant: z.boolean(),
});

async function settingsView(ctx: HandlerContext, settings: AdjudicatorSettings) {
  const policy = await loadWrittenPolicy(ctx.db);
  const author = policy
    ? await ctx.db
        .selectFrom("core_user")
        .select("name")
        .where("id", "=", policy.createdBy)
        .executeTakeFirst()
    : undefined;
  let models: z.infer<typeof settingsOutput>["models"] = null;
  try {
    const roles = await ctx.models?.roles?.();
    if (roles) {
      models = {
        review: { provider: roles.review.provider, model: roles.review.model },
        assistant: { provider: roles.assistant.provider, model: roles.assistant.model },
      };
    }
  } catch {
    models = null;
  }
  return {
    mode: settings.mode,
    threshold: settings.threshold,
    enabledAt: settings.enabledAt,
    policy: policy ? { ...policy, createdByName: author?.name ?? null } : null,
    models,
    sameModelAsAssistant: Boolean(
      models &&
        models.review.provider === models.assistant.provider &&
        models.review.model === models.assistant.model,
    ),
  };
}

export const adjudicatorGet = defineOperation({
  name: "adjudicator.get",
  description:
    "The policy adjudicator's settings (mode off, shadow or active; confidence threshold), the " +
    "written policy in force, and the models behind the review and assistant roles. Admins " +
    "only, people only. Read-only.",
  input: z.object({}),
  output: settingsOutput,
  permission: "policy:manage",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(_input, ctx) {
    return settingsView(ctx, await loadAdjudicatorSettings(ctx.db));
  },
});

export const adjudicatorUpdate = defineOperation({
  name: "adjudicator.update",
  description:
    "Change the policy adjudicator's mode or confidence threshold. Switching it on from off " +
    "starts in shadow mode (verdicts recorded, nothing acted on); only then can an admin switch " +
    "it to active, where approve verdicts at or above the threshold apply without a person. " +
    "Needs a written policy. Admins only, people only.",
  input: z
    .object({ mode: modeSchema.optional(), threshold: thresholdSchema.optional() })
    .refine((v) => v.mode !== undefined || v.threshold !== undefined, {
      message: "Pass mode, threshold or both",
    }),
  output: settingsOutput,
  permission: "policy:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const before = await loadAdjudicatorSettings(ctx.db);
    const mode = input.mode ?? before.mode;
    if (before.mode === "off" && mode === "active") {
      throw new ValidationError(
        "Switch the adjudicator on in shadow mode first, and review its agreement rate before making it active",
        { field: "mode", from: before.mode, to: mode },
      );
    }
    if (mode !== "off" && !(await loadWrittenPolicy(ctx.db))) {
      throw new ValidationError("Write the policy the adjudicator judges by first", {
        field: "policy",
      });
    }
    const after: AdjudicatorSettings = {
      mode,
      threshold: input.threshold ?? before.threshold ?? DEFAULT_THRESHOLD,
      enabledAt: before.mode === "off" && mode !== "off" ? ctx.now : before.enabledAt,
    };
    const value = JSON.stringify(after);
    ctx.write(
      ctx.db
        .insertInto("core_settings")
        .values({ key: ADJUDICATOR_SETTING, value, updated_at: ctx.now, updated_by: ctx.user.id })
        .onConflict((oc) =>
          oc.column("key").doUpdateSet({ value, updated_at: ctx.now, updated_by: ctx.user.id }),
        ),
    );
    ctx.recordChange({
      object: "settings",
      id: ADJUDICATOR_SETTING,
      action: "update",
      before: { mode: before.mode, threshold: before.threshold },
      after: { mode: after.mode, threshold: after.threshold },
    });
    return settingsView(ctx, after);
  },
});

export const POLICY_MAX_CHARS = 20_000;

export const adjudicatorSetPolicy = defineOperation({
  name: "adjudicator.setPolicy",
  description:
    "Replace the org's written policy: the plain-language rules the policy adjudicator judges " +
    "pending changes against. Each save is a new version; verdicts record the version they " +
    "used. Admins only, people only.",
  input: z.object({
    text: z
      .string()
      .trim()
      .min(1)
      .max(POLICY_MAX_CHARS)
      .describe("The written policy, plain text or Markdown"),
  }),
  output: settingsOutput,
  permission: "policy:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const before = await loadWrittenPolicy(ctx.db);
    const hash = await sha256Hex(input.text);
    const version = (before?.version ?? 0) + 1;
    if (before?.hash !== hash) {
      ctx.write(
        ctx.db.insertInto("core_written_policy").values({
          version,
          text: input.text,
          hash,
          created_at: ctx.now,
          created_by: ctx.user.id,
        }),
      );
      ctx.recordChange({
        object: "settings",
        id: "written_policy",
        action: "update",
        before: before ? { version: before.version, hash: before.hash } : {},
        after: { version, hash },
      });
    }
    const view = await settingsView(ctx, await loadAdjudicatorSettings(ctx.db));
    return before?.hash === hash
      ? view
      : {
          ...view,
          policy: {
            version,
            text: input.text,
            hash,
            createdAt: ctx.now,
            createdBy: ctx.user.id,
            createdByName: ctx.user.name,
          },
        };
  },
});

const cell = z.object({ approved: z.number(), rejected: z.number(), undecided: z.number() });

export const adjudicatorAgreement = defineOperation({
  name: "adjudicator.agreement",
  description:
    "How the policy adjudicator's verdicts compare with people's decisions on the same pending " +
    "actions over the last `days` days: agreement rate, approve precision, escalation rate, " +
    "the verdict × decision confusion matrix, and the same by day or week. Admins only, " +
    "people only. Read-only.",
  input: z.object({
    days: z.number().int().min(1).max(365).default(30),
    bucket: z.enum(["day", "week"]).default("day"),
  }),
  output: z.object({
    from: z.string(),
    to: z.string(),
    count: z.number(),
    decided: z.number(),
    agreement: z.number().nullable(),
    approvePrecision: z.number().nullable(),
    escalationRate: z.number().nullable(),
    autoApproved: z.number(),
    confusion: z.object({ approve: cell, deny: cell, escalate: cell }),
    periods: z.array(
      z.object({
        period: z.string(),
        count: z.number(),
        decided: z.number(),
        agreed: z.number(),
        agreement: z.number().nullable(),
      }),
    ),
    /** True when more verdicts fell in the window than were read (5,000). */
    capped: z.boolean(),
  }),
  permission: "policy:manage",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const to = ctx.now;
    const from = new Date(Date.parse(ctx.now) - input.days * 86_400_000).toISOString();
    const limit = 5000;
    const rows = await loadAgreementRows(ctx.db, from, to, limit + 1);
    const report = computeAgreement(rows.slice(0, limit), { bucket: input.bucket });
    return { from, to, ...report, capped: rows.length > limit };
  },
});

export const adjudicatorOperations = [
  adjudicatorGet,
  adjudicatorUpdate,
  adjudicatorSetPolicy,
  adjudicatorAgreement,
] as const;
