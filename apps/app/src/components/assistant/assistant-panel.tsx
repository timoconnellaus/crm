// The Cmd-J assistant panel (ADR 0030, ADR 0200): a right-hand sheet on every signed-in page. It
// knows the page, its record and the list selection (AssistantProvider), keeps one conversation
// going across pages (remembered for the browser tab), and opens pre-filled from "Ask AI",
// "Ask about N selected" and every "Ask the assistant" link.
import { Button } from "@relationship-os/ui/components/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@relationship-os/ui/components/sheet";
import { Link } from "@tanstack/react-router";
import { MaximizeIcon, PlusIcon, SparklesIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useHotkey } from "#/lib/hotkeys";
import { Composer, Transcript, useAssistantName } from "./assistant-chat.tsx";
import { type AskOptions, useAssistant } from "./assistant-provider.tsx";
import { useConversation } from "./use-conversation.ts";

const STORAGE_KEY = "ros.assistant.panelConversation";

function remembered(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function remember(id: string | null) {
  try {
    if (id) sessionStorage.setItem(STORAGE_KEY, id);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode: the panel just starts fresh next time.
  }
}

export function AssistantPanel({ canApprove }: { canApprove: boolean }) {
  const assistant = useAssistant();
  const name = useAssistantName();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [scope, setScope] = useState<AskOptions>({});
  const conversation = useConversation(conversationId, (id) => {
    setConversationId(id);
    remember(id);
  });
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setConversationId(remembered());
  }, []);

  useHotkey("mod+j", () => assistant.toggle(), { global: true });

  // A request from "Ask AI" and friends: scope, pre-fill, maybe send.
  const { request, consumeRequest } = assistant;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per request (its nonce).
  useEffect(() => {
    if (!request) return;
    consumeRequest();
    const next: AskOptions = {
      ...(request.record ? { record: request.record } : {}),
      ...(request.selection ? { selection: request.selection } : {}),
    };
    setScope(next);
    if (request.fresh) {
      setConversationId(null);
      remember(null);
    }
    if (request.prompt && request.send && !request.fresh) {
      void conversation.send(request.prompt, assistant.pageContext(next));
    } else if (request.prompt) {
      setDraft(request.prompt);
    }
  }, [request?.nonce]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every change.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [conversation.items, conversation.running]);

  const context = assistant.pageContext(scope);

  return (
    <Sheet
      open={assistant.open}
      onOpenChange={(open) => {
        assistant.setOpen(open);
        if (!open) setScope({});
      }}
    >
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-md"
        data-testid="assistant-panel"
      >
        <SheetHeader className="flex-row items-center gap-2 border-b px-4 py-3">
          <SparklesIcon className="size-4 text-primary" />
          <SheetTitle className="flex-1 truncate">{name}</SheetTitle>
          <SheetDescription className="sr-only">
            Ask {name} about this page, or to change records, dashboards and automations.
          </SheetDescription>
          <Button
            variant="ghost"
            size="icon"
            aria-label="New conversation"
            onClick={() => {
              setConversationId(null);
              remember(null);
            }}
          >
            <PlusIcon />
          </Button>
          <Button variant="ghost" size="icon" aria-label="Open full page" asChild>
            <Link
              to="/assistant"
              search={conversation.id ? { c: conversation.id } : {}}
              onClick={() => assistant.setOpen(false)}
            >
              <MaximizeIcon />
            </Link>
          </Button>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {conversation.items.length === 0 && !conversation.running ? (
            <p className="text-sm text-muted-foreground">
              Ask {name} about what you are looking at, or to do something: "Summarise this",
              "Create a task to follow up next week", "Add a widget of deals by stage".
            </p>
          ) : (
            <Transcript
              items={conversation.items}
              name={name}
              canApprove={canApprove}
              thinking={conversation.thinking}
              running={conversation.running}
            />
          )}
          <div ref={bottom} />
        </div>
        <div className="border-t p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <Composer
            conversation={conversation}
            context={context}
            name={name}
            draft={draft}
            onDraftChange={setDraft}
            autoFocus={assistant.open}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
