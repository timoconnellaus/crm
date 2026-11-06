// /assistant (ADR 0030, ADR 0340): the person's one thread on a full page, the same thread the
// docked sidebar shows. No conversation list and no "new conversation": the chat never resets.
// "Search this chat" finds anything said in it, and "Jump to" scrolls there.
import { cn } from "@relationship-os/ui/lib/utils";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Composer,
  ThreadSearch,
  Transcript,
  useAssistantName,
  useJumpToMessage,
} from "#/components/assistant/assistant-chat";
import { EarlierButton } from "#/components/assistant/assistant-panel";
import { useAssistant } from "#/components/assistant/assistant-provider";
import { useThread, useThreadVisible } from "#/components/assistant/thread-provider";
import { errorMessage } from "#/lib/query";

export const Route = createFileRoute("/_app/assistant")({
  component: AssistantPage,
});

function AssistantPage() {
  const { user } = Route.useRouteContext();
  const name = useAssistantName();
  const assistant = useAssistant();
  const thread = useThread();
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const searching = query.trim().length > 0;
  useThreadVisible(true);
  useJumpToMessage(thread, scrollRoot);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the newest on every change (not while jumping or searching).
  useEffect(() => {
    if (thread.jumpTarget === null && !searching) bottom.current?.scrollIntoView({ block: "end" });
  }, [thread.items.length, thread.running, searching]);

  async function remove(seq: number) {
    try {
      await thread.deleteMessage(seq);
      toast.success("Message deleted");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b px-4 py-3 md:px-8">
        <div className="mx-auto max-w-3xl space-y-3">
          <h1 className="text-lg font-semibold" data-page-title tabIndex={-1}>
            {name}
          </h1>
          <ThreadSearch
            query={query}
            onQueryChange={setQuery}
            name={name}
            onJump={(seq) => {
              setQuery("");
              thread.jumpTo(seq);
            }}
          />
        </div>
      </div>
      <div
        ref={setScrollRoot}
        className={cn("min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-8", searching && "hidden")}
        data-testid="assistant-scroll"
      >
        <div className="mx-auto max-w-3xl">
          {thread.items.length === 0 && !thread.running && !thread.loading ? (
            <p className="text-sm text-muted-foreground">
              Ask {name} anything about your CRM, or to change it. This is one chat that keeps
              going: the sidebar shows it too. Changes that need approval show here with Approve and
              Reject.
            </p>
          ) : (
            <Transcript
              items={thread.items}
              name={name}
              canApprove={user.role !== "viewer"}
              thinking={thread.thinking}
              running={thread.running}
              onDelete={(seq) => void remove(seq)}
              before={
                thread.hasEarlier ? <EarlierButton onClick={thread.loadEarlier} /> : undefined
              }
            />
          )}
          <div ref={bottom} />
        </div>
      </div>
      <div className="border-t p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-8">
        <div className="mx-auto max-w-3xl">
          <Composer
            conversation={thread}
            context={assistant.pageContext()}
            name={name}
            draft={draft}
            onDraftChange={setDraft}
            autoFocus
          />
        </div>
      </div>
    </div>
  );
}
