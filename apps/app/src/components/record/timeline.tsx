// Timeline of activities (newest first), its type filter, and the composer that logs a note,
// call, meeting or email with that type's payload. Used by record pages (one record's timeline)
// and the Activity page (the feed across records, with links shown).
import { Button } from "@crm/ui/components/button";
import { Card, CardContent } from "@crm/ui/components/card";
import { Checkbox } from "@crm/ui/components/checkbox";
import { Input } from "@crm/ui/components/input";
import { Label } from "@crm/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@crm/ui/components/select";
import { Skeleton } from "@crm/ui/components/skeleton";
import { Textarea } from "@crm/ui/components/textarea";
import { cn } from "@crm/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import {
  BriefcaseIcon,
  CalendarIcon,
  type LucideIcon,
  MailIcon,
  MessageSquareTextIcon,
  PhoneIcon,
  SparklesIcon,
} from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { formatDateTime, formatValue } from "#/lib/format";
import { errorMessage } from "#/lib/query";
import { EmptyState, ErrorState } from "../empty-state.tsx";
import { LoadMoreSentinel } from "../layout/infinite.tsx";
import { Markdown } from "../markdown.tsx";
import {
  ACTIVITY_TYPE_LABELS,
  type ActivityType,
  type HumanActivityType,
  type NewActivity,
  type RecordRef,
  type TimelineItem,
} from "./adapters.ts";

const TYPE_ICON: Record<ActivityType, LucideIcon> = {
  note: MessageSquareTextIcon,
  email: MailIcon,
  call: PhoneIcon,
  meeting: CalendarIcon,
  system: SparklesIcon,
};

const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/** One line of type-specific details (direction, outcome, place…), or null. */
function payloadSummary(item: TimelineItem): ReactNode {
  const p = item.payload;
  switch (item.type) {
    case "email": {
      const to = Array.isArray(p.to)
        ? (p.to as { email?: string; name?: string }[])
            .map((a) => a.name || a.email)
            .filter(Boolean)
            .join(", ")
        : "";
      const from = (p.from as { email?: string; name?: string } | undefined)?.email;
      return [
        p.direction === "inbound" ? "Inbound" : "Outbound",
        from && `from ${from}`,
        to && `to ${to}`,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "call": {
      const minutes =
        typeof p.durationSeconds === "number" ? Math.round(p.durationSeconds / 60) : null;
      return (
        [
          p.direction === "inbound" ? "Inbound" : p.direction === "outbound" ? "Outbound" : null,
          str(p.outcome)?.replace("_", " "),
          minutes !== null ? `${minutes} min` : null,
          str(p.phoneNumber),
        ]
          .filter(Boolean)
          .join(" · ") || null
      );
    }
    case "meeting": {
      const url = str(p.url);
      const parts = [str(p.startsAt) && formatDateTime(str(p.startsAt)), str(p.location)].filter(
        Boolean,
      );
      if (!parts.length && !url) return null;
      return (
        <>
          {parts.join(" · ")}
          {url && (
            <>
              {parts.length ? " · " : ""}
              <a href={url} target="_blank" rel="noreferrer" className="underline">
                Join link
              </a>
            </>
          )}
        </>
      );
    }
    default:
      return null;
  }
}

function JobChange({ payload }: { payload: TimelineItem["payload"] }) {
  const from = payload.from as { organisationName?: string; title?: string | null } | null;
  const to = payload.to as { organisationName?: string; title?: string | null } | null;
  const label = (side: typeof from) =>
    side ? [side.title, side.organisationName].filter(Boolean).join(" at ") : "";
  return (
    <p className="mt-1 flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
      <BriefcaseIcon className="size-3.5" aria-hidden />
      {from ? `${label(from) || "Previous job"} → ` : "Joined: "}
      {label(to)}
    </p>
  );
}

const LINK_ROUTE: Record<string, string> = {
  person: "/people",
  organisation: "/organisations",
};

/** A link to a person's or an organisation's record page. */
export function RecordLink({
  object,
  id,
  children,
}: {
  object: string;
  id: string;
  children: ReactNode;
}) {
  const className = "underline-offset-2 hover:underline";
  if (object === "person") {
    return (
      <Link to="/people/$id" params={{ id }} className={className}>
        {children}
      </Link>
    );
  }
  const base = LINK_ROUTE[object];
  if (!base) return <span>{children}</span>;
  // Organisation record routes live with the organisation screens; a plain href keeps this
  // independent of their route types.
  return (
    <a href={`${base}/${id}`} className={className}>
      {children}
    </a>
  );
}

export interface TimelineProps {
  items: TimelineItem[];
  isPending?: boolean;
  error?: Error | null;
  /** Show at most this many (Overview shows a few; the Timeline tab shows all). */
  limit?: number;
  /** Show the records each activity is linked to (the Activity feed). */
  showLinks?: boolean;
  /** Infinite scroll for paged timelines: more pages load as the end scrolls into view. */
  hasMore?: boolean;
  onLoadMore?: () => void;
  isLoadingMore?: boolean;
  loadMoreFailed?: boolean;
  /** Empty state text (e.g. when a filter is on). */
  emptyTitle?: string;
}

/** Skeleton entries shaped like the timeline, so nothing shifts when it loads. */
export function TimelineSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="grid gap-4 border-l pl-6" aria-busy="true" data-testid="timeline-skeleton">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton rows.
        <div key={i} className="grid gap-1.5">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      ))}
    </div>
  );
}

export function Timeline({
  items,
  isPending,
  error,
  limit,
  showLinks,
  hasMore,
  onLoadMore,
  isLoadingMore,
  loadMoreFailed,
  emptyTitle = "No activity yet",
}: TimelineProps) {
  if (isPending) return <TimelineSkeleton />;
  if (error) return <ErrorState title="Could not load activity" error={error} />;
  if (!items.length) {
    return (
      <EmptyState
        icon={MessageSquareTextIcon}
        title={emptyTitle}
        description="Notes, emails, calls, meetings and changes show up here."
      />
    );
  }
  const shown = limit ? items.slice(0, limit) : items;
  return (
    <div className="grid gap-3">
      <ol className="relative grid gap-4 border-l pl-6" aria-label="Timeline">
        {shown.map((item) => (
          <li key={item.id} className="relative" data-activity-type={item.type}>
            <TimelineEntry item={item} showLinks={showLinks} />
          </li>
        ))}
      </ol>
      {!limit && hasMore && onLoadMore && (
        <LoadMoreSentinel
          label="more activity"
          source={{
            hasNextPage: true,
            isFetching: Boolean(isLoadingMore),
            isFetchingNextPage: Boolean(isLoadingMore),
            isFetchNextPageError: Boolean(loadMoreFailed),
            fetchNextPage: onLoadMore,
          }}
        />
      )}
    </div>
  );
}

/** One activity: type icon (hung on the timeline's rule), subject, time, author and body. */
export function TimelineEntry({ item, showLinks }: { item: TimelineItem; showLinks?: boolean }) {
  const Icon = TYPE_ICON[item.type] ?? SparklesIcon;
  const summary = payloadSummary(item);
  const links = showLinks ? item.links.filter((l) => LINK_ROUTE[l.object]) : [];
  return (
    <>
      <span className="absolute top-0.5 -left-[2.0625rem] flex size-6 items-center justify-center rounded-full border bg-background">
        <Icon className="size-3.5 text-muted-foreground" aria-hidden />
      </span>
      <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-medium break-words">
          {item.subject ?? ACTIVITY_TYPE_LABELS[item.type]}
        </span>
        <time dateTime={item.occurredAt} className="text-xs text-muted-foreground">
          {formatDateTime(item.occurredAt)}
        </time>
        {item.authorName && item.type !== "system" && (
          <span className="text-xs text-muted-foreground">by {item.authorName}</span>
        )}
      </div>
      {summary && <p className="mt-0.5 text-xs text-muted-foreground">{summary}</p>}
      {item.payload.kind === "job_change" && <JobChange payload={item.payload} />}
      {item.payload.changes?.length ? (
        <ul className="mt-1 text-sm text-muted-foreground">
          {item.payload.changes.map((change) => (
            <li key={change.field}>
              {change.label}: {change.beforeLabel ?? (formatValue(change.before) || "empty")} →{" "}
              {change.afterLabel ?? (formatValue(change.after) || "empty")}
            </li>
          ))}
        </ul>
      ) : null}
      {item.body && <Markdown className="mt-1">{item.body}</Markdown>}
      {links.length > 0 && (
        <p className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          On{" "}
          {links.map((link, i) => (
            <span key={`${link.object}:${link.id}`}>
              <RecordLink object={link.object} id={link.id}>
                {link.title ?? link.id}
              </RecordLink>
              {i < links.length - 1 ? "," : ""}
            </span>
          ))}
        </p>
      )}
    </>
  );
}

// --- Type filter ------------------------------------------------------------------------------

const FILTER_TYPES: ActivityType[] = ["note", "email", "call", "meeting", "system"];

export interface TimelineFilterProps {
  /** Selected types; empty means all. */
  value: ActivityType[];
  onChange: (types: ActivityType[]) => void;
  className?: string;
}

/** Toggle chips for activity types ("All" clears). */
export function TimelineFilter({ value, onChange, className }: TimelineFilterProps) {
  const toggle = (type: ActivityType) =>
    onChange(value.includes(type) ? value.filter((t) => t !== type) : [...value, type]);
  return (
    <fieldset className={cn("flex flex-wrap items-center gap-1", className)}>
      <legend className="sr-only">Activity types</legend>
      <Button
        type="button"
        size="xs"
        variant={value.length === 0 ? "secondary" : "ghost"}
        aria-pressed={value.length === 0}
        onClick={() => onChange([])}
      >
        All
      </Button>
      {FILTER_TYPES.map((type) => {
        const Icon = TYPE_ICON[type];
        const on = value.includes(type);
        return (
          <Button
            key={type}
            type="button"
            size="xs"
            variant={on ? "secondary" : "ghost"}
            aria-pressed={on}
            onClick={() => toggle(type)}
          >
            <Icon />
            {type === "system" ? "Changes" : `${ACTIVITY_TYPE_LABELS[type]}s`}
          </Button>
        );
      })}
    </fieldset>
  );
}

// --- Composer ---------------------------------------------------------------------------------

export interface ActivityComposerProps {
  /**
   * Logs the activity, also linking it to `also` (the records the user kept ticked); null
   * disables the composer (e.g. read-only users).
   */
  onSubmit: ((activity: NewActivity, also: RecordRef[]) => Promise<void>) | null;
  isPending?: boolean;
  /**
   * Another record the activity can go on as well, offered as a ticked checkbox: a person's
   * current organisation, so a note about them shows on both timelines.
   */
  alsoOn?: (RecordRef & { title: string }) | null;
}

/** A `datetime-local` value to an ISO timestamp (undefined when empty or invalid). */
function localToIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseAddresses(text: string): { email: string }[] {
  return text
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((email) => ({ email }));
}

const DIRECTIONS = [
  { value: "outbound", label: "Outbound" },
  { value: "inbound", label: "Inbound" },
] as const;

const OUTCOMES = [
  { value: "connected", label: "Connected" },
  { value: "no_answer", label: "No answer" },
  { value: "voicemail", label: "Voicemail" },
  { value: "busy", label: "Busy" },
  { value: "other", label: "Other" },
] as const;

const NONE = "__none__";

interface Draft {
  subject: string;
  body: string;
  when: string;
  direction: "inbound" | "outbound";
  to: string;
  outcome: string;
  minutes: string;
  location: string;
  url: string;
}

const EMPTY_DRAFT: Draft = {
  subject: "",
  body: "",
  when: "",
  direction: "outbound",
  to: "",
  outcome: NONE,
  minutes: "",
  location: "",
  url: "",
};

/** The `activity.log` input for a draft, or an error message. */
export function draftToActivity(
  type: HumanActivityType,
  draft: Draft,
): NewActivity | { error: string } {
  const subject = draft.subject.trim() || null;
  const body = draft.body.trim() || null;
  const occurredAt = localToIso(draft.when);
  if (type === "note" && !body) return { error: "Write the note first" };
  if (!subject && !body) return { error: "Add a subject or some notes" };
  const common = { subject, body, ...(occurredAt ? { occurredAt } : {}) };
  switch (type) {
    case "note":
      return { type, ...common, payload: {} };
    case "email":
      return {
        type,
        ...common,
        payload: { direction: draft.direction, to: parseAddresses(draft.to), cc: [] },
      };
    case "call": {
      const minutes = Number.parseFloat(draft.minutes);
      return {
        type,
        ...common,
        payload: {
          direction: draft.direction,
          ...(draft.outcome !== NONE
            ? { outcome: draft.outcome as (typeof OUTCOMES)[number]["value"] }
            : {}),
          ...(Number.isFinite(minutes) && minutes >= 0
            ? { durationSeconds: Math.round(minutes * 60) }
            : {}),
        },
      };
    }
    case "meeting":
      return {
        type,
        ...common,
        payload: {
          ...(occurredAt ? { startsAt: occurredAt } : {}),
          ...(draft.location.trim() ? { location: draft.location.trim() } : {}),
          ...(draft.url.trim() ? { url: draft.url.trim() } : {}),
          attendees: [],
        },
      };
  }
}

export function ActivityComposer({ onSubmit, isPending, alsoOn }: ActivityComposerProps) {
  const [type, setType] = useState<HumanActivityType>("note");
  const [linkAlso, setLinkAlso] = useState(true);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const disabled = !onSubmit;
  const note = type === "note";
  const canSubmit = note
    ? Boolean(draft.body.trim())
    : Boolean(draft.body.trim() || draft.subject.trim());

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!onSubmit) return;
    const activity = draftToActivity(type, draft);
    if ("error" in activity) {
      toast.error(activity.error);
      return;
    }
    try {
      await onSubmit(
        activity,
        alsoOn && linkAlso ? [{ object: alsoOn.object, id: alsoOn.id }] : [],
      );
      setDraft(EMPTY_DRAFT);
      toast.success(`${ACTIVITY_TYPE_LABELS[type]} logged`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const field = (id: string, label: string, control: ReactNode, className?: string) => (
    <div className={cn("grid gap-1", className)}>
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {control}
    </div>
  );

  return (
    <Card className="py-3">
      <CardContent className="px-3">
        <form onSubmit={submit} className="grid gap-2" aria-label="Add activity">
          {!note &&
            field(
              "composer-subject",
              type === "email" ? "Subject" : type === "call" ? "Topic" : "Title",
              <Input
                id="composer-subject"
                value={draft.subject}
                onChange={(e) => set("subject", e.target.value)}
                maxLength={500}
                disabled={disabled}
              />,
            )}
          <Textarea
            value={draft.body}
            onChange={(event) => set("body", event.target.value)}
            placeholder={
              note ? "Add a note… (Markdown)" : type === "email" ? "Email text" : "Notes (optional)"
            }
            aria-label="Activity text"
            disabled={disabled}
            className="min-h-16 resize-y"
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          {!note && (
            <div className="grid gap-2 sm:grid-cols-2">
              {(type === "email" || type === "call") &&
                field(
                  "composer-direction",
                  "Direction",
                  <Select
                    value={draft.direction}
                    onValueChange={(v) => set("direction", v as Draft["direction"])}
                    disabled={disabled}
                  >
                    <SelectTrigger id="composer-direction" size="sm" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DIRECTIONS.map((d) => (
                        <SelectItem key={d.value} value={d.value}>
                          {d.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>,
                )}
              {type === "email" &&
                field(
                  "composer-to",
                  "To (emails)",
                  <Input
                    id="composer-to"
                    value={draft.to}
                    onChange={(e) => set("to", e.target.value)}
                    placeholder="ada@example.com"
                    disabled={disabled}
                  />,
                )}
              {type === "call" &&
                field(
                  "composer-outcome",
                  "Outcome",
                  <Select
                    value={draft.outcome}
                    onValueChange={(v) => set("outcome", v)}
                    disabled={disabled}
                  >
                    <SelectTrigger id="composer-outcome" size="sm" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Not set</SelectItem>
                      {OUTCOMES.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>,
                )}
              {type === "call" &&
                field(
                  "composer-minutes",
                  "Duration (minutes)",
                  <Input
                    id="composer-minutes"
                    type="number"
                    min={0}
                    inputMode="numeric"
                    value={draft.minutes}
                    onChange={(e) => set("minutes", e.target.value)}
                    disabled={disabled}
                  />,
                )}
              {type === "meeting" &&
                field(
                  "composer-location",
                  "Location",
                  <Input
                    id="composer-location"
                    value={draft.location}
                    onChange={(e) => set("location", e.target.value)}
                    maxLength={500}
                    disabled={disabled}
                  />,
                )}
              {type === "meeting" &&
                field(
                  "composer-url",
                  "Meeting link",
                  <Input
                    id="composer-url"
                    type="url"
                    value={draft.url}
                    onChange={(e) => set("url", e.target.value)}
                    placeholder="https://"
                    disabled={disabled}
                  />,
                )}
              {field(
                "composer-when",
                "When",
                <Input
                  id="composer-when"
                  type="datetime-local"
                  value={draft.when}
                  onChange={(e) => set("when", e.target.value)}
                  disabled={disabled}
                />,
              )}
            </div>
          )}
          {alsoOn && (
            <Label className="min-w-0 text-xs font-normal text-muted-foreground">
              <Checkbox
                checked={linkAlso}
                onCheckedChange={(checked) => setLinkAlso(checked === true)}
                disabled={disabled}
              />
              <span className="truncate">Also on {alsoOn.title}</span>
            </Label>
          )}
          <div className="flex items-center gap-2">
            <Select
              value={type}
              onValueChange={(value) => setType(value as HumanActivityType)}
              disabled={disabled}
            >
              <SelectTrigger size="sm" className="w-32" aria-label="Activity type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="note">Note</SelectItem>
                <SelectItem value="call">Call</SelectItem>
                <SelectItem value="meeting">Meeting</SelectItem>
                <SelectItem value="email">Email</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex-1" />
            <Button type="submit" size="sm" disabled={disabled || isPending || !canSubmit}>
              {note ? "Add note" : `Log ${type}`}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
