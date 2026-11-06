import { describe, expect, it } from "vitest";
import { PLAYOUTS } from "../src/index.ts";

describe("agent-voice", () => {
  it("is a placeholder until voice lands (stage 17, W9)", () => {
    expect(PLAYOUTS).toEqual(["spoken", "partly_spoken", "unspoken"]);
  });
});
