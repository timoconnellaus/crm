// The daily digest in the notification list (stage 7b, ADR 0206). Its body is Markdown written by
// the delivery cron: a counts line, then `###` sections (changes on your records, tasks due,
// approvals waiting, unread notifications) of items that link into the app, and, when the
// deployment has AI, a labelled overview first. The inbox shows it in full; the bell shows the
// title and counts and opens the inbox. Links navigate inside the app and mark the digest read.
import { cn } from "@relationship-os/ui/lib/utils";
import { Link, useRouter } from "@tanstack/react-router";
import ReactMarkdown from "react-markdown";
import { AiGeneratedBadge } from "#/components/ai/summary";
import type { NotificationData } from "#/components/automations/hooks";
import { useMarkRead } from "#/components/automations/hooks";
import { compactRelative } from "#/components/automations/model";

const PROSE =
  "text-sm leading-relaxed break-words [&_a]:text-primary [&_a]:underline-offset-2 hover:[&_a]:underline [&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-xs [&_h3]:font-medium [&_h3]:tracking-wide [&_h3]:text-muted-foreground [&_h3]:uppercase [&_li]:my-0.5 [&_p]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0";

/** Whether a link stays in the app (digest links are app paths). */
const internal = (href: string | undefined): href is string =>
  Boolean(href?.startsWith("/") && !href.startsWith("//"));

export function isDigest(item: Pick<NotificationData, "type">): boolean {
  return item.type === "digest";
}

function aiGenerated(item: NotificationData): boolean {
  const source = item.source as { aiGenerated?: unknown } | null;
  return source?.aiGenerated === true;
}

/** The counts line (the paragraph after the overview), for the compact form. */
function countsLine(body: string | null): string | null {
  if (!body) return null;
  const paragraphs = body.split(/\n{2,}/).filter((p) => !p.startsWith("_AI-generated"));
  return paragraphs[0]?.replace(/\\(.)/g, "$1") ?? null;
}

export function DigestEntry({
  item,
  compact = false,
  onNavigate,
}: {
  item: NotificationData;
  /** The bell: title and counts, opening the inbox. */
  compact?: boolean;
  onNavigate?: () => void;
}) {
  const markRead = useMarkRead();
  const router = useRouter();
  const unread = !item.readAt;
  const read = () => {
    if (unread) markRead.mutate({ ids: [item.id] });
  };

  const header = (
    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
      <span className={cn("break-words", unread && "font-medium")}>
        {unread && <span className="sr-only">Unread: </span>}
        {item.title}
      </span>
      {aiGenerated(item) && <AiGeneratedBadge className="h-5 text-[11px]" />}
    </span>
  );
  const dot = (
    <span
      className={cn(
        "mt-1.5 size-2 shrink-0 rounded-full",
        unread ? "bg-primary" : "bg-transparent",
      )}
      aria-hidden
    />
  );
  const time = (
    <time className="shrink-0 text-xs text-muted-foreground" dateTime={item.createdAt}>
      {compactRelative(item.createdAt)}
    </time>
  );

  if (compact) {
    const counts = countsLine(item.body);
    return (
      <Link
        to="/notifications"
        onClick={() => {
          read();
          onNavigate?.();
        }}
        className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left text-sm hover:bg-muted/60"
        data-testid="notification-item"
        data-type="digest"
        data-unread={unread || undefined}
      >
        {dot}
        <span className="grid min-w-0 flex-1 gap-0.5">
          {header}
          {counts && <span className="line-clamp-2 text-xs text-muted-foreground">{counts}</span>}
        </span>
        {time}
      </Link>
    );
  }

  return (
    <article
      className="flex w-full items-start gap-2.5 px-3 py-2.5 text-sm"
      data-testid="notification-item"
      data-type="digest"
      data-unread={unread || undefined}
      aria-label={item.title}
    >
      {dot}
      <div className="grid min-w-0 flex-1 gap-1.5">
        <div className="flex items-start gap-2">
          {header}
          {time}
        </div>
        {item.body && (
          <div className={PROSE} data-testid="digest-body">
            <ReactMarkdown
              components={{
                a: ({ node: _node, href, children, ...props }) =>
                  internal(href) ? (
                    <a
                      href={href}
                      onClick={(event) => {
                        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                        event.preventDefault();
                        read();
                        void router.navigate({ href });
                      }}
                    >
                      {children}
                    </a>
                  ) : (
                    <a {...props} href={href} target="_blank" rel="noopener noreferrer">
                      {children}
                    </a>
                  ),
              }}
            >
              {item.body}
            </ReactMarkdown>
          </div>
        )}
        {unread && (
          <button
            type="button"
            className="justify-self-start text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={read}
          >
            Mark read
          </button>
        )}
      </div>
    </article>
  );
}
