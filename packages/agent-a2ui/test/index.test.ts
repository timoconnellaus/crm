import { describe, expect, it } from "vitest";
import { A2UI_CATALOGUE_VERSION } from "../src/index.ts";

describe("agent-a2ui", () => {
  it("is a placeholder until the catalogue lands (stage 17, W6)", () => {
    expect(A2UI_CATALOGUE_VERSION).toBe(0);
  });
});
