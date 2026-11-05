// The Deals tools. They become operations x.deals.<tool>, run in the sandbox, and call the CRM
// only through ctx.crm (here read-only SQL over the crm_* views and stage history).
import { defineTool, z } from "@relationship-os/sdk";

interface SqlResult {
  rows: Record<string, unknown>[];
}

const num = (value: unknown) =>
  typeof value === "number" ? value : value == null ? null : Number(value);

/** Per-stage time in stage and counts, from stage history. */
const STAGE_SQL = `
SELECT h.stage_id AS stage_id, s.name AS stage, s.position AS position, s.type AS type,
  count(*) AS entered,
  sum(CASE WHEN h.left_at IS NULL THEN 1 ELSE 0 END) AS current,
  sum(CASE WHEN h.left_at IS NOT NULL THEN 1 ELSE 0 END) AS moved_on,
  avg(CASE WHEN h.left_at IS NOT NULL THEN h.days_in_stage END) AS avg_days_completed,
  avg(h.days_in_stage) AS avg_days
FROM crm_stage_history h
JOIN crm_x_deals_stage s ON s.id = h.stage_id
JOIN crm_x_deals_deal d ON d.id = h.record_id
WHERE h.object_type = 'deals.deal'
  AND s.pipeline = ?
  AND (? IS NULL OR h.entered_at >= ?)
GROUP BY h.stage_id, s.name, s.position, s.type
ORDER BY s.position, s.name`;

/** Won deals of the pipeline: how many, how long from first stage to won, and their value. */
const VELOCITY_SQL = `
SELECT count(*) AS won, avg(julianday(w.entered_at) - julianday(f.first_entered)) AS avg_days_to_win,
  coalesce(sum(d.value), 0) AS won_value
FROM crm_stage_history w
JOIN (
  SELECT record_id, min(entered_at) AS first_entered FROM crm_stage_history
  WHERE object_type = 'deals.deal' GROUP BY record_id
) f ON f.record_id = w.record_id
JOIN crm_x_deals_deal d ON d.id = w.record_id
WHERE w.object_type = 'deals.deal' AND w.stage_type = 'won' AND w.left_at IS NULL
  AND d.pipeline = ?
  AND (? IS NULL OR w.entered_at >= ?)`;

const round = (value: number | null) => (value === null ? null : Math.round(value * 100) / 100);

export const stageMetrics = defineTool({
  description:
    "Time in stage and velocity for a deal pipeline, from stage history: for each stage how many " +
    "deals entered it, how many are in it now, and the average days deals spent in it; and for " +
    "won deals how many were won, the average days from entering the pipeline to being won, and " +
    "their total value. Optionally only stage entries since a date. Read-only.",
  risk: "read",
  input: z.object({
    pipelineId: z.string().min(1).describe("The pipeline (deals.pipeline record id)"),
    since: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}/)
      .optional()
      .describe("Only count stage entries on or after this date (YYYY-MM-DD)"),
  }),
  output: z.object({
    pipelineId: z.string(),
    stages: z.array(
      z.object({
        stageId: z.string(),
        stage: z.string(),
        type: z.string(),
        entered: z.number(),
        current: z.number(),
        avgDaysInStage: z.number().nullable(),
        avgDaysBeforeMovingOn: z.number().nullable(),
      }),
    ),
    velocity: z.object({
      won: z.number(),
      avgDaysToWin: z.number().nullable(),
      wonValue: z.number(),
    }),
  }),
  async handler({ pipelineId, since }, ctx) {
    const params = [pipelineId, since ?? null, since ?? null];
    const stages = await ctx.crm.call<SqlResult>("query.sql", { sql: STAGE_SQL, params });
    const velocity = await ctx.crm.call<SqlResult>("query.sql", { sql: VELOCITY_SQL, params });
    const v = velocity.rows[0] ?? {};
    ctx.log.info("stage metrics", { pipelineId, stages: stages.rows.length });
    return {
      pipelineId,
      stages: stages.rows.map((row) => ({
        stageId: String(row.stage_id),
        stage: String(row.stage),
        type: String(row.type),
        entered: num(row.entered) ?? 0,
        current: num(row.current) ?? 0,
        avgDaysInStage: round(num(row.avg_days)),
        avgDaysBeforeMovingOn: round(num(row.avg_days_completed)),
      })),
      velocity: {
        won: num(v.won) ?? 0,
        avgDaysToWin: round(num(v.avg_days_to_win)),
        wonValue: num(v.won_value) ?? 0,
      },
    };
  },
});
