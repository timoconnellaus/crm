// How a card reaches the app (ADR 0346): where links go, how a reply is sent, and how a button
// runs. The card components use this context and never the router or the thread directly, so
// they render anywhere: the chat, the gallery and tests.
//
// A button's operation runs by who wrote the card. The host's own cards call it as the viewer.
// Cards a model or a saved producer wrote call `a2ui.act`, which runs it as the assistant with the
// viewer's permissions, so the gate, change sets and approvals apply (see operations/a2ui.ts).
import type { A2uiAction } from "@relationship-os/agent-a2ui";
import {
  type ActionContext,
  type ActionHandler,
  type ActionResult,
  mergeInput,
} from "@relationship-os/agent-a2ui/react";
import type { CoreInput, CoreOperationName } from "@relationship-os/core";
import { createContext, useContext } from "react";
import { callOp } from "#/lib/operations";
import { errorMessage } from "#/lib/query";

export interface CardHost {
  /** May this person approve changes? */
  canApprove: boolean;
  /** Goes to a path in the app. */
  navigate(href: string): void;
  /** Sends text as the person's message. */
  reply(text: string): void;
  /** The thread the card is in: what its queued changes group under. */
  threadId: string | null;
  /** After an action: refresh what it may have changed. */
  refresh(): void;
}

const NO_HOST: CardHost = {
  canApprove: false,
  navigate: () => {},
  reply: () => {},
  threadId: null,
  refresh: () => {},
};

export const CardHostContext = createContext<CardHost>(NO_HOST);

export function useCardHost(): CardHost {
  return useContext(CardHostContext);
}

/** Sites a card may link out to. Anything else shows as text (catalogue: "allow-listed"). */
const EXTERNAL_HOSTS = [
  "calendar.google.com",
  "mail.google.com",
  "meet.google.com",
  "outlook.office.com",
  "teams.microsoft.com",
  "webex.com",
  "zoom.us",
];

/** Can a card link here? App paths always; https only to the allow-list. */
export function isAllowedHref(href: string): boolean {
  if (/^\/(?!\/)/.test(href)) return true;
  try {
    const url = new URL(href);
    if (url.protocol !== "https:") return false;
    return EXTERNAL_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

type Run = (name: string, input: Record<string, unknown>) => Promise<unknown>;

/** Calls an operation the type system cannot know: its name comes from the card. */
const callByName: Run = (name, input) =>
  callOp(name as CoreOperationName, input as CoreInput<CoreOperationName>);

async function runOperation(
  action: Extract<A2uiAction, { kind: "operation" }>,
  extra: Record<string, unknown> | undefined,
  context: ActionContext,
  host: CardHost,
): Promise<ActionResult> {
  const input = mergeInput(action.input, extra);
  if (context.source === "host") {
    await callByName(action.operation, input);
    return { ok: true };
  }
  const result = await callOp("a2ui.act", {
    operation: action.operation,
    input,
    label: action.label,
    ...(host.threadId ? { threadId: host.threadId } : {}),
  });
  return result.status === "pending_approval"
    ? { ok: true, message: "Waiting for approval" }
    : { ok: true };
}

/** The action handler for `host`: every button is an operation, a link or a reply. */
export function cardActions(host: CardHost): ActionHandler {
  return async (action, extra, context) => {
    switch (action.kind) {
      case "open":
        if (!isAllowedHref(action.href)) return { ok: false, message: "That link is not allowed" };
        if (action.href.startsWith("/")) host.navigate(action.href);
        else window.open(action.href, "_blank", "noopener,noreferrer");
        return { ok: true };
      case "reply":
        host.reply(action.text);
        return { ok: true };
      case "operation":
        try {
          const result = await runOperation(action, extra, context, host);
          host.refresh();
          return result;
        } catch (error) {
          return { ok: false, message: errorMessage(error) };
        }
    }
  };
}
