// The judge seam (ADR 0230, stage 11 AC 1, 3 and 12 for the off path): builders and answer
// validation, every JudgeUnavailable reason and JudgeFault from a stubbed fetch, routing through
// AI Gateway's custom provider or directly, keys never logged or returned, the off path making no
// network call, per-placement switches read lazily, and judge.get / judge.update for human admins
// only. Nothing here reaches the network.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type ActingUser,
  adjudicatorReviewer,
  choice,
  choiceAnswer,
  coreRegistry,
  ForbiddenError,
  fakeJudge,
  invoke,
  JEV_MODEL,
  JUDGE_PLACEMENTS,
  JUDGE_SETTINGS,
  type JudgeCallLog,
  jevJudge,
  judgeFor,
  judgeRoute,
  noul,
  offJudge,
  policyRules,
  resolvePlacements,
  score,
  validateAnswers,
} from "../src/index.ts";
import { context, createUser, db } from "./helpers.ts";

const KEY = "ts-secret-key-do-not-leak";
const GATEWAY_TOKEN = "gw-token-do-not-leak";
const QUESTIONS = {
  greeting: noul("Is `word` a greeting?"),
  language: choice("Which language is `word`?", {
    english: "English",
    other: "Another language",
  }),
};
const OK_BODY = {
  model: JEV_MODEL,
  answers: {
    greeting: { type: "noul", noul: 0.99 },
    language: {
      type: "choice",
      choice: "english",
      confidence: 1,
      probabilities: { english: 1, other: 0 },
    },
  },
  usage: { input_tokens: 329, output_tokens: 48 },
};

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function stub(respond: (sent: Sent, init: RequestInit) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const s = {
      url: String(input),
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    };
    sent.push(s);
    return respond(s, init);
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function direct(
  fetch: typeof globalThis.fetch,
  extra: Partial<Parameters<typeof jevJudge>[0]> = {},
) {
  const route = judgeRoute({ TYPESAFE_API_KEY: KEY });
  if (!route.ready) throw new Error("route not ready");
  const logs: JudgeCallLog[] = [];
  return { judge: jevJudge({ route, fetch, log: (l) => logs.push(l), ...extra }), logs };
}

const ask = (judge: ReturnType<typeof direct>["judge"]) =>
  judge.ask({ placement: "judge.test", state: { word: "hello" }, questions: QUESTIONS });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("questions and answers", () => {
  it("builds Jev's wire shapes", () => {
    expect(QUESTIONS.greeting).toEqual({ type: "noul", instructions: "Is `word` a greeting?" });
    expect(QUESTIONS.language.criteria).toEqual({ english: "English", other: "Another language" });
    expect(score("How urgent?", ["calm", "urgent"])).toEqual({
      type: "score",
      instructions: "How urgent?",
      criteria: ["calm", "urgent"],
    });
    expect(() => choice("one label", { only: "x" })).toThrow(/two labels/);
    expect(() => score("?", ["one"])).toThrow(/2 to 10/);
  });

  it("accepts a whole answer and refuses anything less as incomplete-answer", () => {
    expect(validateAnswers(QUESTIONS, OK_BODY.answers).ok).toBe(true);
    const broken = (answers: unknown) => {
      const r = validateAnswers(QUESTIONS, answers);
      return r.ok ? null : r.unavailable;
    };
    // A question missing.
    expect(broken({ greeting: OK_BODY.answers.greeting })).toMatchObject({
      reason: "incomplete-answer",
      detail: expect.stringMatching(/language/),
    });
    // A label missing from the distribution.
    expect(
      broken({
        ...OK_BODY.answers,
        language: { ...OK_BODY.answers.language, probabilities: { english: 1 } },
      }),
    ).toMatchObject({ reason: "incomplete-answer", detail: expect.stringMatching(/other/) });
    // A non-finite or out-of-range probability.
    expect(
      broken({ ...OK_BODY.answers, greeting: { type: "noul", noul: Number.NaN } }),
    ).toMatchObject({ reason: "incomplete-answer" });
    expect(broken({ ...OK_BODY.answers, greeting: { type: "noul", noul: 1.2 } })).toMatchObject({
      reason: "incomplete-answer",
    });
    // A label that was not offered.
    expect(
      broken({ ...OK_BODY.answers, language: { ...OK_BODY.answers.language, choice: "french" } }),
    ).toMatchObject({ reason: "incomplete-answer" });
    // Answered as the wrong kind.
    expect(broken({ ...OK_BODY.answers, greeting: OK_BODY.answers.language })).toMatchObject({
      reason: "incomplete-answer",
    });
    expect(broken(null)).toMatchObject({ reason: "incomplete-answer" });
  });
});

describe("jevJudge", () => {
  it("asks the pinned model once and returns typed answers, with one log line", async () => {
    const { fetch, sent } = stub(() => json(OK_BODY));
    const { judge, logs } = direct(fetch);
    const out = await ask(judge);
    expect(out).toMatchObject({
      status: "answered",
      model: JEV_MODEL,
      inputTokens: 329,
      source: "live",
    });
    if (out.status !== "answered") throw new Error("unanswered");
    expect(out.answers.greeting.noul).toBe(0.99);
    expect(out.answers.language.probabilities.english).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(sent[0]?.body).toEqual({
      model: JEV_MODEL,
      state: { word: "hello" },
      questions: QUESTIONS,
    });
    expect(logs).toEqual([
      expect.objectContaining({
        msg: "judge call",
        placement: "judge.test",
        outcome: "answered",
        inputTokens: 329,
        probabilities: { greeting: 0.99, language: { english: 1, other: 0 } },
      }),
    ]);
    // The log line never carries the state or the questions.
    expect(JSON.stringify(logs)).not.toMatch(/hello|greeting\?/);
  });

  it.each([
    [401, "key-refused"],
    [403, "key-refused"],
    [402, "no-credit"],
    [429, "rate-limited"],
    [500, "server-error"],
    [503, "server-error"],
    [529, "server-error"],
  ] as const)("HTTP %i is unavailable: %s", async (status, reason) => {
    const { fetch } = stub(() => json({ detail: { message: "nope" } }, status));
    const { judge } = direct(fetch);
    expect(await ask(judge)).toMatchObject({ status: "unavailable", reason, httpStatus: status });
  });

  it.each([400, 413, 415, 422])("HTTP %i is a JudgeFault, logged as an error", async (status) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fetch } = stub(() => json({ detail: [{ msg: "Field required" }] }, status));
    const { judge, logs } = direct(fetch);
    expect(await ask(judge)).toMatchObject({ status: "fault", httpStatus: status });
    expect(errors).toHaveBeenCalledOnce();
    expect(logs).toEqual([]);
  });

  it("an unreachable service, a timeout and an incomplete answer", async () => {
    const down = stub(() => {
      throw new TypeError("fetch failed");
    });
    expect(await ask(direct(down.fetch).judge)).toMatchObject({ reason: "unreachable" });

    const slow = stub(
      (_s, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    expect(await ask(direct(slow.fetch, { timeoutMs: 10 }).judge)).toMatchObject({
      reason: "timeout",
    });

    const partial = stub(() =>
      json({ ...OK_BODY, answers: { greeting: OK_BODY.answers.greeting } }),
    );
    expect(await ask(direct(partial.fetch).judge)).toMatchObject({ reason: "incomplete-answer" });

    const notJson = stub(() => new Response("<html>", { status: 200 }));
    expect(await ask(direct(notJson.fetch).judge)).toMatchObject({ reason: "incomplete-answer" });
  });

  it("retries a 429 or a 5xx only when asked to", async () => {
    let calls = 0;
    const { fetch } = stub(() => (++calls === 1 ? json({}, 429) : json(OK_BODY)));
    const once = direct(fetch);
    expect(await ask(once.judge)).toMatchObject({ reason: "rate-limited" });
    calls = 0;
    const twice = direct(fetch, { retries: 2, sleep: async () => {} });
    expect(await ask(twice.judge)).toMatchObject({ status: "answered" });
    expect(calls).toBe(2);
  });
});

describe("routing and keys", () => {
  it("goes direct with the secret when there is no gateway", () => {
    const route = judgeRoute({ TYPESAFE_API_KEY: KEY });
    expect(route).toMatchObject({ ready: true, viaGateway: false, keySource: "secret" });
    if (!route.ready) return;
    expect(route.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(route.headers("authoring.intent")).toEqual({
      "content-type": "application/json",
      authorization: `Bearer ${KEY}`,
    });
  });

  it("goes through AI Gateway's custom-typesafe provider when the gateway is configured", () => {
    const gateway = {
      AI_GATEWAY_ID: "ros",
      CLOUDFLARE_ACCOUNT_ID: "acct",
      AI_GATEWAY_TOKEN: GATEWAY_TOKEN,
    };
    const withSecret = judgeRoute({ ...gateway, TYPESAFE_API_KEY: KEY });
    if (!withSecret.ready) throw new Error("not ready");
    expect(withSecret.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/ros/custom-typesafe/v1/systemone",
    );
    expect(withSecret.headers("authoring.intent")).toEqual({
      "content-type": "application/json",
      authorization: `Bearer ${KEY}`,
      "cf-aig-metadata": JSON.stringify({ judge: "authoring.intent" }),
      "cf-aig-skip-cache": "true",
      "cf-aig-authorization": `Bearer ${GATEWAY_TOKEN}`,
    });
    // BYOK: the gateway holds the key, so no Authorization header is sent at all.
    const byok = judgeRoute({ ...gateway, JUDGE_BYOK: "true" });
    if (!byok.ready) throw new Error("not ready");
    expect(byok.keySource).toBe("byok");
    expect(byok.headers("summary.statements")).not.toHaveProperty("authorization");
    // BYOK claimed with no gateway and no secret: no key.
    expect(judgeRoute({ JUDGE_BYOK: "true" })).toMatchObject({ ready: false, reason: "no-key" });
  });

  it("on a hosted deployment, calls TypeSafe directly with the tenant's own key, never a gateway", () => {
    const hosted = {
      AI_PLATFORM_GATEWAY_ID: "ros-platform",
      AI_GATEWAY_ID: "ros",
      CLOUDFLARE_ACCOUNT_ID: "acct",
      AI_GATEWAY_TOKEN: GATEWAY_TOKEN,
    };
    const route = judgeRoute({ ...hosted, TYPESAFE_API_KEY: KEY });
    if (!route.ready) throw new Error("not ready");
    expect(route).toMatchObject({ viaGateway: false, keySource: "secret" });
    expect(route.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(Object.keys(route.headers("authoring.intent")).sort()).toEqual([
      "authorization",
      "content-type",
    ]);
    // BYOK needs a gateway of the deployment's own, which a hosted tenant does not have.
    expect(judgeRoute({ ...hosted, JUDGE_BYOK: "true" })).toMatchObject({
      ready: false,
      reason: "off",
    });
  });

  it("never logs the key or the gateway token, on any outcome", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => lines.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => lines.push(a.join(" ")));
    const env = {
      TYPESAFE_API_KEY: KEY,
      AI_GATEWAY_ID: "ros",
      CLOUDFLARE_ACCOUNT_ID: "acct",
      AI_GATEWAY_TOKEN: GATEWAY_TOKEN,
    };
    for (const status of [200, 401, 422, 500]) {
      const echo = stub((s) =>
        json(status === 200 ? OK_BODY : { detail: `echo ${JSON.stringify(s.headers)}` }, status),
      );
      const judge = judgeFor(env, { fetch: echo.fetch });
      await judge.ask({ placement: "judge.test", state: "x", questions: QUESTIONS });
    }
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(KEY);
    expect(lines.join("\n")).not.toContain(GATEWAY_TOKEN);
  });
});

describe("the off path", () => {
  it("with no key, judgeFor is off and makes no network call for any placement", async () => {
    const { fetch, sent } = stub(() => json(OK_BODY));
    const loadSettings = vi.fn(async () => ({ placements: {} }));
    const judge = judgeFor({}, { fetch, loadSettings });
    expect(judge.provider).toBe("off");
    for (const p of JUDGE_PLACEMENTS) {
      expect(await judge.ask({ placement: p.id, state: "x", questions: QUESTIONS })).toEqual({
        status: "unavailable",
        reason: "off",
        detail: expect.any(String),
      });
    }
    expect(sent).toHaveLength(0);
    expect(loadSettings).not.toHaveBeenCalled();
    expect(
      await offJudge.ask({ placement: "judge.test", state: "x", questions: QUESTIONS }),
    ).toEqual({ status: "unavailable", reason: "off" });
  });

  it("a switched-off placement answers off without a call; settings load once, only when asked", async () => {
    const { fetch, sent } = stub(() => json(OK_BODY));
    const loadSettings = vi.fn(async () => ({
      placements: { "authoring.intent": false as const },
    }));
    const judge = judgeFor({ TYPESAFE_API_KEY: KEY }, { fetch, loadSettings, log: () => {} });
    expect(loadSettings).not.toHaveBeenCalled();
    const asked = (placement: "authoring.intent" | "summary.statements" | "judge.test") =>
      judge.ask({ placement, state: "x", questions: QUESTIONS });
    expect(await asked("authoring.intent")).toEqual({ status: "unavailable", reason: "off" });
    // Record content is off by default.
    expect(await asked("summary.statements")).toEqual({ status: "unavailable", reason: "off" });
    expect(await asked("judge.test")).toMatchObject({ status: "answered" });
    expect(sent).toHaveLength(1);
    expect(loadSettings).toHaveBeenCalledOnce();
  });

  it("placements default by the data they send; the deploy var and the admin layer override", () => {
    const shipped = resolvePlacements(undefined, { placements: {} });
    expect(shipped["authoring.intent"]).toEqual({ on: true, source: "shipped" });
    expect(shipped["widget.shape"].on).toBe(true);
    for (const p of JUDGE_PLACEMENTS.filter((p) => p.sendsRecordContent && p.switchable)) {
      expect(shipped[p.id].on).toBe(false);
    }
    expect(shipped["adjudicator.policy"]).toEqual({ on: true, source: "fixed" });
    const deploy = '{"summary.statements":true,"outbound.message":true,"adjudicator.policy":false}';
    const mine = resolvePlacements(deploy, { placements: { "outbound.message": false } });
    expect(mine["summary.statements"]).toEqual({ on: true, source: "deploy" });
    expect(mine["outbound.message"]).toEqual({ on: false, source: "admin" });
    // A placement with no switch ignores the layers.
    expect(mine["adjudicator.policy"]).toEqual({ on: true, source: "fixed" });
    expect(resolvePlacements("not json", { placements: {} })["authoring.intent"].on).toBe(true);
  });

  it("the adjudicator's reviewer is Jev by default only when the judge has a key", () => {
    expect(adjudicatorReviewer({}, false)).toBe("llm");
    expect(adjudicatorReviewer({}, true)).toBe("jev");
    expect(adjudicatorReviewer({ reviewer: "llm" }, true)).toBe("llm");
    expect(adjudicatorReviewer({ reviewer: "jev" }, false)).toBe("llm");
  });
});

describe("fakeJudge", () => {
  it("records each call and validates its script as Jev's answers would be", async () => {
    const judge = fakeJudge({
      greeting: { type: "noul", noul: 0.2 },
      language: choiceAnswer(["english", "other"], "other"),
    });
    const out = await judge.ask({ placement: "judge.test", state: { a: 1 }, questions: QUESTIONS });
    expect(out).toMatchObject({ status: "answered", source: "fake" });
    expect(judge.calls).toEqual([
      { placement: "judge.test", state: { a: 1 }, questions: QUESTIONS },
    ]);
    const missing = fakeJudge({ greeting: { type: "noul", noul: 0.2 } });
    expect(
      await missing.ask({ placement: "judge.test", state: "x", questions: QUESTIONS }),
    ).toMatchObject({ reason: "incomplete-answer" });
  });
});

describe("policyRules", () => {
  it("splits the written policy into numbered rules by line, dropping bullets and headings", () => {
    const rules = policyRules(
      "# Acme policy\n\n- An AI may create tasks for any user.\n* Never change a deal's value.\n  It needs a person.\n2. Tags are fine.\n---\n",
    );
    expect(rules).toEqual([
      { number: 1, text: "An AI may create tasks for any user." },
      { number: 2, text: "Never change a deal's value. It needs a person." },
      { number: 3, text: "Tags are fine." },
    ]);
  });

  it("a section heading qualifies the rules beneath it; the title does not", () => {
    expect(
      policyRules(
        "# Acme policy\n\n## Approve\n- Creating a task.\n\n## Deny:\n1. Deleting records.\n   Ever.\n",
      ),
    ).toEqual([
      { number: 1, text: "Approve: Creating a task." },
      { number: 2, text: "Deny: Deleting records. Ever." },
    ]);
    // Level-1 headings are sections when there is more than one.
    expect(policyRules("# Allowed\n- Tags.\n# Never\n- Deletes.")).toEqual([
      { number: 1, text: "Allowed: Tags." },
      { number: 2, text: "Never: Deletes." },
    ]);
  });
});

describe("judge.get and judge.update", () => {
  let admin: ActingUser;
  let member: ActingUser;
  beforeAll(async () => {
    admin = await createUser("admin");
    member = await createUser("member");
  });

  const mcp = (user: ActingUser) =>
    context(user, {
      actor: "mcp",
      origin: { surface: "mcp", clientId: "c", clientName: "Client", sessionId: "s" },
    });

  it("are for human admins only and never on MCP", async () => {
    for (const name of ["judge.get", "judge.update"]) {
      expect(coreRegistry.get(name)?.mcp?.expose).toBe(false);
      expect(coreRegistry.get(name)?.actors).toEqual(["human"]);
    }
    await expect(invoke("judge.get", {}, mcp(admin))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(invoke("judge.get", {}, context(member))).rejects.toBeInstanceOf(ForbiddenError);
    const off = { placements: { "outbound.message": false } };
    await expect(invoke("judge.update", off, mcp(admin))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      invoke("judge.update", off, context(admin, { actor: "assistant" })),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("switch placements, are audited, and say where the key is but never return it", async () => {
    const aiEnv = { TYPESAFE_API_KEY: "set", JUDGE_PLACEMENTS: '{"summary.statements":true}' };
    const before = await invoke("judge.get", {}, context(admin, { aiEnv }));
    expect(before).toMatchObject({ on: true, keySource: "secret", model: JEV_MODEL });
    expect(before.placements.find((p) => p.id === "summary.statements")).toMatchObject({
      on: true,
      source: "deploy",
      sendsRecordContent: true,
    });
    const after = await invoke(
      "judge.update",
      { placements: { "summary.statements": false, "authoring.intent": null } },
      context(admin, { aiEnv }),
    );
    expect(after.placements.find((p) => p.id === "summary.statements")).toMatchObject({
      on: false,
      source: "admin",
    });
    expect(JSON.stringify(after)).not.toContain(KEY);
    const row = await db.query
      .selectFrom("core_settings")
      .select("value")
      .where("key", "=", JUDGE_SETTINGS)
      .executeTakeFirstOrThrow();
    expect(JSON.parse(row.value)).toEqual({ placements: { "summary.statements": false } });
    const audit = await db.query
      .selectFrom("core_audit")
      .select("operation")
      .where("operation", "=", "judge.update")
      .where("outcome", "=", "ok")
      .where("user_id", "=", admin.id)
      .execute();
    expect(audit).toHaveLength(1);
    await expect(
      invoke("judge.update", { placements: { "adjudicator.policy": false } }, context(admin)),
    ).rejects.toThrow();
  });

  it("without a key, the judge is off and says so", async () => {
    const view = await invoke("judge.get", {}, context(admin, { aiEnv: {} }));
    expect(view).toMatchObject({ on: false, keySource: null, adjudicatorReviewer: "llm" });
  });
});
