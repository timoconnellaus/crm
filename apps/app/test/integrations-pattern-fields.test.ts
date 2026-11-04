// The generic resource picker's fields and URLs, for resource types without a configurator spec.
import { describe, expect, it } from "vitest";
import { patternForm } from "../src/components/integrations/pattern-fields.ts";

describe("patternForm", () => {
  it("has one field per named group and builds the URL", () => {
    const form = patternForm("fake://mailbox/:address");
    expect(form.fields).toEqual([{ name: "address", label: "Address", regex: null }]);
    expect(form.build({ address: " ada@example.test " })).toEqual({
      url: "fake://mailbox/ada@example.test",
    });
    expect(form.build({ address: "" })).toEqual({ error: "Enter the address" });
  });

  it("checks a group's own regex and encodes values", () => {
    const form = patternForm("https://chat.google.com/:kind(room|dm)/:spaceId");
    expect(form.fields.map((f) => f.label)).toEqual(["Kind", "Space id"]);
    expect(form.build({ kind: "x", spaceId: "1" })).toEqual({ error: "Kind must match room|dm" });
    expect(form.build({ kind: "dm", spaceId: "a/b" })).toEqual({
      url: "https://chat.google.com/dm/a%2Fb",
    });
  });

  it("falls back to a whole URL for wildcards and optional segments", () => {
    for (const pattern of ["https://*", "https://x.test/:a{/:b}?", "fake://static"]) {
      const form = patternForm(pattern);
      expect(form.fields).toEqual([{ name: "url", label: "Resource URL", regex: null }]);
      expect(form.build({ url: "https://x.test/1" })).toEqual({ url: "https://x.test/1" });
    }
  });
});
