// /assistant (ADR 0030, ADR 0200): the in-app assistant on a full page, with the person's
// conversation history. `?c=asc_…` opens one conversation; the Cmd-J panel's "Open full page"
// links here.
import { Button } from "@relationship-os/ui/components/button";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { cn } from "@relationship-os/ui/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Composer, Transcript, useAssistantName } from "#/components/assistant/assistant-chat";
import { useAssistant } from "#/components/assistant/assistant-provider";
import { useConversation } from "#/components/assistant/use-conversation";
import { invalidateOps, useOp } from "#/lib/query";

interface AssistantSearch {
  c?: string;
}

export const Route = createFileRoute("/_app/assistant")({
  validateSearch: (search: Record<string, unknown>): AssistantSearch =>
    typeof search.c === "string" && /^asc_[0-9A-Za-z]+$/.test(search.c) ? { c: search.c } : {},
  component: AssistantPage,
});

function relative(at: string): string {
  const diff = Date.now() - Date.parse(at);
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(at).toLocaleDateString();
}

function AssistantPage() {
  const { c } = Route.useSearch();
  const { user } = Route.useRouteContext();
  const navigate = useNavigate({ from: "/assistant" });
  const name = useAssistantName();
  const assistant = useAssistant();
  const client = useQueryClient();
  const list = useOp("assistant.conversations", {});
  const [draft, setDraft] = useState("");
  const conversation = useConversation(c ?? null, (id) => {
    void navigate({ search: { c: id }, replace: true });
  });
  const bottom = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh the list after each turn.
  useEffect(() => {
    if (!conversation.running) void invalidateOps(client, "assistant.");
  }, [conversation.running]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every change.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [conversation.items]);

  async function remove(id: string) {
    const response = await fetch(`/api/assistant/conversations/${id}`, { method: "DELETE" });
    if (!response.ok) {
      toast.error("Could not delete the conversation");
      return;
    }
    toast.success("Conversation deleted");
    await invalidateOps(client, "assistant.");
    if (id === c) void navigate({ search: {} });
  }

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <aside className="flex max-h-48 shrink-0 flex-col border-b md:max-h-none md:w-72 md:border-r md:border-b-0">
        <div className="flex items-center justify-between gap-2 px-4 py-3">
          <h1 className="text-base font-semibold" data-page-title tabIndex={-1}>
            {name}
          </h1>
          <Button size="sm" variant="outline" asChild>
            <Link to="/assistant" search={{}}>
              <PlusIcon />
              New
            </Link>
          </Button>
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-label="Conversations">
          {list.isLoading ? (
            <div className="space-y-2 px-2">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          ) : list.data?.conversations.length ? (
            <ul className="space-y-1" data-testid="assistant-history">
              {list.data.conversations.map((item) => (
                <li key={item.id} className="group flex items-center">
                  <Link
                    to="/assistant"
                    search={{ c: item.id }}
                    className={cn(
                      "min-w-0 flex-1 rounded-md px-2 py-1.5 text-sm hover:bg-muted",
                      item.id === c && "bg-muted font-medium",
                    )}
                  >
                    <span className="block truncate">{item.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {relative(item.updatedAt)}
                      {item.preview ? ` · ${item.preview}` : ""}
                    </span>
                  </Link>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    aria-label={`Delete ${item.title}`}
                    onClick={() => void remove(item.id)}
                  >
                    <Trash2Icon />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-2 text-sm text-muted-foreground">No conversations yet.</p>
          )}
        </nav>
      </aside>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-8">
          <div className="mx-auto max-w-3xl">
            {conversation.items.length === 0 && !conversation.running ? (
              <p className="text-sm text-muted-foreground">
                Ask {name} anything about your CRM, or to change it. Changes that need approval
                show here with Approve and Reject.
              </p>
            ) : (
              <Transcript
                items={conversation.items}
                name={name}
                canApprove={user.role !== "viewer"}
                thinking={conversation.thinking}
                running={conversation.running}
              />
            )}
            <div ref={bottom} />
          </div>
        </div>
        <div className="border-t p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-8">
          <div className="mx-auto max-w-3xl">
            <Composer
              conversation={conversation}
              context={assistant.pageContext()}
              name={name}
              draft={draft}
              onDraftChange={setDraft}
              autoFocus
            />
          </div>
        </div>
      </section>
    </div>
  );
}
