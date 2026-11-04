// Smoke test for the ADR 0006 spike: Workspace + Worker Loader + host modules in workerd.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

function workspace(name: string) {
  return env.SPIKE_WORKSPACE.get(env.SPIKE_WORKSPACE.idFromName(name));
}

describe("dynamic runtime spike", () => {
  it("runs a module in a Dynamic Worker and calls the codemode:crm host module", async () => {
    const result = await workspace("t1").exec(
      `import { getPerson } from "codemode:crm";
       export default async (input) => ({ person: await getPerson(input.id), double: input.n * 2 });`,
      { input: { id: "p1", n: 21 } },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.valueJson)).toEqual({
      person: { id: "p1", name: "Ada Lovelace", email: "ada@example.com" },
      double: 42,
    });
  });

  it("has no network access", async () => {
    const result = await workspace("t2").exec(
      `export default async () => (await fetch("https://example.com")).status;`,
    );
    expect(result.exitCode).not.toBe(0);
  });
});
