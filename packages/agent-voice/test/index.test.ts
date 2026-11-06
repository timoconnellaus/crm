import { describe, expect, it } from "vitest";
import { callKindOf } from "../src/index.ts";

describe("agent-voice", () => {
  it("reads a voice socket's purpose from its URL", () => {
    expect(callKindOf("https://a.test/s?call=talk")).toBe("talk");
    expect(callKindOf("https://a.test/s?call=dictation")).toBe("dictation");
    expect(callKindOf("https://a.test/s")).toBeNull();
  });
});
