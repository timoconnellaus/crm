// Runs one gatekeeper configurator spec in the app: the CRM's stand-in for upstream's sandboxed
// configurator frame. It owns the form's values, renders the spec with our runtime (runtime.tsx),
// reports readiness, and collects the chosen resource URL. The `ui` capability is the gatekeeper's,
// reached through the server (see ui-proxy.ts).
import type {
  ConfiguratorUIRenderContext,
  ConfiguratorUISpec,
  ConfiguratorUIValues,
} from "@relationship-os/gatekeeper-configurator-ui";
import { Button as UIButton } from "@relationship-os/ui/components/button";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { cn } from "@relationship-os/ui/lib/utils";
import {
  Component,
  type CSSProperties,
  type ErrorInfo,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FrameContext, type FrameContextValue, type OptionsEntry } from "./form-context.ts";
import {
  applyClearFields,
  applySetValues,
  errorText,
  initialValuesFor,
  readiness,
} from "./form-state.ts";
import { Notice } from "./runtime.tsx";

/** What a ConfiguratorForm's `ref` exposes. */
export type ConfiguratorFormHandle = {
  /**
   * The resource URL the current values choose, from the spec's `resourceUrl`. Rejects with a
   * message for the user (also shown in the form) when the values do not choose one yet.
   */
  collectResourceUrl(): Promise<string>;
  /** Whether the form is ready to submit, as last reported through `onReadyChange`. */
  isReady(): boolean;
};

export type ConfiguratorFormProps = {
  /** A spec from `configuratorSpecFor`; load a fresh one per form. */
  spec: ConfiguratorUISpec<unknown>;
  /** The gatekeeper's configurator capability: an object whose methods return promises. */
  ui: unknown;
  /** The resource type being configured. */
  resourceUrlPattern: string;
  /** The resource types the host accepts, when it narrows them (see the authoring API). */
  acceptedResourceUrlPatterns?: readonly string[];
  /** A concrete resource URL to open the form pre-filled with, e.g. to edit a binding. */
  initialResourceUrl?: string | null;
  /**
   * Makes sure the connection holds grants for these patterns, asking the user for consent when it
   * does not; true when it already did. Called from a click handler (pop-ups are allowed then).
   */
  ensureResources(resourceUrlPatterns: string[]): Promise<boolean>;
  /** Told whenever readiness changes, and once with the first value. */
  onReadyChange?(ready: boolean): void;
  ref?: Ref<ConfiguratorFormHandle>;
  className?: string;
};

/**
 * Upstream's specs style their own markup with the Kumo theme's variables; these map them onto
 * ours. The specs' stylesheets use their own class prefixes (`cal-`, `ol-`, `browser-`).
 */
const KUMO_THEME = {
  "--color-kumo-base": "var(--background)",
  "--color-kumo-elevated": "var(--muted)",
  "--color-kumo-tint": "var(--accent)",
  "--color-kumo-line": "var(--border)",
  "--color-kumo-interact": "var(--ring)",
  "--color-kumo-danger": "var(--destructive)",
  "--text-color-kumo-default": "var(--foreground)",
  "--text-color-kumo-subtle": "var(--muted-foreground)",
  "--text-color-kumo-inactive": "var(--muted-foreground)",
} as CSSProperties;

const FOCUSABLE =
  'input:not([disabled]):not([type="hidden"]), button:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const specIds = new WeakMap<object, number>();
let nextSpecId = 0;
function specKey(spec: object): number {
  let id = specIds.get(spec);
  if (id === undefined) {
    id = ++nextSpecId;
    specIds.set(spec, id);
  }
  return id;
}

export function ConfiguratorForm(props: ConfiguratorFormProps) {
  // A new spec, or a new resource to open, is a new frame.
  return (
    <Form
      key={`${specKey(props.spec)}\u0000${props.resourceUrlPattern}\u0000${props.initialResourceUrl ?? ""}`}
      {...props}
    />
  );
}

function Form({
  spec,
  ui,
  resourceUrlPattern,
  acceptedResourceUrlPatterns,
  initialResourceUrl,
  ensureResources,
  onReadyChange,
  ref,
  className,
}: ConfiguratorFormProps) {
  const [values, setValueState] = useState<ConfiguratorUIValues | null>(() =>
    initialResourceUrl ? null : { ...spec.initial },
  );
  const [initError, setInitError] = useState<string | null>(null);
  const [collectError, setCollectError] = useState<string | null>(null);
  const [generations, setGenerations] = useState<ReadonlyMap<string, number>>(new Map());
  const [rendered, setRendered] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [boundaryFailed, setBoundaryFailed] = useState(false);
  const options = useRef(new Map<string, OptionsEntry>());
  const container = useRef<HTMLDivElement>(null);
  const lastButton = useRef<HTMLElement | null>(null);
  const rendering = useRef(false);
  const latest = useRef({ values, ui, acceptedResourceUrlPatterns, ensureResources, ready: false });

  const host = acceptedResourceUrlPatterns ? { acceptedResourceUrlPatterns } : {};

  // Pre-fill from the resource URL, or fall back to the spec's initial values.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per frame (see ConfiguratorForm's key).
  useEffect(() => {
    if (!initialResourceUrl) return;
    let live = true;
    initialValuesFor(spec, {
      ui,
      resourceUrlPattern,
      resourceUrl: initialResourceUrl,
      ...host,
    }).then(
      (initial) => {
        if (live) setValueState(initial);
      },
      (error: unknown) => {
        if (!live) return;
        setInitError(errorText(error, "The resource couldn't be opened."));
        setValueState({ ...spec.initial });
      },
    );
    return () => {
      live = false;
    };
  }, []);

  /** State changes asked for while the spec renders wait until it has finished. */
  const later = useCallback((change: () => void) => {
    if (rendering.current) queueMicrotask(change);
    else change();
  }, []);

  const setValues = useCallback(
    (patch: Partial<ConfiguratorUIValues>) =>
      later(() => {
        setCollectError(null);
        setValueState((current) => applySetValues(current ?? { ...spec.initial }, patch ?? {}));
      }),
    [later, spec],
  );

  const clearFields = useCallback(
    (...names: string[]) =>
      later(() => {
        setValueState((current) => applyClearFields(current ?? { ...spec.initial }, names));
        setGenerations((current) => {
          const next = new Map(current);
          for (const name of names) next.set(name, (next.get(name) ?? 0) + 1);
          return next;
        });
      }),
    [later, spec],
  );

  const ensure = useCallback((patterns: string[]) => latest.current.ensureResources(patterns), []);

  const frame = useMemo<FrameContextValue>(
    () => ({ generation: (name) => generations.get(name) ?? 0, options: options.current }),
    [generations],
  );

  let tree: ReactNode = null;
  let renderError: string | null = null;
  if (values) {
    const context: ConfiguratorUIRenderContext<unknown> = {
      values,
      setValues,
      clearFields,
      ui,
      ensureResources: ensure,
      ...host,
    };
    rendering.current = true;
    try {
      tree = spec.render(context) as ReactNode;
    } catch (error) {
      renderError = errorText(error, "This configurator couldn't be shown.");
    } finally {
      rendering.current = false;
    }
  }

  const ready =
    values !== null &&
    readiness(spec, {
      values,
      rendered,
      renderFailed: renderError !== null || boundaryFailed,
      ...host,
    });
  latest.current = { values, ui, acceptedResourceUrlPatterns, ensureResources, ready };

  useEffect(() => {
    if (values && !renderError && !rendered) setRendered(true);
  });

  const reported = useRef<boolean | null>(null);
  useEffect(() => {
    if (reported.current === ready) return;
    reported.current = ready;
    onReadyChange?.(ready);
  });

  // One polite live region announces the last info notice on screen whenever its text changes.
  useEffect(() => {
    const notices = container.current?.querySelectorAll(
      '[data-configurator-notice="info"] [data-notice-message]',
    );
    const last = notices && notices.length > 0 ? notices[notices.length - 1] : undefined;
    const text = last?.textContent?.trim() ?? "";
    if (text !== announcement) setAnnouncement(text);
  });

  // When a render removes the focused Button, focus moves to the first control left.
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const track = (event: FocusEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("[data-configurator-button]")) lastButton.current = target;
    };
    element.addEventListener("focusin", track);
    return () => element.removeEventListener("focusin", track);
  }, []);
  useLayoutEffect(() => {
    const button = lastButton.current;
    if (!button || button.isConnected) return;
    lastButton.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && container.current?.contains(active)) return;
    container.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  });

  useImperativeHandle(
    ref,
    () => ({
      async collectResourceUrl() {
        const {
          values: current,
          ui: capability,
          acceptedResourceUrlPatterns: accepted,
        } = latest.current;
        if (!current) throw new Error("The configurator is still opening.");
        try {
          const url = await spec.resourceUrl({
            values: current,
            ui: capability,
            ...(accepted ? { acceptedResourceUrlPatterns: accepted } : {}),
          });
          if (typeof url !== "string" || url === "") {
            throw new Error("The configurator didn't choose a resource.");
          }
          setCollectError(null);
          return url;
        } catch (error) {
          setCollectError(errorText(error, "The resource couldn't be chosen."));
          throw error;
        }
      },
      isReady: () => latest.current.ready,
    }),
    [spec],
  );

  return (
    <div
      ref={container}
      className={cn("grid min-w-0 gap-4", className)}
      style={KUMO_THEME}
      data-configurator-form=""
    >
      {initError ? <Notice tone="error">{initError}</Notice> : null}
      {values === null ? (
        <div className="grid gap-2" role="status" aria-busy="true">
          <span className="sr-only">Opening…</span>
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : renderError ? (
        <Notice tone="error">{renderError}</Notice>
      ) : (
        <FrameContext.Provider value={frame}>
          <RenderBoundary onFailedChange={setBoundaryFailed}>{tree}</RenderBoundary>
        </FrameContext.Provider>
      )}
      {collectError ? <Notice tone="error">{collectError}</Notice> : null}
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}

/** Shows an error from the configurator's markup or components in place of the configurator. */
class RenderBoundary extends Component<
  { children: ReactNode; onFailedChange(failed: boolean): void },
  { error: string | null }
> {
  override state: { error: string | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: errorText(error, "This configurator couldn't be shown.") };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Configurator render failed", error, info.componentStack);
    this.props.onFailedChange(true);
  }

  override render() {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="grid justify-items-start gap-2">
        <Notice tone="error">{this.state.error}</Notice>
        <UIButton
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            this.setState({ error: null });
            this.props.onFailedChange(false);
          }}
        >
          Try again
        </UIButton>
      </div>
    );
  }
}
