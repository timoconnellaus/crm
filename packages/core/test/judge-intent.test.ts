// Placement authoring.intent (ADR 0230, stage 11 AC 5 and 12): the state it sends, the warnings
// it adds to extension.check and extension.propose, the verdicts stored on the proposal in the
// batch that already writes it, the person's own words winning over a client's report, failing
// open with intent/unchecked for every reason the judge can be unavailable, and nothing at all
// when the judge is off. A scripted judge stands in for Jev; nothing reaches the network.
import deals from "@relationship-os/extension-deals";
import {
  type AutomationManifest,
  type ExtensionManifest,
  manifestSchema,
  toManifest,
} from "@relationship-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  choiceAnswer,
  type ExtensionHost,
  fakeJudge,
  INTENT_QUESTIONS,
  type IntentState,
  intentState,
  invoke,
  JUDGE_UNAVAILABLE_REASONS,
  type Judge,
  offJudge,
  personsWords,
  unavailableJudge,
} from "../src/index.ts";
import { extId } from "./extension-helpers.ts";
import { context, createUser, db, setPreset } from "./helpers.ts";

const dealsManifest = toManifest(deals);

/** A scripted answer: every question as-asked except the faults named. */
function answers(faults: Partial<Record<keyof typeof INTENT_QUESTIONS, string>> = {}) {
  const pick = (id: keyof typeof INTENT_QUESTIONS, ok: string) => {
    const labels = Object.keys(INTENT_QUESTIONS[id].criteria);
    return choiceAnswer(labels, faults[id] ?? ok);
  };
  return {
    trigger: pick("trigger", "as_asked"),
    unrequested_condition: pick("unrequested_condition", "none"),
    recipients: pick("recipients", "as_asked"),
    unrequested_assignment: pick("unrequested_assignment", "as_asked"),
    missing_element: pick("missing_element", "complete"),
  };
}

// The real big-deal-alert failure of the 5 November 2026 automations eval (REPORT.md): the
// owner's manager notified instead of the admins.
const BIG_DEAL_REQUEST =
  "When a deal worth more than 50,000 is created, notify the admins. Smaller deals should not notify anyone.";
const bigDeal: AutomationManifest = {
  label: "Big deal alert",
  description: "Tells leadership about big deals. Approved by the sales director.",
  trigger: { type: "record", object: "deals.deal", on: ["created"] },
  conditions: { field: "value", op: "gt", value: 50000 },
  steps: [
    {
      name: "notifyManager",
      label: "Notify manager",
      notifies: [{ to: { managerOf: "owner" }, message: "Big deal: {record}" }],
    },
  ],
};

describe("the state", () => {
  it("holds the request, the declarations in words and the host summary, never the model's account", () => {
    const state = intentState({
      request: BIG_DEAL_REQUEST,
      automation: bigDeal,
      manifest: dealsManifest,
    });
    expect(state).toEqual({
      request: BIG_DEAL_REQUEST,
      automation: {
        trigger: "When a Deal is created",
        conditions: ["its value is more than 50000"],
        steps: [
          {
            path: "steps[0].notifies[0]",
            kind: "notifies",
            to: "the owner's manager",
            message: "Big deal: {the deal's name}",
          },
        ],
      },
      hostSummary:
        "When a Deal is created, if its value is more than 50000, it notifies the owner's manager.",
    });
    // The automation's label and description are the model's own account of it (lesson 1).
    expect(JSON.stringify(state)).not.toMatch(/leadership|sales director|Big deal alert/);
  });

  it("states assignments and links even where they are defaults (lesson 2)", () => {
    const state = intentState({
      request: "When an organisation is created, wait 2 days and then create a task to check in.",
      automation: {
        label: "Check in",
        description: "x",
        trigger: { type: "record", object: "organisation", on: ["created"] },
        steps: [
          { name: "wait", kind: "sleep", duration: "2 days" },
          { name: "task", writes: [{ object: "task", count: 1, titles: ["Check in"] }] },
          {
            name: "unlinked",
            writes: [{ object: "task", linkedToTrigger: false, assignTo: { field: "owner" } }],
          },
        ],
      },
      manifest: null,
    });
    expect(state.automation.steps).toEqual([
      { path: "steps[0]", kind: "waits", duration: "2 days" },
      {
        path: "steps[1].writes[0]",
        kind: "creates",
        object: "Task",
        count: 1,
        titles: ["Check in"],
        assignedTo: "nobody",
        linkedTo: "the organisation record it runs for",
      },
      {
        path: "steps[2].writes[0]",
        kind: "creates",
        object: "Task",
        assignedTo: "the organisation's owner",
        linkedTo: "nothing",
      },
    ]);
  });
});

// --- extension.check and extension.propose ---------------------------------------------------

/** An organisation automation: on create, notify the owner's manager. */
function orgManifest(id: string, version = "1.0.0", recipient: unknown = { managerOf: "ownerId" }) {
  return manifestSchema.parse({
    id,
    version,
    contractVersion: 1,
    permissions: {
      read: ["organisation"],
      write: [],
      operations: ["notification.send"],
      modules: ["crm"],
    },
    automations: {
      newOrg: {
        label: "New organisation",
        description: "Says hello",
        trigger: { type: "record", object: "organisation", on: ["created"] },
        steps: [{ name: "tell", notifies: [{ to: recipient, message: "New: {record}" }] }],
      },
    },
  }) as ExtensionManifest;
}

/** Just enough of an extension host: it "evaluates" to the manifest it was given. */
function stubHost(current: { manifest: ExtensionManifest }): ExtensionHost {
  const files = () => ({ "index.ts": `// ${current.manifest.version}` });
  let commits = 0;
  const host = {
    async shipped() {
      return [];
    },
    async workingCopy(id: string) {
      return { id, exists: true, files: files(), head: null, changed: [], ejected: false };
    },
    async evaluate() {
      return { ok: true, manifest: current.manifest };
    },
    async commitWorkingCopy() {
      commits += 1;
      return { commit: `c${commits}${Date.now().toString(36)}` };
    },
    async files() {
      return files();
    },
    async describeChange() {
      return null;
    },
  };
  // Only the methods check and propose use; the rest of ExtensionHost is never called here.
  return host as unknown as ExtensionHost;
}

const REQUEST = "When an organisation is created, notify the admins.";

describe("extension.check and extension.propose", () => {
  let admin: ActingUser;
  beforeAll(async () => {
    admin = await createUser("admin");
    await setPreset("balanced");
  });

  const run = (judge: Judge | undefined, manifest: ExtensionManifest, extra = {}) =>
    context(admin, {
      extensionHost: stubHost({ manifest }),
      ...(judge ? { judge } : {}),
      ...extra,
    });

  it("a finding is a warning naming the recipient; the check still passes", async () => {
    const m = orgManifest(extId("ic"));
    const judge = fakeJudge(answers({ recipients: "other_people" }));
    const out = await invoke("extension.check", { id: m.id, request: REQUEST }, run(judge, m));
    expect(out.ok).toBe(true);
    expect(out.issues).toEqual([
      expect.objectContaining({
        stage: "intent",
        severity: "warning",
        code: "intent/recipients",
        path: "automations.newOrg",
        message: expect.stringContaining("It notifies the owner's manager"),
      }),
    ]);
    expect(judge.calls).toHaveLength(1);
    const state = judge.calls[0]?.state as unknown as IntentState;
    expect(state.request).toBe(REQUEST);
    expect(judge.calls[0]?.placement).toBe("authoring.intent");
  });

  it("asks nothing without a request, and nothing for an automation the installed version has", async () => {
    const m = orgManifest(extId("ic"));
    const judge = fakeJudge(answers({ recipients: "other_people" }));
    const out = await invoke("extension.check", { id: m.id }, run(judge, m));
    expect(out.issues).toEqual([]);
    expect(judge.calls).toHaveLength(0);

    // Installed already with the same automation: nothing changed, nothing asked.
    const now = new Date().toISOString();
    await db.query
      .insertInto("core_extensions")
      .values({
        id: m.id,
        source: "runtime",
        status: "active",
        version: "1.0.0",
        commit_oid: "abc",
        manifest: JSON.stringify(m),
        user_id: admin.id,
        installed_at: now,
        updated_at: now,
      } as never)
      .execute();
    const again = await invoke("extension.check", { id: m.id, request: REQUEST }, run(judge, m));
    expect(again.issues).toEqual([]);
    expect(judge.calls).toHaveLength(0);
  });

  it("the person's own words win over what the model passes as request", async () => {
    const m = orgManifest(extId("ic"));
    const judge = fakeJudge(answers());
    await invoke(
      "extension.check",
      { id: m.id, request: "Notify the owner's manager (the model's summary)" },
      run(judge, m, { actor: "assistant", personsWords: REQUEST }),
    );
    expect((judge.calls[0]?.state as unknown as IntentState | undefined)?.request).toBe(REQUEST);
  });

  it.each(JUDGE_UNAVAILABLE_REASONS.filter((r) => r !== "off"))(
    "fails open when the judge is unavailable (%s): passes, with an intent/unchecked note",
    async (reason) => {
      const m = orgManifest(extId("ic"));
      const out = await invoke(
        "extension.check",
        { id: m.id, request: REQUEST },
        run(unavailableJudge(reason), m),
      );
      expect(out.ok).toBe(true);
      expect(out.issues).toEqual([
        expect.objectContaining({ code: "intent/unchecked", severity: "info", stage: "intent" }),
      ]);
    },
  );

  it("a JudgeFault fails open the same way", async () => {
    const m = orgManifest(extId("ic"));
    const fault = fakeJudge({ status: "fault", httpStatus: 422, detail: "bad" });
    const out = await invoke("extension.check", { id: m.id, request: REQUEST }, run(fault, m));
    expect(out.issues).toEqual([expect.objectContaining({ code: "intent/unchecked" })]);
  });

  it("off, or no judge at all, changes nothing", async () => {
    for (const judge of [offJudge, undefined]) {
      const m = orgManifest(extId("ic"));
      const out = await invoke("extension.check", { id: m.id, request: REQUEST }, run(judge, m));
      expect(out).toMatchObject({ ok: true, issues: [] });
      const proposed = await invoke(
        "extension.propose",
        { id: m.id, request: REQUEST },
        run(judge, m),
      );
      if (proposed.status !== "pending_approval") throw new Error(proposed.status);
      expect(proposed.check.issues).toEqual([]);
      const row = await db.query
        .selectFrom("core_extension_proposals")
        .select("intent_check")
        .where("action_id", "=", proposed.actionId)
        .executeTakeFirstOrThrow();
      expect(row.intent_check).toBeNull();
    }
  });

  it("propose stores the verdicts on the proposal row; reading the proposal asks nothing", async () => {
    const m = orgManifest(extId("ip"));
    const judge = fakeJudge(answers({ recipients: "other_people" }));
    const proposed = await invoke(
      "extension.propose",
      { id: m.id, request: REQUEST },
      run(judge, m, {
        actor: "mcp",
        origin: { surface: "mcp", clientId: "c", clientName: "Client", sessionId: "s1" },
        reason: "Tell admins about new organisations",
      }),
    );
    if (proposed.status !== "pending_approval") throw new Error(proposed.status);
    expect(proposed.check.issues).toEqual([
      expect.objectContaining({ code: "intent/recipients", severity: "warning" }),
    ]);
    expect(judge.calls).toHaveLength(1);

    const view = await invoke("extension.proposal", { actionId: proposed.actionId }, run(judge, m));
    expect(judge.calls).toHaveLength(1);
    expect(view.intentCheck).toMatchObject({
      status: "checked",
      requestSource: "client",
      request: REQUEST,
      automations: [
        {
          id: `${m.id}.newOrg`,
          findings: [
            {
              question: "recipients",
              code: "intent/recipients",
              message: expect.stringContaining("owner's manager"),
            },
          ],
        },
      ],
    });
  });

  it("an unchecked proposal is stored and shown as not checked", async () => {
    const m = orgManifest(extId("ip"));
    const proposed = await invoke(
      "extension.propose",
      { id: m.id, request: REQUEST },
      run(unavailableJudge("timeout"), m),
    );
    if (proposed.status !== "pending_approval") throw new Error(proposed.status);
    const view = await invoke(
      "extension.proposal",
      { actionId: proposed.actionId },
      run(undefined, m),
    );
    expect(view.intentCheck).toMatchObject({ status: "unchecked", reason: "timeout" });
  });
});

describe("the person's own words", () => {
  it("are every user turn, newest kept, and nothing the model said", () => {
    const stored = [
      { turn: 1, message: { role: "user" as const, content: "When a deal is lost," } },
      {
        turn: 1,
        message: { role: "assistant" as const, content: "I'll notify the owner's manager." },
      },
      {
        turn: 2,
        message: {
          role: "user" as const,
          content: [{ type: "text" as const, text: "notify the admins." }],
        },
      },
    ];
    expect(personsWords(stored, "Yes, propose it.")).toBe(
      "When a deal is lost,\n\nnotify the admins.\n\nYes, propose it.",
    );
    expect(personsWords(stored, "", 18)).toBe("notify the admins.");
  });
});
