// The SDK's list of core fields formulas can read must match the host's field registry, so a
// formula that passes @crm/sdk/testing also passes extension.check.
import { CORE_FORMULA_FIELDS } from "@crm/sdk";
import { describe, expect, it } from "vitest";
import { CORE_TARGETS, coreFormulaFields } from "../src/index.ts";

describe("CORE_FORMULA_FIELDS", () => {
  for (const target of Object.keys(CORE_TARGETS) as (keyof typeof CORE_TARGETS)[]) {
    it(`matches the registry for ${target}`, () => {
      const host = Object.fromEntries(
        Object.entries(coreFormulaFields(target)).map(([name, ref]) => [
          name,
          "type" in ref ? ref.type : "formula",
        ]),
      );
      expect(CORE_FORMULA_FIELDS[target]).toEqual(host);
    });
  }
});
