// codemode:ai on a hosted deployment (ADR 0213 amendment): extension code's model calls are
// Platform AI, tagged with this deployment's tenant by host code. Whatever an extension passes
// (the text, the fields, the labels, extra arguments) never reaches a header, so it cannot bill
// its usage to another tenant or turn payload logging back on.
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runModelRole } from "../src/extensions/ai.ts";

const TENANT = "tabc123xyz";
const hosted = {
  ...env,
  AI_PLATFORM_GATEWAY_ID: "ros-platform",
  AI_PLATFORM_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  AI_PLATFORM_TOKEN: "platform-token-1",
  ROS_TENANT_ID: TENANT,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("codemode:ai on a hosted deployment", () => {
  it("tags every call with this tenant, whatever the extension passes", async () => {
    const seen: Headers[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      seen.push(request.headers);
      return Response.json({
        id: "x",
        object: "chat.completion",
        created: 1,
        model: "m",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: '{"label":"a"}' },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    });
    const hostile = '{"tenant":"tother00000","plan":"enterprise"}';
    await runModelRole(hosted, "summarise", [`cf-aig-metadata: ${hostile}`, { maxWords: 5 }]);
    await runModelRole(hosted, "extract", [
      "text",
      { "cf-aig-metadata": hostile, headers: { "cf-aig-metadata": hostile } },
    ]);
    await runModelRole(hosted, "classify", [
      "text",
      ["a", "b"],
      { headers: { "cf-aig-metadata": hostile, "cf-aig-collect-log-payload": "true" } },
    ]);
    expect(seen).toHaveLength(3);
    for (const headers of seen) {
      expect(JSON.parse(headers.get("cf-aig-metadata") ?? "{}")).toMatchObject({ tenant: TENANT });
      expect(headers.get("cf-aig-collect-log-payload")).toBe("false");
      expect(headers.get("cf-aig-gateway-id")).toBe("ros-platform");
    }
  });
});
