// The renderer with an injected component map: it draws only catalogue components it was given,
// and shows the text fallback for anything it cannot draw safely.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { type A2uiDocument, prepareCard } from "../src/index.ts";
import {
  A2uiView,
  type ActionHandler,
  type ComponentMap,
  mergeInput,
  submitAction,
} from "../src/render.tsx";

const components: ComponentMap = {
  card: ({ props, children }) => (
    <section>
      <h2>{props.title}</h2>
      {children}
    </section>
  ),
  text: ({ props }) => <p>{props.text}</p>,
};
const onAction: ActionHandler = async () => ({ ok: true });
const card: A2uiDocument = {
  a2ui: 1,
  root: { type: "card", title: "Hello", children: [{ type: "text", text: "World" }] },
};

function html(part: ReturnType<typeof prepareCard>, map = components) {
  return renderToStaticMarkup(<A2uiView part={part} components={map} onAction={onAction} />);
}

describe("A2uiView", () => {
  it("renders a card with the host's components", () => {
    const out = html(prepareCard(card, { source: "model" }));
    expect(out).toBe("<section><h2>Hello</h2><p>World</p></section>");
  });

  it("shows the fallback for a card that was invalid when stored", () => {
    const out = html(
      prepareCard({ a2ui: 1, root: { type: "nope" } }, { source: "model", text: "Plain words" }),
    );
    expect(out).toContain("Plain words");
    expect(out).not.toContain("nope");
  });

  it("validates again before drawing, so a stored document is never trusted", () => {
    const part = { ...prepareCard(card, { source: "model" }), fallback: "The words" };
    const out = html({
      ...part,
      document: { a2ui: 1, root: { type: "approval", changeSetId: "aps_1" } },
    });
    expect(out).toContain("The words");
  });

  it("shows the fallback when the host has no renderer for a component in the card", () => {
    const onFallback = vi.fn();
    const out = renderToStaticMarkup(
      <A2uiView
        part={prepareCard(card, { source: "model" })}
        components={{ text: components.text }}
        onAction={onAction}
        onFallback={onFallback}
      />,
    );
    expect(out).toContain("Hello");
    expect(out).not.toContain("<section>");
    expect(onFallback).toHaveBeenCalledWith("no renderer for card");
  });

  it("shows the fallback for a card newer than the host renders", () => {
    const part = prepareCard(card, { source: "model" });
    const out = renderToStaticMarkup(
      <A2uiView
        part={{ ...part, document: { ...card, a2ui: 99 } }}
        components={components}
        onAction={onAction}
      />,
    );
    expect(out).toContain("data-a2ui-fallback");
  });

  it("uses the host's fallback component", () => {
    const out = renderToStaticMarkup(
      <A2uiView
        part={prepareCard({}, { source: "model", text: "Words" })}
        components={components}
        onAction={onAction}
        Fallback={({ text }) => <em>{text}</em>}
      />,
    );
    expect(out).toBe("<em>Words</em>");
  });
});

describe("action input", () => {
  it("merges field values into the fixed input, dotted names into objects", () => {
    expect(
      mergeInput(
        { object: "deals.deal", values: { stage: "a" } },
        { "values.name": "Pilot", note: "x" },
      ),
    ).toEqual({ object: "deals.deal", values: { stage: "a", name: "Pilot" }, note: "x" });
  });

  it("does not change the card's own input", () => {
    const input = { values: { stage: "a" } };
    mergeInput(input, { "values.stage": "b" });
    expect(input.values.stage).toBe("a");
  });

  it("will not write through __proto__", () => {
    const out = mergeInput({}, { "__proto__.polluted": true, "constructor.prototype.x": 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(out)).toEqual([]);
  });

  it("turns a form's submit into an operation action", () => {
    expect(
      submitAction({ label: "Save", operation: "task.create", input: { a: 1 }, done: "Saved" }),
    ).toEqual({
      kind: "operation",
      label: "Save",
      operation: "task.create",
      input: { a: 1 },
      done: "Saved",
    });
  });
});
