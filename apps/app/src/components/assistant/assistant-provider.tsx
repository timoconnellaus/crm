// The in-app assistant's app-wide state (ADR 0200): whether the Cmd-J panel is open, what it
// should start with ("Ask AI" on a record, "Ask about N selected", every "Ask the assistant"
// link), and the list selection a list page publishes so the assistant knows what "these" are.
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
  /** Start a new conversation rather than continuing the panel's current one. */
  fresh?: boolean;
}

interface AssistantState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** Opens the panel, optionally pre-filled and scoped. */
  ask: (options?: AskOptions) => void;
  /** The pending request from `ask`, consumed by the panel. */
  request: (AskOptions & { nonce: number }) | null;
  consumeRequest: () => void;
  /** The current page's record (record pages publish it). */
  record: AssistantRecord | null;
  setRecord: (record: AssistantRecord | null) => void;
  /** The current list selection (list pages publish it). */
  selection: AssistantSelection | null;
  setSelection: (selection: AssistantSelection | null) => void;
  /** The context sent with a turn: the page, its record and its selection. */
  pageContext: (overrides?: AskOptions) => AssistantContext;
}

const AssistantStateContext = createContext<AssistantState | null>(null);

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState<(AskOptions & { nonce: number }) | null>(null);
  const [record, setRecord] = useState<AssistantRecord | null>(null);
  const [selection, setSelection] = useState<AssistantSelection | null>(null);
  const location = useRouterState({ select: (s) => s.location });
  const nonce = useRef(0);
  const path = location.pathname;

  // A record or selection belongs to the page that published it.
  const lastPath = useRef(path);
  useEffect(() => {
    if (lastPath.current === path) return;
    lastPath.current = path;
    setSelection(null);
  }, [path]);

  const pageContext = useCallback(
    (overrides: AskOptions = {}): AssistantContext => {
      const rec = overrides.record ?? record ?? undefined;
      const sel = overrides.selection ?? selection ?? undefined;
      return {
        path: `${path}${typeof location.searchStr === "string" ? location.searchStr : ""}`.slice(
          0,
          500,
        ),
        ...(typeof document !== "undefined" && document.title
          ? { title: document.title.slice(0, 200) }
          : {}),
        ...(rec ? { record: rec } : {}),
        ...(sel?.ids.length ? { selection: sel } : {}),
      };
    },
    [path, location.searchStr, record, selection],
  );

  const value = useMemo<AssistantState>(
    () => ({
      open,
      setOpen,
      toggle: () => setOpen((o) => !o),
      ask: (options = {}) => {
        nonce.current += 1;
        setRequest({ ...options, nonce: nonce.current });
        setOpen(true);
      },
      request,
      consumeRequest: () => setRequest(null),
      record,
      setRecord,
      selection,
      setSelection,
      pageContext,
    }),
    [open, request, record, selection, pageContext],
  );
  return <AssistantStateContext.Provider value={value}>{children}</AssistantStateContext.Provider>;
}

export function useAssistant(): AssistantState {
  const value = useContext(AssistantStateContext);
  if (!value) throw new Error("useAssistant needs AssistantProvider");
  return value;
}

/** Outside the signed-in shell (or in tests) there is no assistant: returns null. */
export function useOptionalAssistant(): AssistantState | null {
  return useContext(AssistantStateContext);
}

/** Record pages call this so the assistant knows which record "this" is. */
export function usePublishRecord(record: AssistantRecord | null) {
  const assistant = useOptionalAssistant();
  const setRecord = assistant?.setRecord;
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
  const assistant = useOptionalAssistant();
  const setSelection = assistant?.setSelection;
  const key = selection ? `${selection.object}:${selection.ids.join(",")}` : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the selection's identity.
  useEffect(() => {
    if (!setSelection) return;
    setSelection(selection?.ids.length ? selection : null);
    return () => setSelection(null);
  }, [setSelection, key]);
}
