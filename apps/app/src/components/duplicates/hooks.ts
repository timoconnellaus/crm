// Duplicates hooks (stage 16): the sidebar's count of open pairs.
import { useOp } from "#/lib/query";

/** Open duplicate pairs awaiting review (people and organisations). */
export function useDuplicateCount(): number | undefined {
  const count = useOp("duplicate.count", {}, { refetchInterval: 300_000, staleTime: 60_000 });
  return count.data?.total;
}
