// The docked assistant panel's state rules: resizing, remembered width and open state, and the
// page name in its context chip.
import { describe, expect, it } from "vitest";
import {
  clampWidth,
  dockWidthCss,
  MAIN_MIN,
  PANEL_DEFAULT,
  PANEL_MAX,
  PANEL_MIN,
  PANEL_STEP,
  pageLabel,
  readDockOpen,
  readDockWidth,
  widthAfterDrag,
  widthAfterKey,
  writeDockOpen,
  writeDockWidth,
} from "../src/components/assistant/dock-state.ts";

function memoryStore() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

const throwing = {
  getItem: (): string | null => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("denied");
  },
};

describe("clampWidth", () => {
  it("keeps widths within the limits", () => {
    expect(clampWidth(100)).toBe(PANEL_MIN);
    expect(clampWidth(5000)).toBe(PANEL_MAX);
    expect(clampWidth(400.4)).toBe(400);
    expect(clampWidth(Number.NaN)).toBe(PANEL_DEFAULT);
  });
});

describe("resizing", () => {
  it("widens with Left and narrows with Right (the handle is on the left edge)", () => {
    expect(widthAfterKey(400, "ArrowLeft")).toBe(400 + PANEL_STEP);
    expect(widthAfterKey(400, "ArrowRight")).toBe(400 - PANEL_STEP);
    expect(widthAfterKey(400, "ArrowLeft", true)).toBe(400 + PANEL_STEP * 4);
    expect(widthAfterKey(PANEL_MAX, "ArrowLeft")).toBe(PANEL_MAX);
    expect(widthAfterKey(400, "Home")).toBe(PANEL_MIN);
    expect(widthAfterKey(400, "End")).toBe(PANEL_MAX);
    expect(widthAfterKey(400, "a")).toBeNull();
  });

  it("drags: moving the pointer left widens the panel", () => {
    expect(widthAfterDrag(400, 900, 850)).toBe(450);
    expect(widthAfterDrag(400, 900, 1000)).toBe(300);
    expect(widthAfterDrag(400, 900, 0)).toBe(PANEL_MAX);
  });

  it("gives way so the page keeps its minimum width", () => {
    expect(dockWidthCss(400, "var(--sidebar-width)")).toBe(
      `clamp(${PANEL_MIN}px, 400px, calc(100vw - var(--sidebar-width) - ${MAIN_MIN}px))`,
    );
  });
});

describe("remembered state", () => {
  it("round-trips width and open state", () => {
    const store = memoryStore();
    expect(readDockOpen(store)).toBe(false);
    expect(readDockWidth(store)).toBe(PANEL_DEFAULT);
    writeDockOpen(true, store);
    writeDockWidth(512, store);
    expect(readDockOpen(store)).toBe(true);
    expect(readDockWidth(store)).toBe(512);
    writeDockOpen(false, store);
    expect(readDockOpen(store)).toBe(false);
  });

  it("ignores junk and storage that throws", () => {
    const store = memoryStore();
    store.setItem("ros.assistant.dock.width", "wide");
    expect(readDockWidth(store)).toBe(PANEL_DEFAULT);
    store.setItem("ros.assistant.dock.width", "99999");
    expect(readDockWidth(store)).toBe(PANEL_MAX);
    expect(readDockOpen(throwing)).toBe(false);
    expect(readDockWidth(throwing)).toBe(PANEL_DEFAULT);
    expect(() => writeDockOpen(true, throwing)).not.toThrow();
    expect(() => writeDockWidth(400, throwing)).not.toThrow();
    expect(readDockOpen(null)).toBe(false);
  });
});

describe("pageLabel", () => {
  it("names sections by the longest matching nav entry", () => {
    expect(pageLabel("/")).toBe("Home");
    expect(pageLabel("/people")).toBe("People");
    expect(pageLabel("/people/per_123")).toBe("People");
    expect(pageLabel("/organisations/")).toBe("Organisations");
    expect(pageLabel("/settings/audit")).toBe("Audit log");
    expect(pageLabel("/settings")).toBe("Settings");
  });

  it("falls back to the path for pages outside the nav", () => {
    expect(pageLabel("/x/deals")).toBe("Deals");
    expect(pageLabel("/x/deals/xr_1")).toBe("Deals");
    expect(pageLabel("/import")).toBe("Import");
    expect(pageLabel("/%E0%A4%A")).toBe("%E0%A4%A");
  });
});
