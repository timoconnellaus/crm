// runPrompt end to end with a scripted model and an in-memory extension workspace that follows
// the extension_* tool contract: write the working copy, check it, propose it, then the grader's
// own check of the working copy and the prompt's expectations.
import { fakeSession, reply, scriptedModel, toolCall } from "@crm/evals-mcp/test/fakes.ts";
import { describe, expect, it } from "vitest";
import { type ExtensionsHarnessDeps, runPrompt } from "../lib/harness.ts";
import type { Manifest } from "../lib/manifest.ts";
import { prompts } from "../prompts.ts";

const renewal = prompts.find((p) => p.id === "renewal-date");
if (!renewal) throw new Error("renewal-date prompt missing");

const ID = "renewalvarodin";

/** index.ts as the fake understands it: a manifest in a comment; BROKEN fails the check. */
const source = (manifest: Manifest, broken = false) =>
  `${broken ? "// BROKEN\n" : ""}// manifest: ${JSON.stringify(manifest)}\n`;

const good: Manifest = {
  id: ID,
  fields: { organisation: { renewalDate: { type: "date", label: "Renewal date" } } },
};
const wrong: Manifest = {
  id: ID,
  fields: { organisation: { renewalNote: { type: "text", label: "Renewal" } } },
};

const ISSUE = {
  stage: "formula",
  code: "formula_unknown_field",
  path: "fields.organisation.x.expression",
  message: "Unknown field renewal",
  suggestion: "Use renewalDate",
};

/** The workspace is shared by every session (one org); each session sees the same tools. */
function fakeWorkspace() {
  const files = new Map<string, string>();
  let commits = 0;
  const check = (id: string) => {
    const src = files.get(id);
    if (src === undefined) return { isError: true, error: { code: "not_found" } };
    const manifest = JSON.parse(src.split("// manifest: ")[1] ?? "null") as Manifest | null;
    const broken = src.includes("BROKEN");
    return {
      ok: !broken,
      issues: broken ? [ISSUE] : [],
      manifest,
      plan: broken ? null : { ddl: ["CREATE TABLE …"], changes: [{ kind: "addField" }] },
    };
  };
  const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
    extension_list: () => ({ items: [], workspace: [...files.keys()].map((id) => ({ id })) }),
    extension_write: (args) => {
      const written = args.files as Record<string, string>;
      files.set(String(args.id), written["index.ts"] ?? "");
      return { id: args.id, files: ["index.ts"], changed: ["index.ts"] };
    },
    extension_check: (args) => check(String(args.id)),
    extension_propose: (args) => {
      const result = check(String(args.id)) as { ok?: boolean; issues?: unknown[] };
      if (!result.ok) return { status: "check_failed", issues: result.issues };
      commits += 1;
      return {
        status: "pending_approval",
        actionId: `act_${commits}`,
        changeSetId: `cs_${commits}`,
        commit: `c0ffee${commits}`,
        impact: {},
        check: result,
      };
    },
  };
  handlers.call_operation = (args) => {
    const handler = handlers[String(args.name).replace(/\./g, "_")];
    return handler ? handler((args.input ?? {}) as Record<string, unknown>) : { isError: true };
  };
  return { files, handlers };
}

function deps(script: ReturnType<typeof scriptedModel>, workspace = fakeWorkspace()) {
  const sessions: ReturnType<typeof fakeSession>[] = [];
  const names: string[] = [];
  const value: ExtensionsHarnessDeps = {
    openSession: async (clientName) => {
      names.push(clientName);
      const session = fakeSession(workspace.handlers, "CRM instructions");
      sessions.push(session);
      return session;
    },
    model: script.model,
    modelId: "@cf/test/model",
    maxTurns: 10,
    today: "2026-11-04",
    suffix: () => "Varodin",
  };
  return { value, sessions, names, workspace };
}

const write = (manifest: Manifest, broken = false) =>
  toolCall("extension_write", {
    id: ID,
    files: { "index.ts": source(manifest, broken) },
    reason: "Add a renewal date",
  });
const check = () => toolCall("extension_check", { id: ID });
const propose = (id = ID) => toolCall("extension_propose", { id, reason: "Renewal date" });

describe("runPrompt", () => {
  it("passes when the model fixes its check issues and proposes a manifest with the field", async () => {
    const script = scriptedModel([
      reply(null, [write(good, true)]),
      reply(null, [check()]),
      reply("Fixing the formula.", [write(good)]),
      reply(null, [check()]),
      reply(null, [propose()]),
      reply("Proposed renewalvarodin; it is waiting for approval."),
    ]);
    const { value, sessions, names } = deps(script);
    const result = await runPrompt(renewal, value);

    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.requestedId).toBe(ID);
    expect(result.extensionId).toBe(ID);
    expect(result.proposal).toEqual({
      extensionId: ID,
      turn: 5,
      actionId: "act_1",
      changeSetId: "cs_1",
      commit: "c0ffee1",
    });
    expect(result.finalCheck).toEqual({ ok: true, issues: [] });
    expect(result.issuesSeen).toEqual([{ ...ISSUE, turn: 2, tool: "extension_check" }]);
    expect(result.counts).toEqual({ writes: 2, checks: 2, proposes: 1, toolCalls: 5 });
    expect(result.toolCalls.at(-1)).toBe("extension_propose ⏳");
    expect(result.turns).toBe(6);
    expect(result.notes).toEqual([]);

    // The model's prompt names the id; the grader checks on its own connection afterwards.
    expect(script.requests[0]?.messages[1]?.content).toContain("`renewalvarodin`");
    expect(script.requests[0]?.messages[0]?.content).toContain("Today's date is 2026-11-04");
    expect(names).toEqual([
      "Extensions eval grader (renewal-date)",
      "Agent extensions eval (renewal-date)",
    ]);
    expect(sessions[0]?.calls).toEqual([{ name: "extension_check", args: { id: ID } }]);
    expect(sessions.every((s) => s.closed)).toBe(true);
  });

  it("fails when the model never proposes", async () => {
    const script = scriptedModel([reply(null, [write(good)]), reply("Written, not proposed.")]);
    const { value, sessions } = deps(script);
    const result = await runPrompt(renewal, value);
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual([
      { kind: "propose", message: "the model never called extension_propose" },
    ]);
    expect(result.extensionId).toBeNull();
    // Nothing to grade, so the grader made no call.
    expect(sessions[0]?.calls).toEqual([]);
  });

  it("does not count a check_failed proposal, and records its issues", async () => {
    const script = scriptedModel([
      reply(null, [write(good, true)]),
      reply(null, [propose()]),
      reply("The check failed; I could not fix it."),
    ]);
    const result = await runPrompt(renewal, deps(script).value);
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual([
      {
        kind: "propose",
        message:
          "no extension_propose came back pending_approval (1 attempt(s); the last came back check_failed)",
      },
    ]);
    expect(result.issuesSeen).toEqual([{ ...ISSUE, turn: 2, tool: "extension_propose" }]);
  });

  it("fails when the working copy no longer passes check after the proposal", async () => {
    const script = scriptedModel([
      reply(null, [write(good)]),
      reply(null, [propose()]),
      reply(null, [write(good, true)]),
      reply("Done."),
    ]);
    const result = await runPrompt(renewal, deps(script).value);
    expect(result.failures).toEqual([
      {
        kind: "check",
        message:
          "the working copy does not pass check: formula/formula_unknown_field at fields.organisation.x.expression: Unknown field renewal",
      },
    ]);
    expect(result.finalCheck?.ok).toBe(false);
  });

  it("fails on unmet expectations even when check and propose succeed", async () => {
    const script = scriptedModel([
      reply(null, [write(wrong)]),
      reply(null, [propose()]),
      reply("Done."),
    ]);
    const result = await runPrompt(renewal, deps(script).value);
    expect(result.failures).toEqual([
      {
        kind: "expectation",
        message: "no date field mentioning renewal on organisation (has: renewalNote: text)",
      },
    ]);
  });

  it("recognises a proposal through call_operation, and notes a different id", async () => {
    const other = "renewals";
    const script = scriptedModel([
      reply(null, [
        toolCall("extension_write", {
          id: other,
          files: { "index.ts": source({ ...good, id: other }) },
          reason: "r",
        }),
      ]),
      reply(null, [
        toolCall("call_operation", {
          name: "extension.propose",
          input: { id: other, reason: "r" },
        }),
      ]),
      reply("Proposed."),
    ]);
    const { value, sessions } = deps(script);
    const result = await runPrompt(renewal, value);
    expect(result.passed).toBe(true);
    expect(result.extensionId).toBe(other);
    expect(result.notes).toEqual([`proposed extension ${other}, not the requested ${ID}`]);
    expect(sessions[0]?.calls[0]).toEqual({ name: "extension_check", args: { id: other } });
  });

  it("keeps a proposal made before the turn limit, with a note", async () => {
    const script = scriptedModel([
      reply(null, [write(good)]),
      reply(null, [propose()]),
      reply(null, [check()]),
    ]);
    const result = await runPrompt(renewal, { ...deps(script).value, maxTurns: 3 });
    expect(result.passed).toBe(true);
    expect(result.notes).toEqual(["Stopped after 3 model turns without finishing"]);
  });

  it("fails clearly when the server offers no authoring tools (not an admin)", async () => {
    const { value } = deps(scriptedModel([]));
    const result = await runPrompt(renewal, {
      ...value,
      openSession: async () => fakeSession({ query_sql: () => ({ rows: [] }) }),
    });
    expect(result.passed).toBe(false);
    expect(result.failures[0]?.kind).toBe("error");
    expect(result.failures[0]?.message).toMatch(/extension_write.*must be an admin/);
  });

  it("records a model error as a failure, and rethrows fatal ones", async () => {
    const result = await runPrompt(renewal, deps(scriptedModel([])).value);
    expect(result.failures).toEqual([{ kind: "error", message: "the script ran out" }]);
    const fatal = { ...deps(scriptedModel([])).value, isFatal: () => true };
    await expect(runPrompt(renewal, fatal)).rejects.toThrow("the script ran out");
  });
});
