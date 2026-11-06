// The second step, on the server (ADR 0345): which pending actions need it, under the
// `approvals.phraseThreshold.email` setting. An approval that skipped it is refused here, so the
// Approvals inbox and a direct `approval.approve` cannot get round what the card asks for.
import type { CoreDatabase } from "@relationship-os/db";
import type { Kysely } from "kysely";
import { z } from "zod";
import { OperationError } from "../errors.ts";
import type { OutboundInput } from "../integrations/outbound.ts";
import { actionTitle, outboundTitle, type PreviewEntry, verbOf } from "./describe.ts";
import { DEFAULT_PHRASE_THRESHOLD, type SecondStep, secondStep } from "./high-risk.ts";
import { titlesFor } from "./simulation.ts";

/** The setting: sends above this many recipients need the second step. */
export const PHRASE_THRESHOLD_SETTING = "approvals.phraseThreshold.email";

export const phraseThresholdSchema = z.number().int().min(1).max(100_000);

export async function loadPhraseThreshold(db: Kysely<CoreDatabase>): Promise<number> {
  const row = await db
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", PHRASE_THRESHOLD_SETTING)
    .executeTakeFirst();
  if (!row) return DEFAULT_PHRASE_THRESHOLD;
  try {
    return phraseThresholdSchema.parse(JSON.parse(row.value));
  } catch {
    return DEFAULT_PHRASE_THRESHOLD;
  }
}

/** What this reads of a pending action. */
export interface StepAction {
  id: string;
  operation: string;
  risk: string;
  input: unknown;
  preview: readonly PreviewEntry[];
  /** Set for gatekeeper actions. */
  outbound: unknown;
}

/** The one record a destructive action touches, to name it. */
function onlyRecord(preview: readonly PreviewEntry[]): { object: string; id: string } | null {
  const own = new Set(preview.map((p) => `${p.object}:${p.id}`));
  const [first] = preview;
  return own.size === 1 && first ? { object: first.object, id: first.id } : null;
}

/** Each action's second step (null: one tap). Reads names only for destructive actions. */
export async function secondSteps(
  db: Kysely<CoreDatabase>,
  rows: readonly StepAction[],
  threshold: number,
): Promise<Map<string, SecondStep | null>> {
  const single = new Map<string, { object: string; id: string }>();
  for (const row of rows) {
    if (row.risk !== "destructive") continue;
    const record = onlyRecord(row.preview);
    if (record) single.set(row.id, record);
  }
  const names = single.size
    ? await titlesFor(db, [...single.values()], undefined)
    : new Map<string, string>();
  const out = new Map<string, SecondStep | null>();
  for (const row of rows) {
    if (row.risk !== "destructive" && row.risk !== "outbound") {
      out.set(row.id, null);
      continue;
    }
    const input = (row.input ?? {}) as Partial<OutboundInput>;
    const record = single.get(row.id);
    const name = record ? names.get(`${record.object}:${record.id}`) : undefined;
    const title =
      row.outbound
        ? outboundTitle(input)
        : name
          ? `${verbOf(row.operation)} ${name}`
          : actionTitle(row.operation, row.preview, input);
    out.set(
      row.id,
      secondStep(
        {
          risk: row.risk,
          title,
          outbound: row.outbound ? { fields: input.fields ?? [] } : null,
        },
        threshold,
      ),
    );
  }
  return out;
}

/** The approval needs its second step: the card's second press, or the exact phrase. */
export class SecondStepRequiredError extends OperationError {
  override name = "SecondStepRequiredError";
  constructor(step: SecondStep) {
    super(
      "second_step_required",
      `This needs a second step. Press "${step.confirmLabel}", or type or say: ${step.phrase}`,
      { ...step },
    );
  }
}
