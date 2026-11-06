// How the Duplicates page splits a bulk merge into duplicate.mergeMany calls (ADR 0247).
export interface MergeGroup {
  survivorId: string;
  mergedIds: string[];
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
    if (
      current.length &&
      (current.length >= GROUPS_PER_CALL || records + size > RECORDS_PER_CALL)
    ) {
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
