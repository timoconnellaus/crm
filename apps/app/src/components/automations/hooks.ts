// Data hooks for the automation and notification UI: every read and write of automation.* and
// notification.* lives here, so the shapes the pages consume are in one place.
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  callStageOp,
  type StageInput,
  type StageOutput,
  stageKey,
  useStageMutation,
  useStageOp,
} from "#/lib/automation-ops";
import { invalidateOps } from "#/lib/query";

export type AutomationList = StageOutput<"automation.list">;
export type AutomationItem = AutomationList["items"][number];
export type AutomationDetailData = StageOutput<"automation.get">;
export type RunData = StageOutput<"automation.runs">["items"][number];
export type NotificationData = StageOutput<"notification.list">["items"][number];

export function useAutomations() {
  return useStageOp("automation.list", {}, { refetchOnWindowFocus: true });
}

export function useAutomation(id: string) {
  return useStageOp("automation.get", { id }, { refetchOnWindowFocus: true });
}

/**
 * Enabled manual automations for an object: record-page buttons (`bulk` false or true) or list
 * bulk actions (`bulk` only). Failures (e.g. no automation operations yet) read as none.
 */
export function useManualAutomations(object: string, which: "record" | "bulk"): AutomationItem[] {
  const list = useStageOp(
    "automation.list",
    { manualFor: object },
    { staleTime: 60_000, retry: false },
  );
  return useMemo(
    () =>
      (list.data?.items ?? []).filter(
        (a) =>
          a.status === "active" &&
          !list.data?.killSwitch &&
          a.manual &&
          a.manual.object === object &&
          (which === "record" || a.manual.bulk),
      ),
    [list.data, object, which],
  );
}

type RunsInput = Omit<StageInput<"automation.runs">, "cursor">;

/** A paged list of runs (automation.runs), newest first. */
export function useRuns(input: RunsInput, options: { enabled?: boolean } = {}) {
  const query = useInfiniteQuery({
    queryKey: stageKey("automation.runs", input),
    queryFn: ({ pageParam }) =>
      callStageOp("automation.runs", { ...input, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
    ...(options.enabled === false ? { enabled: false } : {}),
  });
  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  return { query, items };
}

/** One run by id (run detail). */
export function useRun(runId: string | undefined) {
  return useStageOp(
    "automation.runs",
    { runId: runId ?? "", limit: 1, includeTests: true },
    {
      enabled: Boolean(runId),
      refetchInterval: (q) => (isLive(q.state.data?.items[0]) ? 5000 : false),
    },
  );
}

function isLive(run: RunData | undefined): boolean {
  return Boolean(run && ["queued", "running"].includes(run.status));
}

export function useSetEnabled() {
  return {
    enable: useStageMutation("automation.enable"),
    disable: useStageMutation("automation.disable"),
  };
}

/** Refetches every automation read (after a run starts, a retry, a replay). */
export function useRefreshAutomations() {
  const client = useQueryClient();
  return () => invalidateOps(client, "automation.");
}

// --- Notifications -----------------------------------------------------------------------------

/** The bell's unread count: polled every 60 s while the page is visible, and on focus. */
export function useUnreadCount() {
  return useStageOp(
    "notification.unreadCount",
    {},
    {
      refetchInterval: 60_000,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
      staleTime: 15_000,
      retry: false,
    },
  );
}

export function useNotifications(unreadOnly: boolean, limit = 30) {
  const input = { unreadOnly, limit };
  const query = useInfiniteQuery({
    queryKey: stageKey("notification.list", input),
    queryFn: ({ pageParam }) =>
      callStageOp("notification.list", { ...input, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchOnWindowFocus: true,
  });
  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  return { query, items };
}

/** Mark read: ids or all; refreshes the bell and every list. */
export function useMarkRead() {
  return useStageMutation("notification.markRead");
}
