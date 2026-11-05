// The assistant panel (ADR 0030, ADR 0200). On tablets and desktops it is docked on the
// right of the app shell: the page reflows narrower beside it, it stays mounted across page
// changes (same conversation, scroll, streaming reply and draft), it is resizable from its left
// edge, and its width and open state are remembered per browser. On phones it is a full-screen
// sheet. Either way it knows the page, its record and the list selection (AssistantProvider),
// keeps one conversation going across pages (remembered for the browser tab), and opens
// pre-filled from "Ask AI", "Ask about N selected" and every "Ask the assistant" link.
import { Button } from "@relationship-os/ui/components/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@relationship-os/ui/components/sheet";
import { useSidebar } from "@relationship-os/ui/components/sidebar";
import { useIsMobile } from "@relationship-os/ui/hooks/use-mobile";
import { cn } from "@relationship-os/ui/lib/utils";
import { Link, useRouterState } from "@tanstack/react-router";
import { MaximizeIcon, PlusIcon, SparklesIcon, XIcon } from "lucide-react";
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { useHotkey } from "#/lib/hotkeys";
import { Composer, Transcript, useAssistantName } from "./assistant-chat.tsx";
import { type AskOptions, PANEL_ID, useAssistant } from "./assistant-provider.tsx";
import {
  dockWidthCss,
  PANEL_MAX,
  PANEL_MIN,
  readDockWidth,
  widthAfterDrag,
  widthAfterKey,
  writeDockWidth,
} from "./dock-state.ts";
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
  const phone = useIsMobile();
  const name = useAssistantName();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
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

  // A scope from "Ask AI" belongs to the page it was asked on: after moving on, a follow-up
  // question is about the page the person is on now.
  const scopedPath = useRef(pathname);
  useEffect(() => {
    if (scopedPath.current === pathname) return;
    scopedPath.current = pathname;
    setScope({});
  }, [pathname]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every change.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [conversation.items, conversation.running]);

  const context = assistant.pageContext(scope);
  const close = () => {
    assistant.setOpen(false);
    setScope({});
  };

  const actions = (
    <>
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
    </>
  );

  const body = (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4" data-testid="assistant-scroll">
        {conversation.items.length === 0 && !conversation.running ? (
          <p className="text-sm text-muted-foreground">
            Ask {name} about what you are looking at, or to do something: "Summarise this", "Create
            a task to follow up next week", "Add a widget of deals by stage".
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
          autoFocus={assistant.open ? assistant.focusRequest : 0}
        />
      </div>
    </>
  );

  if (phone) {
    return (
      <Sheet
        open={assistant.open}
        onOpenChange={(open) => (open ? assistant.setOpen(true) : close())}
      >
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-0 p-0 sm:max-w-md"
          data-testid="assistant-panel"
        >
          <SheetHeader className="flex-row items-center gap-2 border-b px-4 py-3 pr-12">
            <SparklesIcon className="size-4 text-primary" />
            <SheetTitle className="flex-1 truncate">{name}</SheetTitle>
            <SheetDescription className="sr-only">
              Ask {name} about this page, or to change records, dashboards and automations.
            </SheetDescription>
            {actions}
          </SheetHeader>
          {body}
        </SheetContent>
      </Sheet>
    );
  }

  if (!assistant.open) return null;
  return (
    <AssistantDock name={name} onClose={close}>
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
        <SparklesIcon className="size-4 text-primary" />
        <h2 id={`${PANEL_ID}-title`} className="flex-1 truncate font-semibold text-foreground">
          {name}
        </h2>
        {actions}
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Close ${name}`}
          aria-keyshortcuts="Meta+J Control+J"
          onClick={close}
          data-testid="close-assistant"
        >
          <XIcon />
        </Button>
      </div>
      {body}
    </AssistantDock>
  );
}

/**
 * The docked frame: a labelled complementary landmark beside the page, resizable from its left
 * edge (drag, or the arrow keys on the handle). Its width lives here, so resizing re-renders only
 * this frame, not the conversation inside it.
 */
function AssistantDock({
  name,
  onClose,
  children,
}: {
  name: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { open: navOpen } = useSidebar();
  const [width, setWidth] = useState(readDockWidth);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  /** What the panel is actually showing (it gives way to the page on narrow screens). */
  const rendered = () => ref.current?.getBoundingClientRect().width ?? width;

  function resizeTo(next: number) {
    setWidth(next);
    writeDockWidth(next);
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: rendered() };
    setDragging(true);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    setWidth(widthAfterDrag(drag.current.startWidth, drag.current.startX, event.clientX));
  }

  function onPointerEnd(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    const next = widthAfterDrag(drag.current.startWidth, drag.current.startX, event.clientX);
    drag.current = null;
    setDragging(false);
    resizeTo(next);
  }

  function onHandleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const next = widthAfterKey(Math.round(rendered()), event.key, event.shiftKey);
    if (next === null) return;
    event.preventDefault();
    resizeTo(next);
  }

  return (
    <aside
      ref={ref}
      id={PANEL_ID}
      aria-labelledby={`${PANEL_ID}-title`}
      data-testid="assistant-panel"
      className={cn(
        "relative flex h-full min-h-0 shrink-0 flex-col border-l bg-background pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)]",
        dragging && "select-none",
      )}
      style={{ width: dockWidthCss(width, navOpen ? "var(--sidebar-width)" : "0px") }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: a focusable, adjustable separator (window splitter pattern); <hr> cannot take focus or a value. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${name} panel`}
        aria-controls={PANEL_ID}
        aria-valuemin={PANEL_MIN}
        aria-valuemax={PANEL_MAX}
        aria-valuenow={width}
        tabIndex={0}
        data-testid="assistant-resize"
        className={cn(
          "absolute inset-y-0 -left-1.5 z-10 w-3 cursor-col-resize touch-none outline-none",
          "after:absolute after:inset-y-0 after:left-1.5 after:w-px after:transition-colors",
          "hover:after:w-0.5 hover:after:bg-primary/60 focus-visible:after:w-0.5 focus-visible:after:bg-ring",
          dragging && "after:w-0.5 after:bg-primary",
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onKeyDown={onHandleKeyDown}
      />
      {children}
    </aside>
  );
}
