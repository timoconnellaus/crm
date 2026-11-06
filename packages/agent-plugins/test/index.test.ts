import { describe, expect, it } from "vitest";
import { PLUGIN_SCOPES } from "../src/index.ts";

describe("agent-plugins", () => {
  it("is a placeholder until plugins land (stage 17, W7)", () => {
    expect(PLUGIN_SCOPES).toEqual(["personal", "team", "org"]);
  });
});
