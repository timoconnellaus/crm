// Card validation and text fallbacks (ADR 0346): every component validates and has a fallback; a
// model's invalid, unknown or host-only card is refused and shows the words it came with.
import { describe, expect, it } from "vitest";
import {
  A2UI_CATALOGUE_VERSION,
  A2UI_LIMITS,
  a2uiPartSchema,
  CATALOGUE,
  type ComponentType,
  catalogueGuide,
  hrefSchema,
  NO_CARD_TEXT,
  operationNameSchema,
  prepareCard,
  RESERVED_COMPONENTS,
  textFallback,
  validateDocument,
} from "../src/index.ts";
import { SAMPLES, sampleDocument } from "../src/samples.ts";

const types = CATALOGUE.map((c) => c.type);
const version = A2UI_CATALOGUE_VERSION;
const hostOnly = CATALOGUE.filter((c) => "hostOnly" in c && c.hostOnly).map((c) => c.type);

describe("the catalogue", () => {
  it("has a version and unique component types", () => {
    expect(version).toBeGreaterThanOrEqual(1);
    expect(new Set(types).size).toBe(types.length);
  });

  it("has a sample of every component", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...types].sort());
  });

  it("keeps stage 12 to 16 components out until they are built", () => {
    for (const type of RESERVED_COMPONENTS) expect(types).not.toContain(type);
  });

  it("has a catalogue version on every component no newer than the catalogue", () => {
    for (const component of CATALOGUE) expect(component.since).toBeLessThanOrEqual(version);
  });

  it("gives the model a stable guide with every component it may send and none it may not", () => {
    const guide = catalogueGuide();
    expect(guide).toBe(catalogueGuide());
    for (const type of types) {
      const listed = guide.includes(`\n- ${type} `);
      expect(listed, type).toBe(!hostOnly.includes(type));
    }
    expect(guide).toContain("taskList {title:string, tasks:[{id:string, title:string");
    // The tool description sits in the cached prefix: keep it small.
    expect(guide.length).toBeLessThan(10_000);
  });
});

describe.each(types)("%s", (type: ComponentType) => {
  it("validates and has a text fallback", () => {
    const result = validateDocument(sampleDocument(type), { source: "host" });
    expect(result.ok ? [] : result.problems).toEqual([]);
    if (!result.ok) return;
    expect(result.document.root.type).toBe(type);
    expect(result.fallback.trim().length).toBeGreaterThan(0);
    expect(textFallback(result.document)).toBe(result.fallback);
  });

  it("is refused with missing or wrong props", () => {
    const { children: _children, ...sample } = SAMPLES[type] as Record<string, unknown>;
    const broken = Object.fromEntries(
      Object.keys(sample).map((key) => [key, key === "type" ? type : { wrong: true }]),
    );
    // These two have no props of their own to get wrong.
    if (type === "divider" || type === "stack") return;
    expect(validateDocument({ a2ui: version, root: broken }, { source: "host" }).ok).toBe(false);
  });
});

describe("who may send what", () => {
  it("lets only the host send system cards", () => {
    expect(hostOnly).toContain("approval");
    for (const type of hostOnly) {
      for (const source of ["model", "producer"] as const) {
        const result = validateDocument(sampleDocument(type), { source });
        expect(result.ok).toBe(false);
        expect(result.ok ? "" : result.problems.join()).toContain("only the app itself");
      }
    }
  });

  it("refuses a host-only component nested inside a card from a model", () => {
    const card = { a2ui: version, root: { type: "card", children: [SAMPLES.approval] } };
    expect(validateDocument(card, { source: "model" }).ok).toBe(false);
    expect(validateDocument(card, { source: "host" }).ok).toBe(true);
  });
});

describe("invalid cards", () => {
  const model = { source: "model" as const };

  it("refuses anything that is not a card", () => {
    for (const input of [null, 1, "card", [], {}, { a2ui: 1 }, { a2ui: "1", root: {} }]) {
      expect(validateDocument(input, model).ok).toBe(false);
    }
  });

  it("refuses unknown and reserved components", () => {
    const unknown = validateDocument({ a2ui: version, root: { type: "iframe" } }, model);
    expect(unknown.ok ? "" : unknown.problems.join()).toContain("unknown component iframe");
    const reserved = validateDocument({ a2ui: version, root: { type: "leadCard" } }, model);
    expect(reserved.ok ? "" : reserved.problems.join()).toContain("not in this catalogue yet");
  });

  it("refuses a bad child, not just a bad root", () => {
    const card = {
      a2ui: version,
      root: { type: "card", children: [{ type: "text", text: "ok" }, { type: "script" }] },
    };
    expect(validateDocument(card, model).ok).toBe(false);
  });

  it("refuses cards too deep, too many components or too large", () => {
    let deep: Record<string, unknown> = { type: "text", text: "x" };
    for (let i = 0; i <= A2UI_LIMITS.maxDepth; i++) deep = { type: "stack", children: [deep] };
    expect(validateDocument({ a2ui: version, root: deep }, model).ok).toBe(false);

    const row = Array.from({ length: 20 }, () => ({ type: "text", text: "x" }));
    const wide = Array.from({ length: 4 }, () => ({ type: "stack", children: row }));
    expect(
      validateDocument({ a2ui: version, root: { type: "stack", children: wide } }, model).ok,
    ).toBe(false);

    const big = { a2ui: version, root: { type: "text", text: "x".repeat(70_000) } };
    expect(validateDocument(big, model).ok).toBe(false);
  });

  it("refuses more than four buttons, and script links", () => {
    const button = { kind: "open", label: "Open", href: "/tasks" };
    const five = { type: "actions", actions: [button, button, button, button, button] };
    expect(validateDocument({ a2ui: version, root: five }, model).ok).toBe(false);
    for (const href of ["javascript:alert(1)", "//evil.example", "http://evil.example", "data:x"]) {
      expect(hrefSchema.safeParse(href).success, href).toBe(false);
      const link = { type: "link", label: "x", href };
      expect(validateDocument({ a2ui: version, root: link }, model).ok, href).toBe(false);
    }
    expect(hrefSchema.safeParse("/people/per_1").success).toBe(true);
    expect(hrefSchema.safeParse("https://meet.google.com/x").success).toBe(true);
  });

  it("takes images only from the app's own storage", () => {
    const image = { type: "image", src: "https://evil.example/x.png", alt: "x" };
    expect(validateDocument({ a2ui: version, root: image }, model).ok).toBe(false);
  });

  it("names operations, and nothing else, in actions", () => {
    expect(operationNameSchema.safeParse("task.complete").success).toBe(true);
    expect(operationNameSchema.safeParse("x.deals.stageMetrics").success).toBe(true);
    expect(operationNameSchema.safeParse("fetch('x')").success).toBe(false);
  });

  it("drops props the catalogue does not know", () => {
    const result = validateDocument(
      { a2ui: version, root: { type: "text", text: "hi", onClick: "alert(1)" } },
      model,
    );
    expect(result.ok && result.document.root).toEqual({ type: "text", text: "hi" });
  });
});

describe("versions", () => {
  it("refuses a card for a newer catalogue than the host renders", () => {
    const result = validateDocument(
      { a2ui: version + 1, root: { type: "text", text: "hi" } },
      { source: "producer" },
    );
    expect(result.ok ? "" : result.problems.join()).toContain(`up to ${version}`);
  });

  it("honours a host that renders an older catalogue", () => {
    const card = { a2ui: 2, root: { type: "text", text: "hi" } };
    expect(validateDocument(card, { source: "model", supportedVersion: 1 }).ok).toBe(false);
  });
});

describe("what the thread stores", () => {
  it("keeps a valid card with its fallback", () => {
    const part = prepareCard(sampleDocument("taskList"), { source: "model", text: "Your tasks" });
    expect(a2uiPartSchema.parse(part)).toEqual(part);
    expect(part.document?.root.type).toBe("taskList");
    expect(part.fallback).toContain("Due this week (4 tasks)");
    expect(part.fallback).toContain("2. Chase Kestrel NDA");
    expect(part.problems).toBeUndefined();
  });

  it("keeps an invalid card as its words, with the reasons and no document", () => {
    const part = prepareCard(
      { a2ui: version, root: { type: "marquee" } },
      { source: "model", text: "You have two tasks." },
    );
    expect(part.document).toBeNull();
    expect(part.fallback).toBe("You have two tasks.");
    expect(part.problems?.join()).toContain("unknown component marquee");
  });

  it("always has some text", () => {
    const part = prepareCard({ nonsense: true }, { source: "model" });
    expect(part.fallback).toBe(NO_CARD_TEXT);
    const empty = { a2ui: version, root: { type: "stack" } };
    expect(prepareCard(empty, { source: "model" }).fallback).toBe(NO_CARD_TEXT);
    expect(prepareCard(empty, { source: "model", text: "Words" }).fallback).toBe("Words");
  });

  it("names the producer that made a card", () => {
    const part = prepareCard(sampleDocument("dealList"), {
      source: "producer",
      producer: "pipeline.staleDealsCard@1",
    });
    expect(part.producer).toBe("pipeline.staleDealsCard@1");
  });

  it("numbers lists in the fallback, so the model can say the second one", () => {
    expect(prepareCard(sampleDocument("recordList"), { source: "model" }).fallback).toContain(
      "2. Nora Webb",
    );
    expect(prepareCard(sampleDocument("dealList"), { source: "model" }).fallback).toContain(
      "2. Kestrel Energy expansion",
    );
  });
});
