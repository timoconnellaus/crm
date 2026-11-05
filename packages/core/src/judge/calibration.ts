// Calibration records (ADR 0231): every judge question ships with a record of the labelled run
// that set its threshold, keyed by a hash of its wording and shape and the model. A unit test
// hashes every calibrated question and fails where its current hash has no record, so a reworded
// question cannot ship uncalibrated. `pnpm eval:calibrate` (evals/judge) writes the records.
import calibration from "./calibration.json" with { type: "json" };
import { JEV_MODEL } from "./jev.ts";
import type { Question } from "./types.ts";

export interface CalibrationRecord {
  /** SHA-256 of the canonical JSON of `{ model, question }`. */
  hash: string;
  model: string;
  /** The threshold the run judged its cases against (the constant beside the question). */
  threshold: number;
  /** The label whose probability is held to the threshold (a choice's fault label, or `noul`). */
  label: string;
  cases: number;
  right: number;
  wrong: number;
  close: number;
  unanswered: number;
  /** Close calls by case name: medians within the close-call band of the threshold. */
  closeCalls: string[];
  /** The highest median of a case labelled below, and its distance under the threshold. */
  highestBelow: number | null;
  belowGap: number | null;
  /** The lowest median of a case labelled above, and its distance over the threshold. */
  lowestAbove: number | null;
  aboveGap: number | null;
  runs: number;
  /** live (recorded now) or replayed (from committed recordings). */
  mode: string;
  date: string;
}

export interface CalibrationFile {
  $comment?: string;
  questions: Record<string, CalibrationRecord>;
}

export const CALIBRATION = calibration as CalibrationFile;

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sorted(record[key])]),
    );
  }
  return value;
}

/** JSON with every object's keys sorted, so one value always gives one text. */
export const canonicalJson = (value: unknown): string => JSON.stringify(sorted(value));

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The hash a calibration record is kept under: the question's wording and shape, and the model. */
export function questionHash(question: Question, model: string = JEV_MODEL): Promise<string> {
  return sha256Hex(canonicalJson({ model, question }));
}

/** The record for a question as it is worded now, or null when it has none. */
export async function calibrationFor(
  key: string,
  question: Question,
  file: CalibrationFile = CALIBRATION,
): Promise<CalibrationRecord | null> {
  const record = file.questions[key];
  if (!record) return null;
  return record.hash === (await questionHash(question, record.model)) && record.model === JEV_MODEL
    ? record
    : null;
}
