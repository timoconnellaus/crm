// Data hooks for the approval queue UI: the pending count behind the sidebar badge, record names
// for diff previews, and approve/reject as mutations that refresh everything they can change.
import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { callOp } from "#/lib/operations";
import { useOp } from "#/lib/query";
import { isProvisional, nameFromDiff, type PreviewEntry } from "./describe.ts";

/** Pending actions waiting for review, across every change set. Refreshed on focus. */
export function usePendingCount(): number | undefined {
  const list = useOp(
    "approval.list",
    { status: "awaiting_review", limit: 1 },
    { refetchOnWindowFocus: true, refetchInterval: 60_000, staleTime: 5_000 },
  );
  return list.data?.pendingCount;
}

/**
 * Display names for the records in `entries`: from each diff (creates, renames) and, for real
 * people and organisations, from their list operation (one call per object).
 */
export function useRecordNames(entries: readonly PreviewEntry[]): Map<string, string> {
  const fromDiff = useMemo(() => {
    const names = new Map<string, string>();
    for (const entry of entries) {
      const name = nameFromDiff(entry);
      if (name && !names.has(entry.id)) names.set(entry.id, name);
    }
    return names;
  }, [entries]);
  const idsOf = (object: string) =>
    [
      ...new Set(
        entries
          .filter((e) => e.object === object && !isProvisional(e.id) && !fromDiff.has(e.id))
          .map((e) => e.id),
      ),
    ].slice(0, 200);
  const people = idsOf("person");
  const orgs = idsOf("organisation");
  const personNames = useOp(
    "person.list",
    {
      filter: { field: "id", op: "in", value: people },
      fields: ["displayName"],
      limit: 200,
    },
    { enabled: people.length > 0 },
  );
  const orgNames = useOp(
    "organisation.list",
    {
      filter: { field: "id", op: "in", value: orgs },
      fields: ["name"],
      limit: 200,
    },
    { enabled: orgs.length > 0 },
  );
  return useMemo(() => {
    const names = new Map(fromDiff);
    for (const row of personNames.data?.items ?? []) {
      const name = (row as Record<string, unknown>).displayName;
      if (typeof name === "string") names.set(row.id, name);
    }
    for (const row of orgNames.data?.items ?? []) {
      const name = (row as Record<string, unknown>).name;
      if (typeof name === "string") names.set(row.id, name);
    }
    return names;
  }, [fromDiff, personNames.data, orgNames.data]);
}

/** Refetches everything after a decision: applying can change any record, list or timeline. */
export function useRefreshAfterDecision() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: ["op"] });
}

/**
 * Approve or reject by tap: a whole change set, or chosen actions. `confirm` is the second button's
 * words, for high-risk items (ADR 0345): the server refuses them without it.
 */
export async function decide(
  decision: "approve" | "reject",
  target: { changeSetId: string } | { actionIds: string[] },
  confirm?: string,
) {
  const out = await callOp("approval.decide", {
    ...target,
    decision,
    via: "tap",
    ...(confirm ? { confirm } : {}),
  });
  if (out.status !== "decided") throw new Error(out.message);
  return out;
}
