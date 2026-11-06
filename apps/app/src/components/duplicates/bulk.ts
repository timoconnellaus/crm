// Bulk merge from the Duplicates page (stage 16, ADR 0247). The page sends the selected groups to
// duplicate.mergeMany a few at a time, so a person sees progress and each call stays well inside
// a Worker's limits; every merge inside still runs through person.merge / organisation.merge.
import type { CoreOutput } from "@relationship-os/core";
import { callOp } from "#/lib/operations";

export interface MergeGroup {
  survivorId: string;
  mergedIds: string[];
}

export interface MergeFailure {
  id: string;
  message: string;
}

export interface BulkProgress {
  done: number;
  total: number;
}

export interface BulkResult {
  merged: number;
  queued: number;
  failed: MergeFailure[];
}

const GROUPS_PER_CALL = 10;
const RECORDS_PER_CALL = 40;

/** Splits groups into calls of at most 10 groups and about 40 records. */
export function mergeBatches(groups: readonly MergeGroup[]): MergeGroup[][] {
  const batches: MergeGroup[][] = [];
  let current: MergeGroup[] = [];
  let records = 0;
  for (const group of groups) {
    const size = group.mergedIds.length + 1;
    if (current.length && (current.length >= GROUPS_PER_CALL || records + size > RECORDS_PER_CALL)) {
      batches.push(current);
      current = [];
      records = 0;
    }
    current.push(group);
    records += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

type MergeMany = CoreOutput<"duplicate.mergeMany">;

function addOutcome(result: BulkResult, out: MergeMany) {
  result.merged += out.merged;
  result.queued += out.queued;
  for (const r of out.results) {
    for (const f of r.failed) result.failed.push({ id: f.id, message: f.message });
  }
}

/** Merges the groups in batches. A call that fails is listed; the next batches still run. */
export async function runBulkMerge(
  object: "person" | "organisation",
  groups: readonly MergeGroup[],
  onProgress: (progress: BulkProgress) => void,
): Promise<BulkResult> {
  const total = groups.reduce((n, g) => n + g.mergedIds.length, 0);
  const result: BulkResult = { merged: 0, queued: 0, failed: [] };
  let done = 0;
  onProgress({ done, total });
  for (const batch of mergeBatches(groups)) {
    try {
      addOutcome(result, await callOp("duplicate.mergeMany", { object, groups: batch }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Something went wrong";
      for (const id of batch.flatMap((g) => g.mergedIds)) result.failed.push({ id, message });
    }
    done += batch.reduce((n, g) => n + g.mergedIds.length, 0);
    onProgress({ done, total });
  }
  return result;
}
