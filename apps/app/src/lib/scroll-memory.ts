// Scroll positions per history entry, for the app's own scroll regions (the window never scrolls:
// see PageLayout). Going back to a list restores where you were; following a link to the same
// page afresh starts at the top, because each history entry has its own key.
//
//   const key = useScrollKey("people");      // "<history entry key>:people"
//   rememberScroll(key, element.scrollTop);
//   element.scrollTop = recallScroll(key) ?? 0;
import { useRouterState } from "@tanstack/react-router";
import { type RefObject, useEffect, useLayoutEffect } from "react";

const MAX_ENTRIES = 200;
const offsets = new Map<string, number>();

export function rememberScroll(key: string, offset: number): void {
  offsets.delete(key);
  offsets.set(key, offset);
  if (offsets.size > MAX_ENTRIES) {
    const oldest = offsets.keys().next().value;
    if (oldest !== undefined) offsets.delete(oldest);
  }
}

export function recallScroll(key: string): number | undefined {
  return offsets.get(key);
}

/** A key for `region` in the current history entry (stable across back/forward). */
export function useScrollKey(region: string): string {
  const entry = useRouterState({
    select: (s) =>
      (s.location.state as { __TSR_key?: string } | undefined)?.__TSR_key ?? s.location.href,
  });
  return `${entry}:${region}`;
}

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Remembers an element's scrollTop for the current history entry and restores it when the entry
 * is shown again. `ready` delays the restore until the content is tall enough (data loaded).
 */
export function useScrollMemory(
  ref: RefObject<HTMLElement | null>,
  region: string,
  { ready = true }: { ready?: boolean } = {},
): void {
  const key = useScrollKey(region);

  useIsomorphicLayoutEffect(() => {
    const element = ref.current;
    if (!element || !ready) return;
    element.scrollTop = recallScroll(key) ?? 0;
  }, [key, ready]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => rememberScroll(key, element.scrollTop));
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("scroll", onScroll);
    };
  }, [key, ref]);
}
