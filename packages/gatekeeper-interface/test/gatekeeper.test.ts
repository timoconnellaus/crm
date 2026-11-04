// Local test (not from upstream): the interface module is mostly types, so this checks the few
// runtime helpers it exports behave as the upstream JSDoc describes.
import { describe, expect, it } from "vitest";
import {
  AGENT_CATALOG_MAX_ENTRIES,
  boundAgentCatalog,
  matchesResourceUrlPattern,
  resolveRequestedResource,
  type SupportedResource,
  stripTrailingSlashes,
  workerVersionTag,
} from "../src/gatekeeper.ts";

const doc: SupportedResource = {
  urlPattern: "https://docs.google.com/document/d/:id/*",
  title: "Google Doc",
  description: "One document",
};

describe("gatekeeper interface helpers", () => {
  it("matches resource URLs tolerantly", () => {
    expect(
      matchesResourceUrlPattern(doc.urlPattern, "https://docs.google.com/document/d/abc/edit"),
    ).toBe(true);
    expect(matchesResourceUrlPattern(doc.urlPattern, "https://example.com/")).toBe(false);
    expect(stripTrailingSlashes("a///")).toBe("a");
  });

  it("resolves the requested resource or explains why not", () => {
    const other = { ...doc, urlPattern: "https://mail.google.com/*", title: "Gmail" };
    expect(
      resolveRequestedResource([doc, other], "https://docs.google.com/document/d/x/edit"),
    ).toEqual({
      ok: true,
      resource: doc,
    });
    const miss = resolveRequestedResource([doc, other], undefined);
    expect(miss.ok).toBe(false);
  });

  it("bounds agent catalogs", () => {
    const entries = Array.from({ length: AGENT_CATALOG_MAX_ENTRIES + 1 }, (_, i) => ({
      id: `${i}`,
      title: "t",
      description: "d",
    }));
    const bounded = boundAgentCatalog(entries);
    expect(bounded.entries).toHaveLength(AGENT_CATALOG_MAX_ENTRIES);
    expect(bounded.truncated).toBe(true);
  });

  it("reads the version tag defensively", () => {
    expect(workerVersionTag({})).toBeUndefined();
    expect(workerVersionTag({ CF_VERSION_METADATA: { tag: "v1" } })).toBe("v1");
  });
});
