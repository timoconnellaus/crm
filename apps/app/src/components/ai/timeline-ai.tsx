// AI on the timeline (ADR 0153): one-line summaries of long emails and notes, and a meeting's
// prep brief. One-liners are fetched once per set of visible activities (summary.activityLines),
// and the missing ones generated in one batch of at most 10 (summary.activities), never per
// render or keystroke.

import { Button } from "@crm/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@crm/ui/components/dialog";
import { useQuery } from "@tanstack/react-query";
import { NotebookPenIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { callOp } from "#/lib/operations";
import { useOp } from "#/lib/query";
import type { TimelineItem } from "../record/adapters.ts";
import { AiGeneratedBadge, SummaryBody } from "./summary.tsx";

/** Bodies at least this long get a one-line summary. */
export const LONG_BODY = 400;
const MAX_IDS = 50;
const BATCH = 10;

function wantsLine(item: TimelineItem): boolean {
  if (item.type === "system" || item.private) return false;
  return (item.body?.length ?? 0) >= LONG_BODY || item.hasFullBody;
}

/** One-line AI summaries for the long activities among `items`, by activity id. */
export function useActivityLines(items: TimelineItem[]): Map<string, string> {
  const key = items
    .filter(wantsLine)
    .slice(0, MAX_IDS)
    .map((i) => i.id)
    .join(",");
  const ids = useMemo(() => (key ? key.split(",") : []), [key]);
  const cached = useOp(
    "summary.activityLines",
    { ids },
    { enabled: ids.length > 0, staleTime: 60_000 },
  );
  const missing = useMemo(
    () => (cached.data?.available ? cached.data.missing.slice(0, BATCH) : []),
    [cached.data],
  );
  const generated = useQuery({
    queryKey: ["ai", "activity-lines", missing],
    queryFn: () => callOp("summary.activities", { ids: missing }),
    enabled: missing.length > 0,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  return useMemo(() => {
    const lines = new Map<string, string>();
    for (const line of cached.data?.lines ?? []) lines.set(line.id, line.text);
    for (const line of generated.data?.lines ?? []) lines.set(line.id, line.text);
    return lines;
  }, [cached.data, generated.data]);
}

/** The one-liner under a long activity's subject. */
export function ActivityLine({ text }: { text: string }) {
  return (
    <p
      className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground italic"
      data-testid="activity-line"
    >
      <span>{text}</span>
      <AiGeneratedBadge className="not-italic" />
    </p>
  );
}

/** "Prep brief" on a meeting: a dialog with the AI prep brief, generated when first opened. */
export function MeetingPrepButton({ id, subject }: { id: string; subject: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="xs" className="mt-1" data-testid="meeting-prep">
          <NotebookPenIcon />
          Prep brief
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Prep brief</DialogTitle>
          <DialogDescription>{subject ?? "Meeting"}</DialogDescription>
        </DialogHeader>
        <SummaryBody
          subject={{ kind: "meeting", id }}
          generateLabel="Write prep brief"
          enabled={open}
          autoGenerate
          testId="meeting-prep-brief"
        />
      </DialogContent>
    </Dialog>
  );
}
