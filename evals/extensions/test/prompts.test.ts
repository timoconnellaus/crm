// The prompts file is well-formed, and every prompt's reference answer is a valid extension that
// meets its expectations (so the predicates accept a right answer in the SDK's real manifest shape).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeSuffix } from "@crm/evals-mcp/lib/harness.ts";
import { EXTENSION_ID_RE, type Extension, toManifest } from "@crm/sdk";
import { createTestHost } from "@crm/sdk/testing";
import { describe, expect, it } from "vitest";
import type { Manifest } from "../lib/manifest.ts";
import { referencePath, referenceSource, rewriteId } from "../lib/reference.ts";
import { extensionIdFor, prompts, promptText } from "../prompts.ts";

const load = async (idBase: string) =>
  ((await import(`../reference/${idBase}.ts`)) as { default: Extension }).default;

describe("prompts", () => {
  it("has 10 prompts with unique ids and id bases", () => {
    expect(prompts).toHaveLength(10);
    expect(new Set(prompts.map((p) => p.id)).size).toBe(10);
    expect(new Set(prompts.map((p) => p.idBase)).size).toBe(10);
    for (const p of prompts) {
      expect(p.title.length, p.id).toBeGreaterThan(5);
      expect(p.covers.length, p.id).toBeGreaterThan(0);
      expect(p.request, p.id).toMatch(/[.?]$/);
    }
  });

  it("makes per-run extension ids the SDK accepts, and names them in the prompt", () => {
    for (let i = 0; i < 50; i++) {
      const word = makeSuffix();
      for (const p of prompts) {
        const id = extensionIdFor(p, word);
        expect(id, p.id).toMatch(EXTENSION_ID_RE);
        expect(id.startsWith(p.idBase)).toBe(true);
      }
    }
    const [first] = prompts;
    if (!first) throw new Error("no prompts");
    const text = promptText(first, "renewalvarodin");
    expect(text).toContain(first.request);
    expect(text).toContain("`renewalvarodin`");
    expect(text).toMatch(/propose it for approval/);
  });

  it("has a reference answer per prompt", () => {
    for (const p of prompts) expect(existsSync(fileURLToPath(referencePath(p))), p.id).toBe(true);
  });

  for (const p of prompts) {
    it(`reference answer for ${p.id} passes the SDK's checks and the prompt's expectations`, async () => {
      const extension = await load(p.idBase);
      expect(extension.id).toBe(p.idBase);
      expect(createTestHost(extension).issues).toEqual([]);
      expect(p.expect(toManifest(extension) as Manifest)).toEqual([]);
    });
  }

  it("rewrites the reference id, including object names, for a run", () => {
    expect(
      rewriteId('id: "tickets", object: "tickets.ticket", x: "ticketsx"', "tickets", "ticketsvar"),
    ).toBe('id: "ticketsvar", object: "ticketsvar.ticket", x: "ticketsx"');
    const ticketPrompt = prompts.find((p) => p.id === "ticket-tool");
    if (!ticketPrompt) throw new Error("ticket-tool missing");
    const source = referenceSource(ticketPrompt, "ticketsvarodin");
    expect(source).toContain('id: "ticketsvarodin"');
    expect(source).toContain('"ticketsvarodin.ticket"');
    expect(source).not.toContain('"tickets"');
  });
});
