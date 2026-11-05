// The docked assistant panel's remembered state (ADR 0030, ADR 0200): whether it is open and how
// wide it is, kept per browser in localStorage, plus the pure rules for resizing it and for naming
// the page it is looking at ("On: People").
import { MAIN_NAV, SETTINGS_NAV } from "#/lib/nav";

/** Narrowest and widest the docked panel can be dragged, in px. */
export const PANEL_MIN = 288;
export const PANEL_MAX = 720;
export const PANEL_DEFAULT = 384;
/** One arrow-key press on the resize handle, in px (Shift: four times this). */
export const PANEL_STEP = 16;
/** The page keeps at least this much width beside the panel, while the panel can give it up. */
export const MAIN_MIN = 320;

const OPEN_KEY = "ros.assistant.dock.open";
const WIDTH_KEY = "ros.assistant.dock.width";

/** Keeps a width within the panel's limits; anything unreadable is the default. */
export function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return PANEL_DEFAULT;
  return Math.min(PANEL_MAX, Math.max(PANEL_MIN, Math.round(width)));
}

/**
 * The new width after a key on the resize handle (it sits on the panel's left edge, so Left
 * widens it), or null for keys it ignores.
 */
export function widthAfterKey(width: number, key: string, shift = false): number | null {
  const step = shift ? PANEL_STEP * 4 : PANEL_STEP;
  switch (key) {
    case "ArrowLeft":
      return clampWidth(width + step);
    case "ArrowRight":
      return clampWidth(width - step);
    case "Home":
      return PANEL_MIN;
    case "End":
      return PANEL_MAX;
    default:
      return null;
  }
}

/** The width from a drag that started at `startX` with the panel `startWidth` wide. */
export function widthAfterDrag(startWidth: number, startX: number, x: number): number {
  return clampWidth(startWidth + (startX - x));
}

/**
 * The CSS width of the docked panel: the chosen width, but never so wide that the page beside it
 * gets narrower than MAIN_MIN (the panel then gives way, down to PANEL_MIN).
 */
export function dockWidthCss(width: number, navWidth: string): string {
  return `clamp(${PANEL_MIN}px, ${clampWidth(width)}px, calc(100vw - ${navWidth} - ${MAIN_MIN}px))`;
}

type Store = Pick<Storage, "getItem" | "setItem">;

function storage(): Store | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readDockOpen(store: Store | null = storage()): boolean {
  try {
    return store?.getItem(OPEN_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeDockOpen(open: boolean, store: Store | null = storage()): void {
  try {
    store?.setItem(OPEN_KEY, String(open));
  } catch {
    // Private mode or storage full: the panel just starts closed next time.
  }
}

export function readDockWidth(store: Store | null = storage()): number {
  try {
    const raw = store?.getItem(WIDTH_KEY);
    return raw ? clampWidth(Number(raw)) : PANEL_DEFAULT;
  } catch {
    return PANEL_DEFAULT;
  }
}

export function writeDockWidth(width: number, store: Store | null = storage()): void {
  try {
    store?.setItem(WIDTH_KEY, String(clampWidth(width)));
  } catch {
    // As above: the default width next time.
  }
}

const SECTIONS = [...MAIN_NAV, ...SETTINGS_NAV].sort((a, b) => b.to.length - a.to.length);

/** A short name for the page at `pathname`, for the context chip and the model ("People"). */
export function pageLabel(pathname: string): string {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return "Home";
  const section = SECTIONS.find(
    (item) => item.to !== "/" && (path === item.to || path.startsWith(`${item.to}/`)),
  );
  if (section) return section.label;
  const segments = path.split("/").filter(Boolean);
  // Extension objects live under /x/<object>.
  const first = (segments[0] === "x" ? segments[1] : segments[0]) ?? "";
  let words = first;
  try {
    words = decodeURIComponent(first);
  } catch {
    // A malformed escape: use it as it is.
  }
  words = words.replace(/[-_]+/g, " ").trim();
  return words ? words[0]?.toUpperCase() + words.slice(1) : "Home";
}
