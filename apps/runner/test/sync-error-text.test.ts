// Sync errors are kept in the host's storage and mirrored to D1; they must not hold mail
// addresses an erase could not find (ADR 0019 amendment, erase completeness).
import { describe, expect, it } from "vitest";
import { syncErrorText } from "../src/integrations/host.ts";

describe("syncErrorText", () => {
  it("replaces mail addresses in a sync error", () => {
    const text = syncErrorText(
      new Error('Invalid recipient "Ada.Lovelace@Example.co.uk" and <bob+tag@corp.example>'),
    );
    expect(text).toBe('Invalid recipient "[address]" and <[address]>');
    expect(text.toLowerCase()).not.toContain("example");
  });

  it("keeps errors without addresses and bounds their length", () => {
    expect(syncErrorText("rate limited (429)")).toBe("rate limited (429)");
    expect(syncErrorText(new Error("x".repeat(2000)))).toHaveLength(500);
  });
});
