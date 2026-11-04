// "Enrich now" (stage 6a): a manual ZoomInfo enrichment is an outbound action. A person's click
// applies it and fills empty fields through the pipeline; an AI's request waits for approval;
// without a ZoomInfo connection nothing happens.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type IntegrationCallResult,
  type IntegrationRuntime,
  invokeByName,
  newId,
} from "../src/index.ts";
import { context, createUser, unique } from "./helpers.ts";

let admin: ActingUser;
const calls: { method: string; actor: string }[] = [];

function runtime(): IntegrationRuntime {
  const no = () => Promise.reject(new Error("unused"));
  return {
    availableVendors: async () => ["zoominfo"],
    startConnect: no,
    provision: no,
    redeem: no,
    reconnect: no,
    disconnect: no,
    bindResource: no,
    unbindResource: no,
    supportedResources: no,
    configure: no,
    types: no,
    applyOutbound: no,
    rejectOutbound: no,
    setSync: no,
    syncNow: no,
    call: async (input): Promise<IntegrationCallResult> => {
      calls.push({ method: input.method, actor: input.caller.actor });
      if (input.method === "getEnrichmentResult") {
        return {
          value: {
            status: "ready",
            kind: "companies",
            result: [
              {
                status: "matched",
                record: { website: "https://acme.example", primaryIndustry: "Software" },
              },
            ],
          },
          pending: [],
          applied: [],
        };
      }
      if (input.caller.actor !== "human") {
        return {
          value: { id: 1, kind: "companies", summary: "Acme" },
          pending: [
            {
              status: "pending_approval",
              changeSetId: "chs_x",
              actionId: "pac_x",
              operation: "integration.outbound",
              provisionalIds: [],
              dependsOn: [],
              expiresAt: "",
              simulated: null,
              message: "",
            },
          ],
          applied: [],
        };
      }
      return {
        value: { id: 1, kind: "companies", summary: "Acme" },
        pending: [],
        applied: [{ action: 1, actionKind: null, title: "Enrich" }],
      };
    },
  };
}

beforeAll(async () => {
  admin = await createUser("admin");
});

describe("enrichment.enrichNow", () => {
  it("is unavailable without a ZoomInfo connection", async () => {
    await env.DB.prepare(
      "UPDATE core_integration_connection SET status = 'disconnected' WHERE vendor = 'zoominfo'",
    ).run();
    const org = (await invokeByName(
      "organisation.create",
      { name: unique("Acme") },
      context(admin),
    )) as { id: string };
    const out = await invokeByName(
      "enrichment.enrichNow",
      { object: "organisation", id: org.id },
      { ...context(admin), integrations: runtime() },
    );
    expect(out).toMatchObject({ status: "unavailable" });
  });

  it("applies for a person's click and fills empty fields; waits for an AI", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO core_integration_connection (id, vendor, scope, owner_user_id, title, status, resources, created_at, updated_at) VALUES (?, 'zoominfo', 'org', ?, 'ZoomInfo', 'active', ?, ?, ?)",
    )
      .bind(
        newId("connection"),
        admin.id,
        JSON.stringify([
          {
            key: "acct",
            url: "https://x",
            pattern: "https://*",
            title: "Account",
            tsType: "ZoomInfoSession",
            bindingName: "ZOOMINFO",
          },
        ]),
        now,
        now,
      )
      .run();
    const org = (await invokeByName(
      "organisation.create",
      { name: unique("Acme") },
      context(admin),
    )) as { id: string };
    const out = await invokeByName(
      "enrichment.enrichNow",
      { object: "organisation", id: org.id },
      { ...context(admin), integrations: runtime() },
    );
    expect(out).toMatchObject({ status: "applied", filled: ["website", "industry"] });
    const after = (await invokeByName("organisation.get", { id: org.id }, context(admin))) as {
      website: string;
      industry: string;
    };
    expect(after).toMatchObject({ website: "https://acme.example", industry: "Software" });

    const queued = await invokeByName(
      "enrichment.enrichNow",
      { object: "organisation", id: org.id },
      {
        ...context(admin, { actor: "mcp", origin: { surface: "mcp", sessionId: "cap_x" } }),
        integrations: runtime(),
      },
    );
    expect(queued).toMatchObject({ status: "pending", pendingActionId: "pac_x" });
    expect(calls.filter((c) => c.method === "enrichCompanies").map((c) => c.actor)).toEqual([
      "human",
      "mcp",
    ]);
  });
});
