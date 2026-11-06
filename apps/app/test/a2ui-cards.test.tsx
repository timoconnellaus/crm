// The CRM's cards (stage 17 acceptance 9): every catalogue component renders with packages/ui at
// the docked panel's width and a phone's, and has a text fallback. The Playwright gallery
// (e2e/a2ui-cards.spec.ts) measures real layout at both widths; these run on every test run.
import {
  CATALOGUE,
  type ComponentType,
  prepareCard,
  RESERVED_COMPONENTS,
} from "@relationship-os/agent-a2ui";
import { sampleDocument } from "@relationship-os/agent-a2ui/samples";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApprovalView } from "../src/components/assistant/cards/approval.tsx";
import {
  type CardHost,
  cardActions,
  isAllowedHref,
} from "../src/components/assistant/cards/host.tsx";
import { Card, CardHostContext, crmCards } from "../src/components/assistant/cards/index.tsx";
import { snoozePresets } from "../src/components/assistant/cards/work.tsx";

const host: CardHost = {
  canApprove: true,
  navigate: vi.fn(),
  reply: vi.fn(),
  threadId: "ath_1",
  refresh: vi.fn(),
};

function render(part: ReturnType<typeof prepareCard>, width: number) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <CardHostContext.Provider value={host}>
        <div style={{ width }}>
          <Card part={part} />
        </div>
      </CardHostContext.Provider>
    </QueryClientProvider>,
  );
}

const types = CATALOGUE.map((c) => c.type);

describe("the component map", () => {
  it("has a renderer for every catalogue component, and only those", () => {
    expect(Object.keys(crmCards).sort()).toEqual([...types].sort());
    for (const reserved of RESERVED_COMPONENTS)
      expect(Object.keys(crmCards)).not.toContain(reserved);
  });
});

describe.each([384, 390])("at %i px", (width) => {
  it.each(types)("%s renders, with a text fallback", (type: ComponentType) => {
    const part = prepareCard(sampleDocument(type), { source: "host" });
    expect(part.document, type).not.toBeNull();
    expect(part.fallback.trim(), type).not.toBe("");
    const html = render(part, width);
    expect(html).toContain(`data-a2ui="${type}"`);
    expect(html).not.toContain("a2ui-fallback");
  });
});

describe("the fallback", () => {
  it("shows a model's invalid card as its words", () => {
    const part = prepareCard(
      { a2ui: 1, root: { type: "marquee" } },
      { source: "model", text: "You have **two** tasks." },
    );
    const html = render(part, 384);
    expect(html).toContain("a2ui-fallback");
    expect(html).toContain("<strong>two</strong>");
    expect(html).not.toContain("marquee");
  });

  it("does not load images a model put in its words", () => {
    const part = prepareCard(
      {},
      { source: "model", text: "![x](https://evil.example/leak.png?data=secret)" },
    );
    expect(render(part, 384)).not.toContain("<img");
  });

  it("does not draw a host card a model tried to send, even if it was stored", () => {
    const part = prepareCard(sampleDocument("heading"), { source: "model", text: "Words" });
    const forged = { ...part, document: sampleDocument("approval") };
    expect(render(forged, 384)).toContain("a2ui-fallback");
  });
});

describe("card text", () => {
  it("drops images and links to sites that are not allowed", () => {
    const part = prepareCard(
      {
        a2ui: 1,
        root: {
          type: "text",
          text: "![x](https://evil.example/a.png) [click](https://evil.example) [ok](/tasks)",
        },
      },
      { source: "model" },
    );
    const html = render(part, 384);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("evil.example");
    expect(html).toContain('href="/tasks"');
  });
});

describe("links", () => {
  it("allows app paths and the allow-list only", () => {
    expect(isAllowedHref("/people/per_1")).toBe(true);
    expect(isAllowedHref("https://meet.google.com/abc")).toBe(true);
    expect(isAllowedHref("https://us02web.zoom.us/j/1")).toBe(true);
    expect(isAllowedHref("https://evil.example")).toBe(false);
    expect(isAllowedHref("https://zoom.us.evil.example")).toBe(false);
    expect(isAllowedHref("//evil.example")).toBe(false);
    expect(isAllowedHref("javascript:alert(1)")).toBe(false);
  });
});

describe("actions", () => {
  const context = { source: "model" as const, node: { type: "actions" } };

  it("opens app pages through the router, and refuses other sites", async () => {
    const run = cardActions(host);
    await run({ kind: "open", label: "Open", href: "/tasks" }, undefined, context);
    expect(host.navigate).toHaveBeenCalledWith("/tasks");
    const refused = await run(
      { kind: "open", label: "Open", href: "https://evil.example" },
      undefined,
      context,
    );
    expect(refused.ok).toBe(false);
  });

  it("sends replies as the person's message", async () => {
    await cardActions(host)(
      { kind: "reply", label: "More", text: "Tell me more" },
      undefined,
      context,
    );
    expect(host.reply).toHaveBeenCalledWith("Tell me more");
  });
});

describe("the approval card", () => {
  const view = (overrides = {}) =>
    renderToStaticMarkup(
      <CardHostContext.Provider value={host}>
        <ApprovalView
          title="Send the Q3 newsletter"
          state="pending"
          canApprove
          busy={false}
          reviewHref="/approvals"
          onDecide={() => {}}
          {...overrides}
        />
      </CardHostContext.Provider>,
    );

  it("takes one tap for an ordinary change, with Reject and Review", () => {
    const html = view();
    expect(html).toContain("Approve");
    expect(html).toContain("Reject");
    expect(html).toContain("Review");
    expect(html).not.toContain("approval-two-step");
  });

  it("starts a high-risk item on its first step, naming what it does", () => {
    const html = view({
      step: { label: "Send 240 emails", confirmLabel: "Confirm: send 240 emails" },
    });
    expect(html).toContain("Send 240 emails");
    expect(html).toContain("approval-two-step");
    expect(html).not.toContain("Confirm: send 240 emails");
    expect(html).not.toContain(">Approve<");
  });

  it("shows what was asked and the agent's reason apart", () => {
    const html = view({ youAsked: "Send it", reason: "They opted in" });
    expect(html).toContain("You asked");
    expect(html).toContain("Agent&#x27;s reason");
  });

  it("tells a viewer someone else will review it, without buttons", () => {
    const html = view({ canApprove: false });
    expect(html).toContain("Someone who can approve changes will review it.");
    expect(html).not.toContain("Reject");
  });

  it("shows how it ended, without buttons", () => {
    const html = view({ state: "applied" });
    expect(html).toContain('data-status="applied"');
    expect(html).not.toContain("Reject");
  });
});

describe("snooze presets", () => {
  it("are later today, tomorrow at nine and next Monday at nine", () => {
    const friday = new Date(2026, 10, 6, 10, 0);
    const [later, tomorrow, week] = snoozePresets(friday);
    expect(later?.at.getHours()).toBe(13);
    expect(tomorrow?.at.getDate()).toBe(7);
    expect(tomorrow?.at.getHours()).toBe(9);
    expect(week?.at.getDate()).toBe(9);
    expect(week?.at.getDay()).toBe(1);
  });

  it("go to the following Monday from a Monday", () => {
    const monday = new Date(2026, 10, 9, 10, 0);
    expect(snoozePresets(monday)[2]?.at.getDate()).toBe(16);
  });
});
