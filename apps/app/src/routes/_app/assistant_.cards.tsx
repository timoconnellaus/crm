// A gallery of every catalogue card (ADR 0346), for development and the width tests: every sample
// at the docked panel's width (?width=384), or at the page's width on a phone. Not in production
// builds: there it is a 404.
import { CATALOGUE, prepareCard } from "@relationship-os/agent-a2ui";
import { sampleDocument } from "@relationship-os/agent-a2ui/samples";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { ApprovalView } from "#/components/assistant/cards/approval";
import { CardHostContext, type CardHost } from "#/components/assistant/cards/host";
import { Card } from "#/components/assistant/cards/index";

export const Route = createFileRoute("/_app/assistant_/cards")({
  validateSearch: z.object({ width: z.number().int().optional() }),
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  component: CardGallery,
});

const host: CardHost = {
  canApprove: true,
  threadId: null,
  navigate: () => {},
  reply: () => {},
  refresh: () => {},
};

function CardGallery() {
  const { width } = Route.useSearch();
  const [decided, setDecided] = useState<string | null>(null);
  return (
    <CardHostContext.Provider value={host}>
      <div
        className="mx-auto grid gap-6 p-0"
        style={width ? { width } : undefined}
        data-testid="a2ui-gallery"
      >
        {CATALOGUE.map(({ type }) => (
          <div key={type} className="grid min-w-0 gap-1" data-testid="a2ui-sample" data-type={type}>
            <p className="text-xs text-muted-foreground">{type}</p>
            <Card part={prepareCard(sampleDocument(type), { source: "host" })} />
          </div>
        ))}
        <div className="grid min-w-0 gap-1" data-testid="a2ui-sample" data-type="approval-high-risk">
          <p className="text-xs text-muted-foreground">approval, high risk</p>
          <ApprovalView
            title="Send the Q3 newsletter"
            state="pending"
            youAsked="Send the newsletter to the Q3 leads"
            reason="240 leads opted in to the Q3 list."
            risk="outbound"
            step={{ label: "Send 240 emails", confirmLabel: "Confirm: send 240 emails" }}
            canApprove
            busy={false}
            reviewHref="/approvals"
            onDecide={setDecided}
          />
          {decided && <p data-testid="a2ui-decided">{decided}</p>}
        </div>
      </div>
    </CardHostContext.Provider>
  );
}
