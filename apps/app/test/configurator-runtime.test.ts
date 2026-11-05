// The configurator runtime's pure parts (form state, the ui proxy, the Preact-dialect `h`, the spec
// transform) and its components, server-rendered.
import type { ConfiguratorUISpec } from "@relationship-os/gatekeeper-configurator-ui";
import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { h, reactProps } from "../src/components/integrations/configurator/compat.ts";
import {
  applyClearFields,
  applySetValues,
  initialValuesFor,
  readiness,
  valuesFromPatternGroups,
} from "../src/components/integrations/configurator/form-state.ts";
import { locationOf } from "../src/components/integrations/configurator/hierarchy-picker.tsx";
import {
  Button,
  CheckboxList,
  Field,
  HierarchyPicker,
  Notice,
  RadioCards,
  Section,
  TextInput,
} from "../src/components/integrations/configurator/runtime.tsx";
import { uiProxy } from "../src/components/integrations/configurator/ui-proxy.ts";
import {
  importEnd,
  transformConfiguratorSpec,
} from "../src/components/integrations/configurator/vite-plugin.ts";

const spec = (
  overrides: Partial<ConfiguratorUISpec<unknown>> = {},
): ConfiguratorUISpec<unknown> => ({
  initial: { mode: "all" },
  resourceUrl: () => "https://example.com/",
  render: () => null,
  ...overrides,
});

describe("form state", () => {
  it("setValues merges a patch, and an empty patch still makes new values (a re-render)", () => {
    const values = { a: "1", b: "2" };
    expect(applySetValues(values, { b: null, c: "3" })).toEqual({ a: "1", b: null, c: "3" });
    const same = applySetValues(values, {});
    expect(same).toEqual(values);
    expect(same).not.toBe(values);
  });

  it("clearFields drops the named values", () => {
    expect(applyClearFields({ a: "1", b: "2", c: "3" }, ["a", "c"])).toEqual({ b: "2" });
    expect(applyClearFields({ a: "1" }, [])).toEqual({ a: "1" });
  });

  it("falls back to the URLPattern's named groups, decoded, skipping wildcards", () => {
    expect(
      valuesFromPatternGroups(
        "https://bigquery.googleapis.com/:projectId/*",
        "https://bigquery.googleapis.com/my%20project/ds",
      ),
    ).toEqual({ projectId: "my project" });
    expect(
      valuesFromPatternGroups(
        "https://chat.google.com/:kind(room|dm)/:spaceId",
        "https://chat.google.com/dm/AAA",
      ),
    ).toEqual({ kind: "dm", spaceId: "AAA" });
    expect(
      valuesFromPatternGroups("https://*.sharepoint.com/*", "https://x.sharepoint.com/a"),
    ).toEqual({});
    expect(valuesFromPatternGroups("https://example.com/:id", "https://other.com/1")).toEqual({});
    expect(valuesFromPatternGroups("not a pattern ((", "https://example.com/")).toEqual({});
  });

  it("derives initial values from a resource URL, the spec's way or by the fallback", async () => {
    const base = { ui: {}, resourceUrlPattern: "https://example.com/areas/:areaId" };
    expect(await initialValuesFor(spec(), base)).toEqual({ mode: "all" });
    expect(
      await initialValuesFor(spec(), { ...base, resourceUrl: "https://example.com/areas/a%2F1" }),
    ).toEqual({ mode: "all", areaId: "a/1" });
    const seen: unknown[] = [];
    const custom = spec({
      async initialValuesFromResourceUrl(context) {
        seen.push(context);
        return { mode: "one", repo: "x" };
      },
    });
    expect(
      await initialValuesFor(custom, {
        ...base,
        resourceUrl: "https://example.com/areas/1",
        acceptedResourceUrlPatterns: ["p"],
      }),
    ).toEqual({ mode: "one", repo: "x" });
    expect(seen).toEqual([
      {
        resourceUrl: "https://example.com/areas/1",
        resourceUrlPattern: base.resourceUrlPattern,
        ui: base.ui,
        acceptedResourceUrlPatterns: ["p"],
      },
    ]);
  });

  it("is ready after the first successful render unless the spec says otherwise", () => {
    const values = { mode: "all" };
    expect(readiness(spec(), { values, rendered: false, renderFailed: false })).toBe(false);
    expect(readiness(spec(), { values, rendered: true, renderFailed: false })).toBe(true);
    expect(readiness(spec(), { values, rendered: true, renderFailed: true })).toBe(false);
    const picky = spec({ isReady: ({ values }) => values.mode === "one" });
    expect(readiness(picky, { values, rendered: true, renderFailed: false })).toBe(false);
    expect(
      readiness(picky, { values: { mode: "one" }, rendered: false, renderFailed: false }),
    ).toBe(true);
    const broken = spec({
      isReady: () => {
        throw new Error("no");
      },
    });
    expect(readiness(broken, { values, rendered: true, renderFailed: false })).toBe(false);
  });
});

describe("uiProxy", () => {
  it("turns method calls into calls through the server", async () => {
    const calls: [string, unknown[]][] = [];
    const ui = uiProxy(async (method, args) => {
      calls.push([method, args]);
      return `${method}:${args.length}`;
    });
    expect(await ui.listDrives?.("a", 2)).toBe("listDrives:2");
    expect(await ui.getStatus?.()).toBe("getStatus:0");
    expect(calls).toEqual([
      ["listDrives", ["a", 2]],
      ["getStatus", []],
    ]);
    expect(ui.listDrives).toBe(ui.listDrives);
  });

  it("is not a thenable, so it can be awaited and returned from async functions", async () => {
    const ui = uiProxy(async () => undefined);
    expect((ui as { then?: unknown }).then).toBeUndefined();
    expect("then" in ui).toBe(false);
    expect(await Promise.resolve(ui)).toBe(ui);
    expect((ui as Record<symbol, unknown>)[Symbol.toPrimitive]).toBeUndefined();
  });
});

describe("h (the specs' Preact dialect)", () => {
  it("renames DOM attribute and event names for React", () => {
    const onKeydown = () => {};
    expect(
      reactProps({
        class: "a",
        tabindex: "0",
        autocomplete: "off",
        spellcheck: "false",
        "stroke-width": "2",
        "aria-label": "x",
        "data-sp-nav": "1",
        onKeydown,
        onFocusout: onKeydown,
        onClick: onKeydown,
        __self: {},
      }),
    ).toEqual({
      className: "a",
      tabIndex: "0",
      autoComplete: "off",
      spellCheck: "false",
      strokeWidth: "2",
      "aria-label": "x",
      "data-sp-nav": "1",
      onKeyDown: onKeydown,
      onBlur: onKeydown,
      onClick: onKeydown,
    });
  });

  it("renders spec markup as the DOM spells it", () => {
    const html = renderToString(
      h(
        "div",
        { class: "wrap" },
        h(
          "svg",
          { viewBox: "0 0 24 24" },
          h("g", { "stroke-width": "1.5", "clip-path": "url(#c)" }),
        ),
        [h("span", null, "one"), h("span", null, "two")],
        h("input", { value: "typed", class: "input", autocomplete: "off" }),
        h("input", { type: "checkbox", checked: true }),
      ) as ReactNode,
    );
    expect(html).toContain('class="wrap"');
    expect(html).toContain('stroke-width="1.5"');
    expect(html).toContain('clip-path="url(#c)"');
    expect(html).toContain("<span>one</span><span>two</span>");
    expect(html).toMatch(/<input value="typed" class="input" autoComplete="off"\/>|value="typed"/);
    expect(html).toContain('checked=""');
  });
});

describe("the spec transform", () => {
  const source = `// Header comment
import {
  Field,
  // a comment with "quotes" in it
  h,
} from "@relationship-os/gatekeeper-configurator-ui";
import type { X } from "./x";

let state = 0;

export default {
  initial: {},
  render() { return state++; },
} satisfies X;
`;

  it("wraps the module body in a factory, keeping line numbers", () => {
    const out = transformConfiguratorSpec(source);
    expect(out.startsWith("/** @jsxRuntime classic */")).toBe(true);
    expect(out).toContain("export function createConfiguratorSpec() { let state = 0;");
    expect(out).toContain("return {\n  initial: {},");
    expect(out).toContain("export default createConfiguratorSpec();");
    const line = (text: string, needle: string) =>
      text.split("\n").findIndex((entry) => entry.includes(needle));
    expect(line(out, "let state = 0;")).toBe(line(source, "let state = 0;"));
    expect(line(out, "render() {")).toBe(line(source, "render() {"));
  });

  it("leaves a module of another shape unwrapped", () => {
    const other = `import { h } from "x";\nexport const a = 1;\nexport default {};\n`;
    const out = transformConfiguratorSpec(other);
    expect(out).not.toContain("createConfiguratorSpec");
    expect(out.endsWith(other)).toBe(true);
  });

  it("finds the end of an import declaration despite comments", () => {
    const text = `import { a, /* "b" */ c } from "m";rest`;
    expect(text.slice(importEnd(text, 0) ?? 0)).toBe("rest");
    expect(importEnd(`import "side-effect";x`, 0)).toBe(21);
    expect(importEnd("important = 1", 0)).toBeNull();
    expect(importEnd("import.meta.url", 0)).toBeNull();
  });
});

describe("runtime components", () => {
  const render = (node: unknown) => renderToString(node as ReactNode);

  it("labels a text input and marks optional fields", () => {
    const html = render(
      h(
        Section,
        { title: "Mailbox" },
        h(
          Field,
          { label: "Name", description: "Its name.", optional: true },
          h(TextInput, { name: "n", value: null, placeholder: "alerts", onChange: () => {} }),
        ),
      ),
    );
    expect(html).toContain("<h3");
    expect(html).toContain("(optional)");
    const forId = /for="([^"]+)"/.exec(html)?.[1];
    expect(html).toContain(`id="${forId}"`);
    expect(html).toContain('placeholder="alerts"');
  });

  it("renders radio cards, compact rows and a checkbox list loading", () => {
    const options = [
      { value: "a", title: "Alpha", description: "First" },
      { value: "b", title: "Beta", description: "Second" },
    ];
    const cards = render(h(RadioCards, { value: "b", options, onChange: () => {} }));
    expect(cards).toContain('role="radiogroup"');
    expect(cards.match(/role="radio"/g)).toHaveLength(2);
    expect(cards).toContain('aria-checked="true"');
    const compact = render(
      h(RadioCards, { value: "a", options, onChange: () => {}, compact: true }),
    );
    expect(compact).toContain("divide-y");
    const list = render(
      h(CheckboxList, { name: "t", value: "a", loadOptions: async () => [], onChange: () => {} }),
    );
    expect(list).toContain('aria-busy="true"');
  });

  it("announces an error notice assertively and keeps a disabled button focusable", () => {
    const error = render(
      h(Notice, { tone: "error", action: { label: "Retry", onClick: () => {} } }, "Failed"),
    );
    expect(error).toContain('role="alert"');
    expect(error).toContain("Retry");
    expect(error).not.toMatch(/role="alert"[^>]*>[^<]*Retry/);
    const info = render(h(Notice, null, "FYI"));
    expect(info).not.toContain('role="alert"');
    expect(info).toContain('data-configurator-notice="info"');
    const button = render(h(Button, { onClick: () => {}, disabled: true }, "Go"));
    expect(button).toContain('aria-disabled="true"');
    expect(button).not.toMatch(/\sdisabled=""/);
  });

  it("renders a hierarchy picker with tabs, the root's choice and search", () => {
    const html = render(
      h(
        Field,
        { label: "What to connect" },
        h(HierarchyPicker, {
          name: "target",
          value: "root",
          root: { id: "root", title: "Drive", selectable: true, subtitle: "Everything" },
          tabs: [
            { id: "mine", title: "My Drive", selectable: true },
            { id: "shared", title: "Shared" },
          ],
          loadItems: async () => ({ items: [] }),
          onChange: () => {},
          searchPlaceholder: "Search Drive",
        }),
      ),
    );
    expect(html).toContain("All of Drive");
    expect(html).toContain('role="tab"');
    expect(html).toContain("My Drive");
    expect(html).toContain('aria-label="Search Drive"');
    expect(html).toContain('aria-checked="true"');
  });

  it("opens a node where its path says it lives", () => {
    const tabs = [
      { id: "mine", title: "Mine" },
      { id: "shared", title: "Shared" },
    ];
    const folder = {
      id: "f2",
      title: "Two",
      kind: "container" as const,
      path: [
        { id: "shared", title: "Shared" },
        { id: "f1", title: "One" },
      ],
    };
    const opened = locationOf(folder, tabs, tabs[0] ?? null);
    expect(opened.tab?.id).toBe("shared");
    expect(opened.trail.map((entry) => entry.id)).toEqual(["f1", "f2"]);
    expect(opened.gap).toBe(false);
    // A path that does not name its tab opens in the open tab, with a gap above it.
    const elsewhere = locationOf(
      { ...folder, path: [{ id: "f1", title: "One" }] },
      tabs,
      tabs[0] ?? null,
    );
    expect(elsewhere.tab?.id).toBe("mine");
    expect(elsewhere.gap).toBe(true);
    // A leaf with no path opens nothing.
    const leaf = locationOf({ id: "x", title: "X", kind: "leaf" }, tabs, tabs[1] ?? null);
    expect(leaf).toEqual({ tab: tabs[1], trail: [], gap: false });
  });

  it("renders the createElement path for non-intrinsic types", () => {
    expect(render(createElement(Section, null, "plain"))).toContain("plain");
  });
});
