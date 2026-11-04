// Every reference answer passes the SDK contract check (validateManifest, with the automation
// checks) against an install that has Deals, so the stand-in model's answers are ones the real
// `extension.check` accepts.
import deals from "@crm/extension-deals";
import { type FieldTypeName, toManifest, validateManifest } from "@crm/sdk";
import { describe, expect, it } from "vitest";
import { REFERENCES } from "../lib/reference.ts";

const dealsManifest = toManifest(deals);
const knownObjects = Object.keys(dealsManifest.objects).map((name) => `deals.${name}`);
const objectFields = (object: string): Record<string, FieldTypeName> | null => {
  const local = object.startsWith("deals.") ? dealsManifest.objects[object.slice(6)] : undefined;
  return local
    ? Object.fromEntries(Object.entries(local.fields).map(([name, f]) => [name, f.type]))
    : null;
};

describe("reference answers", () => {
  it.each(Object.entries(REFERENCES))("%s passes the contract check", (_id, ref) => {
    const { issues } = validateManifest(
      {
        id: "evalauto",
        version: "1.0.0",
        contractVersion: 1,
        permissions: { ...ref.permissions, modules: ["crm"] },
        automations: {
          [ref.key]: {
            label: ref.label,
            description: ref.description,
            trigger: ref.trigger,
            ...(ref.conditions ? { conditions: ref.conditions } : {}),
            steps: ref.steps,
          },
        },
      },
      { knownObjects, objectFields },
    );
    expect(issues).toEqual([]);
  });
});
