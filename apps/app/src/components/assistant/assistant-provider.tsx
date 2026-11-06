// The in-app assistant's app-wide state (ADR 0030, ADR 0200): whether the panel is open (docked
// beside the page on tablets and desktops, a sheet on phones), what it should start with ("Ask
// AI" on a record, "Ask about N selected", every "Ask the assistant" link), and the page context
// pages publish (their record, the list selection) so the assistant knows what "this" and "these"
// are.
//
// Two contexts, so most of the app subscribes narrowly: the actions (ask, toggle, publish a
// record or selection) never change, so entry-point buttons and record pages do not re-render
// when the panel opens or the page context changes. The thread itself, and its streaming,
// lives in ThreadProvider, never here.
import type { AssistantContext } from "@relationship-os/core/client";
import { useRouterState } from "@tanstack/react-router";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { pageLabel, readDockOpen, writeDockOpen } from "./dock-state.ts";

export type AssistantSelection = NonNullable<AssistantContext["selection"]>;
export type AssistantRecord = NonNullable<AssistantContext["record"]>;

export interface AskOptions {
  /** Text to put in the composer (not sent until the person sends it). */
  prompt?: string;
  /** Send `prompt` straight away. */
  send?: boolean;
  /** Scope the question to this record (otherwise the page's record, if any). */
  record?: AssistantRecord;
  /** Scope the question to these records (otherwise the list's selection, if any). */
  selection?: AssistantSelection;
}

export interface AssistantActions {
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** Opens the panel, optionally pre-filled and scoped. */
  ask: (options?: AskOptions) => void;
  consumeRequest: () => void;
  setRecord: (record: AssistantRecord | null) => void;
  setSelection: (selection: AssistantSelection | null) => void;
}

export interface AssistantState extends AssistantActions {
  open: boolean;
  /**
   * Bumped each time the person opens the panel (Cmd-J, the header button, "Ask AI"), so the
   * panel moves focus into its composer. A panel reopened from the last visit (remembered per
   * browser) does not take focus from the page.
   */
  focusRequest: number;
  /** The pending request from `ask`, consumed by the panel. */
  request: (AskOptions & { nonce: number }) | null;
  /** The current page's record (record pages publish it). */
  record: AssistantRecord | null;
  /** The current list selection (list pages publish it). */
  selection: AssistantSelection | null;
  /** The current page's path (with its search string). */
  path: string;
  /** The context sent with a turn: the page, its record and its selection. */
  pageContext: (overrides?: AskOptions) => AssistantContext;
}

/** The docked panel's element id (its toggle buttons point at it with aria-controls). */
export const PANEL_ID = "assistant-panel";

const ActionsContext = createContext<AssistantActions | null>(null);
const StateContext = createContext<AssistantState | null>(null);

/** Phones get a sheet, not a dock; their open state is not remembered. */
function isPhone(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
}

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [open, setOpenState] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const [request, setRequest] = useState<(AskOptions & { nonce: number }) | null>(null);
  const [record, setRecord] = useState<AssistantRecord | null>(null);
  const [selection, setSelection] = useState<AssistantSelection | null>(null);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const searchStr = useRouterState({ select: (s) => s.location.searchStr });
  const nonce = useRef(0);
  const openRef = useRef(open);
  openRef.current = open;
  // Where focus was when the person opened the panel, to give it back when they close it.
  const returnFocus = useRef<HTMLElement | null>(null);

  // The docked panel comes back as it was left, per browser (not on phones: a full-screen sheet
  // popping up on load would hide the page).
  useEffect(() => {
    if (!isPhone() && readDockOpen()) setOpenState(true);
  }, []);

  // A record or selection belongs to the page that published it.
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (lastPath.current === pathname) return;
    lastPath.current = pathname;
    setSelection(null);
  }, [pathname]);

  const actions = useMemo<AssistantActions>(() => {
    const setOpen = (next: boolean) => {
      if (next && !openRef.current) {
        setFocusRequest((n) => n + 1);
        const active = document.activeElement;
        returnFocus.current =
          active instanceof HTMLElement &&
          active !== document.body &&
          !active.closest(`#${PANEL_ID}`)
            ? active
            : null;
      }
      if (!next && openRef.current && document.activeElement?.closest(`#${PANEL_ID}`)) {
        // The docked panel unmounts with focus inside it: hand focus back to where it came from.
        const target = returnFocus.current;
        requestAnimationFrame(() => {
          if (document.activeElement && document.activeElement !== document.body) return;
          const fallback = document.getElementById("main");
          (target?.isConnected ? target : fallback)?.focus({ preventScroll: true });
        });
      }
      openRef.current = next;
      setOpenState(next);
      if (!isPhone()) writeDockOpen(next);
    };
    return {
      setOpen,
      toggle: () => setOpen(!openRef.current),
      ask: (options = {}) => {
        nonce.current += 1;
        setRequest({ ...options, nonce: nonce.current });
        if (openRef.current) setFocusRequest((n) => n + 1);
        setOpen(true);
      },
      consumeRequest: () => setRequest(null),
      setRecord,
      setSelection,
    };
  }, []);

  const path = `${pathname}${typeof searchStr === "string" ? searchStr : ""}`.slice(0, 500);
  const pageContext = useCallback(
    (overrides: AskOptions = {}): AssistantContext => {
      const rec = overrides.record ?? record ?? undefined;
      const sel = overrides.selection ?? selection ?? undefined;
      return {
        path,
        title: pageLabel(pathname).slice(0, 200),
        ...(rec ? { record: rec } : {}),
        ...(sel?.ids.length ? { selection: sel } : {}),
      };
    },
    [path, pathname, record, selection],
  );

  const state = useMemo<AssistantState>(
    () => ({
      ...actions,
      open,
      focusRequest,
      request,
      record,
      selection,
      path,
      pageContext,
    }),
    [actions, open, focusRequest, request, record, selection, path, pageContext],
  );
  return (
    <ActionsContext.Provider value={actions}>
      <StateContext.Provider value={state}>{children}</StateContext.Provider>
    </ActionsContext.Provider>
  );
}

/** Everything, for the panel and the header button. Re-renders when the page context changes. */
export function useAssistant(): AssistantState {
  const value = useContext(StateContext);
  if (!value) throw new Error("useAssistant needs AssistantProvider");
  return value;
}

/**
 * The stable actions (ask, toggle, publish), for entry points. Outside the signed-in shell (or in
 * tests) there is no assistant: returns null.
 */
export function useOptionalAssistant(): AssistantActions | null {
  return useContext(ActionsContext);
}

/** Record pages call this so the assistant knows which record "this" is. */
export function usePublishRecord(record: AssistantRecord | null) {
  const setRecord = useOptionalAssistant()?.setRecord;
  const key = record ? `${record.object}:${record.id}:${record.label ?? ""}` : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the record's identity.
  useEffect(() => {
    if (!setRecord) return;
    setRecord(record);
    return () => setRecord(null);
  }, [setRecord, key]);
}

/** List pages call this with their selection so "these" means the selected rows. */
export function usePublishSelection(selection: AssistantSelection | null) {
  const setSelection = useOptionalAssistant()?.setSelection;
  const key = selection ? `${selection.object}:${selection.ids.join(",")}` : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the selection's identity.
  useEffect(() => {
    if (!setSelection) return;
    setSelection(selection?.ids.length ? selection : null);
    return () => setSelection(null);
  }, [setSelection, key]);
}
