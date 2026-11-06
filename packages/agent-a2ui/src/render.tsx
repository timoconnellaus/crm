// The A2UI renderer (ADR 0346): a host passes a component map (its own components, one per
// catalogue type) and an action handler (which runs operations with the viewer's permissions).
// The renderer validates the card first. An invalid card, a type the host has no renderer for,
// or a renderer that throws shows the card's text fallback instead: nothing is rendered blindly.
import {
  Component,
  createContext,
  type ErrorInfo,
  type ComponentType as ReactComponentType,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import type { ComponentType, PropsOf } from "./catalogue.ts";
import {
  type A2uiDocument,
  type A2uiNode,
  type A2uiPart,
  type A2uiSource,
  validateDocument,
} from "./document.ts";
import type { A2uiAction, FormSubmit } from "./schema.ts";

/** What an action did, for the button to show. */
export type ActionResult = { ok: true; message?: string } | { ok: false; message: string };

export interface ActionContext {
  /** Who wrote the card. */
  source: A2uiSource;
  /** The component the action belongs to. */
  node: A2uiNode;
}

/**
 * Runs an action. `extra` is input the component adds (a form's values, a picked slot); for an
 * operation action the host merges it into the action's input. The host calls the operation as
 * the viewer, so the gate, change sets and approvals apply as anywhere else.
 */
export type ActionHandler = (
  action: A2uiAction,
  extra: Record<string, unknown> | undefined,
  context: ActionContext,
) => Promise<ActionResult>;

export interface RendererProps<T extends ComponentType> {
  props: PropsOf<T>;
  node: A2uiNode;
  /** The rendered children (card and stack). */
  children: ReactNode;
}

export type ComponentMap = {
  [T in ComponentType]?: ReactComponentType<RendererProps<T>>;
};

/** Shows a card's text fallback. Hosts may pass their own. */
export type FallbackComponent = ReactComponentType<{ text: string; problems?: string[] }>;

interface A2uiRuntime {
  source: A2uiSource;
  components: ComponentMap;
  onAction: ActionHandler;
}

const RuntimeContext = createContext<A2uiRuntime | null>(null);
const NodeContext = createContext<A2uiNode | null>(null);

function DefaultFallback({ text }: { text: string; problems?: string[] }) {
  return (
    <p data-a2ui-fallback="" style={{ whiteSpace: "pre-wrap" }}>
      {text}
    </p>
  );
}

class Boundary extends Component<
  { fallback: ReactNode; children: ReactNode; onError?: ((error: Error) => void) | undefined },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: Error, _info: ErrorInfo) {
    this.props.onError?.(error);
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Every type in the tree, to check the host can render all of them before trying. */
function typesIn(node: A2uiNode, out = new Set<string>()): Set<string> {
  out.add(node.type);
  if (Array.isArray(node.children)) {
    for (const child of node.children as A2uiNode[]) typesIn(child, out);
  }
  return out;
}

function NodeView({ node }: { node: A2uiNode }) {
  const runtime = useContext(RuntimeContext);
  if (!runtime) return null;
  const Renderer = runtime.components[node.type as ComponentType] as
    | ReactComponentType<RendererProps<ComponentType>>
    | undefined;
  if (!Renderer) return null;
  const { type: _type, ...props } = node;
  const kids = Array.isArray(node.children) ? (node.children as A2uiNode[]) : [];
  return (
    <NodeContext.Provider value={node}>
      <Renderer props={props as never} node={node}>
        {kids.map((child, i) => (
          // Children are positional and never reorder.
          // biome-ignore lint/suspicious/noArrayIndexKey: a card's children have no ids.
          <NodeView key={i} node={child} />
        ))}
      </Renderer>
    </NodeContext.Provider>
  );
}

export interface A2uiViewProps {
  /** A stored card (preferred: it carries its fallback), or a bare document. */
  part?: A2uiPart;
  document?: A2uiDocument | null;
  /** Who wrote the card, when passing a bare document. */
  source?: A2uiSource;
  /** The text to show when the card cannot be rendered. */
  fallbackText?: string;
  components: ComponentMap;
  onAction: ActionHandler;
  Fallback?: FallbackComponent;
  /** The newest catalogue version the host renders. */
  supportedVersion?: number;
  /** Told when a card falls back (for logging). */
  onFallback?: (reason: string) => void;
}

/** Renders one card, or its text fallback. */
export function A2uiView({
  part,
  document,
  source,
  fallbackText,
  components,
  onAction,
  Fallback = DefaultFallback,
  supportedVersion,
  onFallback,
}: A2uiViewProps) {
  const doc = part ? part.document : (document ?? null);
  const from: A2uiSource = part?.source ?? source ?? "model";
  const text = part?.fallback ?? fallbackText ?? "";
  const checked = useMemo(
    () =>
      doc
        ? validateDocument(doc, {
            source: from,
            ...(supportedVersion ? { supportedVersion } : {}),
          })
        : null,
    [doc, from, supportedVersion],
  );
  const runtime = useMemo(
    () => ({ source: from, components, onAction }),
    [from, components, onAction],
  );
  const fallback = (
    <Fallback text={text} {...(part?.problems ? { problems: part.problems } : {})} />
  );
  if (!checked?.ok) {
    if (checked && !checked.ok) onFallback?.(checked.problems.join("; "));
    return fallback;
  }
  const missing = [...typesIn(checked.document.root)].filter(
    (t) => !components[t as ComponentType],
  );
  if (missing.length) {
    onFallback?.(`no renderer for ${missing.join(", ")}`);
    return fallback;
  }
  return (
    <Boundary fallback={fallback} onError={(e) => onFallback?.(e.message)}>
      <RuntimeContext.Provider value={runtime}>
        <NodeView node={checked.document.root} />
      </RuntimeContext.Provider>
    </Boundary>
  );
}

export type ActionStatus = "idle" | "busy" | "done" | "failed";

export interface ActionState {
  status: ActionStatus;
  message: string | null;
  run(extra?: Record<string, unknown>): Promise<ActionResult>;
}

/**
 * Runs actions of the component it is used in. Each call returns the action's state, so a
 * button can show busy, done ("Task created") or the error.
 */
export function useA2uiAction(action: A2uiAction | null | undefined): ActionState {
  const runtime = useContext(RuntimeContext);
  const node = useContext(NodeContext);
  const [status, setStatus] = useState<ActionStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const run = useCallback(
    async (extra?: Record<string, unknown>): Promise<ActionResult> => {
      if (!action || !runtime || !node) return { ok: false, message: "Not available here" };
      setStatus("busy");
      setMessage(null);
      let result: ActionResult;
      try {
        result = await runtime.onAction(action, extra, { source: runtime.source, node });
      } catch (error) {
        result = { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      setStatus(result.ok ? "done" : "failed");
      setMessage(
        result.ok
          ? (result.message ?? (action.kind === "operation" ? (action.done ?? null) : null))
          : result.message,
      );
      return result;
    },
    [action, runtime, node],
  );
  return { status, message, run };
}

/** Runs any action from inside a component (for actions a renderer builds itself). */
export function useA2uiRunner(): (
  action: A2uiAction,
  extra?: Record<string, unknown>,
) => Promise<ActionResult> {
  const runtime = useContext(RuntimeContext);
  const node = useContext(NodeContext);
  return useCallback(
    async (action, extra) => {
      if (!runtime || !node) return { ok: false, message: "Not available here" };
      try {
        return await runtime.onAction(action, extra, { source: runtime.source, node });
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    [runtime, node],
  );
}

/** Who wrote the card being rendered. */
export function useA2uiSource(): A2uiSource {
  return useContext(RuntimeContext)?.source ?? "model";
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Sets `path` ("values.name") in a copy of `target`. Field names come from the card. */
function setPath(target: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split(".");
  if (keys.some((key) => UNSAFE_KEYS.has(key))) return;
  let at: Record<string, unknown> = target;
  for (const key of keys.slice(0, -1)) {
    const next = at[key];
    at[key] = next && typeof next === "object" && !Array.isArray(next) ? { ...next } : {};
    at = at[key] as Record<string, unknown>;
  }
  const last = keys[keys.length - 1];
  if (last) at[last] = value;
}

/** Merges `extra` into an operation's input: dotted keys land in nested objects. */
export function mergeInput(
  input: Record<string, unknown>,
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  for (const [key, value] of Object.entries(extra ?? {})) setPath(out, key, value);
  return out;
}

/** The action a form's submit is. */
export function submitAction(submit: FormSubmit): A2uiAction {
  return {
    kind: "operation",
    label: submit.label,
    operation: submit.operation,
    input: submit.input,
    ...(submit.done ? { done: submit.done } : {}),
  };
}
