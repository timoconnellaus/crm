// The JSX factory the configurator specs compile to (see vite-plugin.ts). Upstream renders them with
// Preact, so the specs' own markup (the Microsoft ones draw much of their UI themselves) is written
// in Preact's dialect: DOM attribute names (`class`, `tabindex`, `stroke-width`), lower-case event
// names (`onKeydown`), and inputs whose `value` is set on render but left alone between renders.
// `h` translates that into React.
import {
  createElement,
  Fragment,
  type ReactNode,
  type Ref,
  useCallback,
  useLayoutEffect,
  useRef,
} from "react";

/** React's names for the DOM attributes the specs spell the DOM's way. */
const ATTRIBUTES: Record<string, string> = {
  class: "className",
  for: "htmlFor",
  tabindex: "tabIndex",
  autocomplete: "autoComplete",
  autocapitalize: "autoCapitalize",
  autofocus: "autoFocus",
  spellcheck: "spellCheck",
  inputmode: "inputMode",
  enterkeyhint: "enterKeyHint",
  readonly: "readOnly",
  maxlength: "maxLength",
  minlength: "minLength",
  contenteditable: "contentEditable",
  crossorigin: "crossOrigin",
  srcset: "srcSet",
  colspan: "colSpan",
  rowspan: "rowSpan",
  datetime: "dateTime",
};

/** React's names for DOM events, by their lower-case names; Preact's focusin/out are React's focus/blur. */
const EVENTS: Record<string, string> = Object.fromEntries(
  [
    "onAnimationEnd",
    "onAuxClick",
    "onBeforeInput",
    "onBlur",
    "onChange",
    "onClick",
    "onCompositionEnd",
    "onCompositionStart",
    "onContextMenu",
    "onCopy",
    "onCut",
    "onDoubleClick",
    "onDrag",
    "onDragEnd",
    "onDragEnter",
    "onDragLeave",
    "onDragOver",
    "onDragStart",
    "onDrop",
    "onFocus",
    "onInput",
    "onInvalid",
    "onKeyDown",
    "onKeyPress",
    "onKeyUp",
    "onLoad",
    "onMouseDown",
    "onMouseEnter",
    "onMouseLeave",
    "onMouseMove",
    "onMouseOut",
    "onMouseOver",
    "onMouseUp",
    "onPaste",
    "onPointerDown",
    "onPointerEnter",
    "onPointerLeave",
    "onPointerMove",
    "onPointerUp",
    "onScroll",
    "onSelect",
    "onSubmit",
    "onToggle",
    "onTouchEnd",
    "onTouchMove",
    "onTouchStart",
    "onTransitionEnd",
    "onWheel",
  ]
    .map((name): [string, string] => [name.toLowerCase(), name])
    .concat([
      ["ondblclick", "onDoubleClick"],
      ["onfocusin", "onFocus"],
      ["onfocusout", "onBlur"],
    ]),
);

/** A spec's props for an intrinsic element, renamed for React. */
export function reactProps(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    // The classic transform's development-only props; React 19 reads them as an old JSX runtime.
    if (key === "__self" || key === "__source") continue;
    let name = key;
    if (ATTRIBUTES[key]) name = ATTRIBUTES[key];
    else if (/^on[A-Za-z]/.test(key)) name = EVENTS[key.toLowerCase()] ?? key;
    else if (key.includes("-") && !key.startsWith("aria-") && !key.startsWith("data-")) {
      // SVG presentation attributes: React knows `stroke-width` as `strokeWidth`.
      name = key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    }
    out[name] = value;
  }
  return out;
}

type CompatFieldProps = Record<string, unknown> & {
  tag: "input" | "textarea" | "select";
  ref?: Ref<HTMLElement>;
};

/**
 * An input as Preact renders it: `value` and `checked` are written to the element on every render
 * (when they differ), but typing between renders is not undone, as React's controlled inputs do.
 * Specs keep typed text in module state without re-rendering, which a controlled input would erase.
 */
function CompatField({ tag, ref, value, checked, ...rest }: CompatFieldProps) {
  const node = useRef<HTMLInputElement | null>(null);
  useLayoutEffect(() => {
    const element = node.current;
    if (!element) return;
    if (value !== undefined) {
      const text = value === null ? "" : String(value);
      if (element.value !== text) element.value = text;
    }
    if (checked !== undefined && element.checked !== Boolean(checked)) {
      element.checked = Boolean(checked);
    }
  });
  const setNode = useCallback(
    (element: HTMLInputElement | null) => {
      node.current = element;
      if (typeof ref === "function") ref(element);
      else if (ref && typeof ref === "object") ref.current = element;
    },
    [ref],
  );
  return createElement(tag, {
    ...rest,
    ...(value !== undefined ? { defaultValue: value === null ? "" : value } : {}),
    ...(checked !== undefined ? { defaultChecked: Boolean(checked) } : {}),
    ref: setNode,
  });
}

/** Arrays of children become fragments of static children, as Preact diffs them without keys. */
function child(node: unknown): ReactNode {
  return Array.isArray(node)
    ? createElement(Fragment, null, ...node.map(child))
    : (node as ReactNode);
}

/** The authoring API's `h`: `React.createElement` with Preact's dialect translated. */
export function h(type: unknown, props: unknown, ...children: unknown[]): ReactNode {
  const given = (props ?? {}) as Record<string, unknown>;
  const kids = children.map(child);
  if (typeof type === "string") {
    const renamed = reactProps(given);
    if (
      (type === "input" || type === "textarea" || type === "select") &&
      ("value" in renamed || "checked" in renamed)
    ) {
      return createElement(CompatField, { ...renamed, tag: type }, ...kids);
    }
    return createElement(type, renamed, ...kids);
  }
  const { __self: _self, __source: _source, ...rest } = given;
  return createElement(type as Parameters<typeof createElement>[0], rest, ...kids);
}
