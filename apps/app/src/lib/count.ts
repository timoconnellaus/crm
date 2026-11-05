// List totals (record.count). A count reads every matching row (up to the operation's cap), so it
// is fetched once per object + filter and kept: it is cached under the object's list operation
// (`["op", "person.list", "count", …]`), so the invalidation every write already does for
// "person." refreshes it, and nothing else does. Scrolling never recounts.
import type { Filter } from "@relationship-os/core/client";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { callOp } from "./operations.ts";

const CORE_LISTS: Record<string, string> = {
  person: "person.list",
  organisation: "organisation.list",
  task: "task.list",
  activity: "activity.list",
};

/** The list operation whose cache entries a count of `object` lives with. */
export function listOperationOf(object: string): string {
  return CORE_LISTS[object] ?? "record.list";
}

export function countQueryOptions(object: string, filter: Filter | undefined) {
  return queryOptions({
    queryKey: ["op", listOperationOf(object), "count", object, filter ?? null] as const,
    queryFn: () => callOp("record.count", { object, ...(filter ? { filter } : {}) }),
    staleTime: 5 * 60_000,
    // Keep the last total on screen while a new filter is counted.
    placeholderData: (previous) => previous,
  });
}

/** The live total of `object` records matching `filter`. */
export function useRecordCount(object: string, filter: Filter | undefined) {
  return useQuery(countQueryOptions(object, filter));
}
