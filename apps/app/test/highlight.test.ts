import { describe, expect, it } from "vitest";
import { highlightLine } from "../src/components/approvals/highlight.ts";

describe("highlightLine", () => {
  it("splits a line into keyword, string, number, type and comment tokens losslessly", () => {
    const line = `export const x: Foo = call("hi", 42); // note`;
    const tokens = highlightLine(line);
    expect(tokens.map((t) => t.text).join("")).toBe(line);
    const kind = (text: string) => tokens.find((t) => t.text === text)?.kind;
    expect(kind("export")).toBe("keyword");
    expect(kind("const")).toBe("keyword");
    expect(kind('"hi"')).toBe("string");
    expect(kind("42")).toBe("number");
    expect(kind("Foo")).toBe("type");
    expect(kind("// note")).toBe("comment");
  });

  it("copes with unterminated strings and empty lines", () => {
    expect(highlightLine("")).toEqual([]);
    expect(highlightLine("'open").map((t) => t.kind)).toEqual(["string"]);
  });
});
