// Timeline of a record's activities (newest first) and the composer that adds one.
import { Button } from "@crm/ui/components/button";
import { Card, CardContent } from "@crm/ui/components/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@crm/ui/components/select";
import { Skeleton } from "@crm/ui/components/skeleton";
import { Textarea } from "@crm/ui/components/textarea";
import {
  CalendarIcon,
  type LucideIcon,
  MailIcon,
  MessageSquareTextIcon,
  PhoneIcon,
  SparklesIcon,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { formatDateTime, formatValue } from "#/lib/format";
import { errorMessage } from "#/lib/query";
import { EmptyState } from "../empty-state.tsx";
import { Markdown } from "../markdown.tsx";
import type { ActivityType, NewActivity, TimelineItem } from "./adapters.ts";

const TYPE_ICON: Record<ActivityType, LucideIcon> = {
  note: MessageSquareTextIcon,
  email: MailIcon,
  call: PhoneIcon,
  meeting: CalendarIcon,
  system: SparklesIcon,
};

export interface TimelineProps {
  items: TimelineItem[];
  isPending?: boolean;
  /** False while activity.list is not available: shows a "coming soon" state. */
  wired?: boolean;
  /** Show at most this many (Overview shows a few; the Timeline tab shows all). */
  limit?: number;
}

export function Timeline({ items, isPending, wired = true, limit }: TimelineProps) {
  if (isPending) {
    return (
      <div className="grid gap-3">
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
    );
  }
  if (!items.length) {
    return (
      <EmptyState
        icon={MessageSquareTextIcon}
        title={wired ? "No activity yet" : "Timeline coming soon"}
        description={
          wired
            ? "Notes, emails, calls and meetings show up here."
            : "Notes, emails, calls, meetings and field changes will show up here once activities are available."
        }
      />
    );
  }
  const shown = limit ? items.slice(0, limit) : items;
  return (
    <ol className="relative grid gap-4 border-l pl-6" aria-label="Timeline">
      {shown.map((item) => {
        const Icon = TYPE_ICON[item.type];
        return (
          <li key={item.id} className="relative">
            <span className="absolute top-0.5 -left-[2.0625rem] flex size-6 items-center justify-center rounded-full border bg-background">
              <Icon className="size-3.5 text-muted-foreground" aria-hidden />
            </span>
            <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
              <span className="font-medium">{item.subject ?? item.type}</span>
              <time dateTime={item.occurredAt} className="text-xs text-muted-foreground">
                {formatDateTime(item.occurredAt)}
              </time>
              {item.authorName && (
                <span className="text-xs text-muted-foreground">by {item.authorName}</span>
              )}
            </div>
            {item.payload.changes?.length ? (
              <ul className="mt-1 text-sm text-muted-foreground">
                {item.payload.changes.map((change) => (
                  <li key={change.field}>
                    {change.label}: {formatValue(change.before) || "empty"} →{" "}
                    {formatValue(change.after) || "empty"}
                  </li>
                ))}
              </ul>
            ) : null}
            {item.body && <Markdown className="mt-1">{item.body}</Markdown>}
          </li>
        );
      })}
    </ol>
  );
}

export interface ActivityComposerProps {
  /** Adds the activity; null disables the composer (activity.create not available yet). */
  onSubmit: ((activity: NewActivity) => Promise<void>) | null;
  isPending?: boolean;
}

export function ActivityComposer({ onSubmit, isPending }: ActivityComposerProps) {
  const [type, setType] = useState<NewActivity["type"]>("note");
  const [body, setBody] = useState("");
  const disabled = !onSubmit;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!onSubmit || !body.trim()) return;
    try {
      await onSubmit({ type, body: body.trim() });
      setBody("");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Card className="py-3">
      <CardContent className="px-3">
        <form onSubmit={submit} className="grid gap-2" aria-label="Add activity">
          <Textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder={disabled ? "Notes and logged calls are coming soon" : "Add a note…"}
            aria-label="Activity text"
            disabled={disabled}
            className="min-h-16 resize-y"
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="flex items-center gap-2">
            <Select
              value={type}
              onValueChange={(value) => setType(value as NewActivity["type"])}
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
            <Button type="submit" size="sm" disabled={disabled || isPending || !body.trim()}>
              Add
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
