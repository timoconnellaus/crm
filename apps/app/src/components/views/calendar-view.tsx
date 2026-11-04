// Calendar view (ADR 0027, ADR 0056): records placed on days by a date or datetime field, in
// month, week and agenda modes. Dragging a record (or "Move to date" on it) to another day
// updates the field through the object's update operation, keeping a datetime's time of day.
// Days are local to the browser; date-only values stay date-only.
import type { Filter } from "@crm/core/client";
import { Badge } from "@crm/ui/components/badge";
import { Button } from "@crm/ui/components/button";
import { Input } from "@crm/ui/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "@crm/ui/components/popover";
import { Skeleton } from "@crm/ui/components/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@crm/ui/components/tabs";
import { cn } from "@crm/ui/lib/utils";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDaysIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "#/lib/query";
import type { ObjectInfo } from "#/lib/schema";
import {
  andFilters,
  fetchRecords,
  RecordCard,
  updateRecord,
  type ViewRecord,
  viewKey,
} from "./records.tsx";

export type CalendarMode = "month" | "week" | "agenda";

export interface CalendarSpec {
  dateField: string;
  mode: CalendarMode;
  cardFields: string[];
  filter?: Filter | undefined;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n: number) => String(n).padStart(2, "0");
/** A local day key, YYYY-MM-DD. */
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function fromKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}
function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}
/** Monday of the week containing `date`. */
function startOfWeek(date: Date): Date {
  const day = (date.getDay() + 6) % 7;
  return addDays(new Date(date.getFullYear(), date.getMonth(), date.getDate()), -day);
}
/** The local day a stored value falls on. */
export function valueDay(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  if (DATE_RE.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : dayKey(date);
}
/** `value` moved to the local day `key`: date-only stays date-only; a datetime keeps its time. */
export function moveToDay(value: unknown, key: string, fieldType: string): string {
  if (fieldType === "date" || (typeof value === "string" && DATE_RE.test(value))) return key;
  const base = typeof value === "string" ? new Date(value) : new Date();
  const target = fromKey(key);
  target.setHours(base.getHours(), base.getMinutes(), base.getSeconds(), base.getMilliseconds());
  return target.toISOString();
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const monthTitle = new Intl.DateTimeFormat("en", { month: "long", year: "numeric" });
const dayTitle = new Intl.DateTimeFormat("en", {
  weekday: "short",
  day: "numeric",
  month: "short",
});

/** The [from, to) bound values a range filter on the field compares with. */
function rangeFilter(field: string, type: string, from: Date, to: Date): Filter {
  const bound = (d: Date) => (type === "date" ? dayKey(d) : d.toISOString());
  return {
    and: [
      { field, op: "gte", value: bound(from) },
      { field, op: "lt", value: bound(to) },
    ],
  };
}

export function CalendarView({
  info,
  spec,
  onModeChange,
}: {
  info: ObjectInfo;
  spec: CalendarSpec;
  onModeChange: (mode: CalendarMode) => void;
}) {
  const field = info.fields.find((f) => f.name === spec.dateField);
  const [cursor, setCursor] = useState(() => new Date());
  const client = useQueryClient();
  const fieldType = field?.fieldType ?? field?.type ?? "datetime";

  const range = useMemo(() => {
    if (spec.mode === "week") {
      const from = startOfWeek(cursor);
      return { from, to: addDays(from, 7) };
    }
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const from = startOfWeek(first);
    return { from, to: addDays(from, 42) };
  }, [cursor, spec.mode]);

  async function moveTo(record: ViewRecord, key: string) {
    const before = record.values[spec.dateField];
    if (valueDay(before) === key) return;
    try {
      await updateRecord(info, record.id, { [spec.dateField]: moveToDay(before, key, fieldType) });
      await client.invalidateQueries({ queryKey: viewKey(info.name) });
      toast.success(`Moved to ${dayTitle.format(fromKey(key))}`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  if (!field) {
    return <p className="p-6 text-sm text-muted-foreground">Pick a date field for the calendar.</p>;
  }

  const step = (direction: number) =>
    setCursor((c) =>
      spec.mode === "week"
        ? addDays(c, 7 * direction)
        : new Date(c.getFullYear(), c.getMonth() + direction, 1),
    );

  return (
    <div className="grid gap-3 px-4 pt-3 pb-6 sm:px-6" data-testid="calendar">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center">
          <Button variant="ghost" size="icon" aria-label="Previous" onClick={() => step(-1)}>
            <ChevronLeftIcon />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setCursor(new Date())}>
            Today
          </Button>
          <Button variant="ghost" size="icon" aria-label="Next" onClick={() => step(1)}>
            <ChevronRightIcon />
          </Button>
        </div>
        <h2 className="text-base font-semibold" data-testid="calendar-title">
          {spec.mode === "week"
            ? `${dayTitle.format(range.from)} – ${dayTitle.format(addDays(range.to, -1))}`
            : spec.mode === "agenda"
              ? `From ${dayTitle.format(cursor)}`
              : monthTitle.format(cursor)}
        </h2>
        <Tabs
          value={spec.mode}
          onValueChange={(mode) => onModeChange(mode as CalendarMode)}
          className="ml-auto"
        >
          <TabsList>
            <TabsTrigger value="month">Month</TabsTrigger>
            <TabsTrigger value="week">Week</TabsTrigger>
            <TabsTrigger value="agenda">Agenda</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {spec.mode === "agenda" ? (
        <Agenda info={info} spec={spec} from={cursor} fieldType={fieldType} onMove={moveTo} />
      ) : (
        <Grid
          info={info}
          spec={spec}
          from={range.from}
          to={range.to}
          month={spec.mode === "month" ? cursor.getMonth() : null}
          fieldType={fieldType}
          onMove={moveTo}
        />
      )}
    </div>
  );
}

function useRangeRecords(
  info: ObjectInfo,
  spec: CalendarSpec,
  from: Date,
  to: Date,
  fieldType: string,
) {
  const filter = andFilters(spec.filter, rangeFilter(spec.dateField, fieldType, from, to));
  const fields = [spec.dateField, ...spec.cardFields];
  return useQuery({
    queryKey: viewKey(info.name, "calendar", filter ?? null, fields),
    queryFn: async () => {
      // A month shows at most a few hundred records; read them all (up to 1,000).
      const items: ViewRecord[] = [];
      let cursor: string | undefined;
      do {
        const page = await fetchRecords(info.name, {
          filter,
          sort: { field: spec.dateField, direction: "asc" },
          limit: 200,
          fields,
          ...(cursor ? { cursor } : {}),
        });
        items.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor && items.length < 1000);
      return items;
    },
    placeholderData: (previous) => previous,
  });
}

function Grid({
  info,
  spec,
  from,
  to,
  month,
  fieldType,
  onMove,
}: {
  info: ObjectInfo;
  spec: CalendarSpec;
  from: Date;
  to: Date;
  month: number | null;
  fieldType: string;
  onMove: (record: ViewRecord, key: string) => void;
}) {
  const records = useRangeRecords(info, spec, from, to, fieldType);
  const byDay = useMemo(() => {
    const map = new Map<string, ViewRecord[]>();
    for (const record of records.data ?? []) {
      const key = valueDay(record.values[spec.dateField]);
      if (key) map.set(key, [...(map.get(key) ?? []), record]);
    }
    return map;
  }, [records.data, spec.dateField]);
  const days: Date[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) days.push(d);
  const today = dayKey(new Date());
  const week = month === null;
  const [over, setOver] = useState<string | null>(null);

  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[42rem] grid-cols-7 overflow-hidden rounded-lg border">
        {WEEKDAYS.map((d) => (
          <div
            key={d}
            className="border-b bg-muted/40 px-2 py-1 text-xs font-medium text-muted-foreground"
          >
            {d}
          </div>
        ))}
        {days.map((day) => {
          const key = dayKey(day);
          const items = byDay.get(key) ?? [];
          const shown = week ? items : items.slice(0, 3);
          const outside = month !== null && day.getMonth() !== month;
          return (
            <section
              key={key}
              aria-label={dayTitle.format(day)}
              data-testid={`calendar-day-${key}`}
              className={cn(
                "grid min-h-24 content-start gap-1 border-r border-b p-1 last:border-r-0 [&:nth-child(7n)]:border-r-0",
                week && "min-h-64",
                outside && "bg-muted/30 text-muted-foreground",
                over === key && "bg-accent",
              )}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes("application/x-crm-event")) return;
                event.preventDefault();
                setOver(key);
              }}
              onDragLeave={() => setOver((o) => (o === key ? null : o))}
              onDrop={(event) => {
                setOver(null);
                const raw = event.dataTransfer.getData("application/x-crm-event");
                if (!raw) return;
                event.preventDefault();
                onMove(JSON.parse(raw) as ViewRecord, key);
              }}
            >
              <span
                className={cn(
                  "justify-self-end rounded-full px-1.5 text-xs tabular-nums",
                  key === today && "bg-primary text-primary-foreground",
                )}
              >
                {day.getDate()}
              </span>
              {records.isPending && !records.data ? (
                <Skeleton className="h-4" />
              ) : (
                shown.map((record) => (
                  <CalendarEvent
                    key={record.id}
                    info={info}
                    record={record}
                    spec={spec}
                    compact={!week}
                    onMove={onMove}
                  />
                ))
              )}
              {!week && items.length > shown.length && (
                <MoreEvents info={info} spec={spec} items={items} day={day} onMove={onMove} />
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function CalendarEvent({
  info,
  record,
  spec,
  compact,
  onMove,
}: {
  info: ObjectInfo;
  record: ViewRecord;
  spec: CalendarSpec;
  compact: boolean;
  onMove: (record: ViewRecord, key: string) => void;
}) {
  return (
    <RecordCard
      info={info}
      record={record}
      fields={spec.cardFields}
      compact={compact}
      draggable
      data-testid="calendar-event"
      className="cursor-grab"
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-crm-event", JSON.stringify(record));
      }}
      actions={<MoveToDate record={record} spec={spec} onMove={onMove} />}
    />
  );
}

/** "Move to date": the keyboard and touch alternative to dragging. */
function MoveToDate({
  record,
  spec,
  onMove,
}: {
  record: ViewRecord;
  spec: CalendarSpec;
  onMove: (record: ViewRecord, key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = valueDay(record.values[spec.dateField]) ?? dayKey(new Date());
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="-my-1 size-5 shrink-0"
          aria-label={`Move ${record.title ?? "record"} to another date`}
        >
          <CalendarDaysIcon className="size-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56">
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const value = String(new FormData(event.currentTarget).get("day") ?? "");
            if (DATE_RE.test(value)) {
              setOpen(false);
              onMove(record, value);
            }
          }}
        >
          <Input type="date" name="day" defaultValue={current} aria-label="New date" />
          <Button type="submit" size="sm">
            Move
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function MoreEvents({
  info,
  spec,
  items,
  day,
  onMove,
}: {
  info: ObjectInfo;
  spec: CalendarSpec;
  items: ViewRecord[];
  day: Date;
  onMove: (record: ViewRecord, key: string) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="text-left text-xs text-muted-foreground hover:underline">
          +{items.length - 3} more
        </button>
      </PopoverTrigger>
      <PopoverContent className="grid max-h-80 w-64 gap-1 overflow-y-auto">
        <p className="text-xs font-medium">{dayTitle.format(day)}</p>
        {items.map((record) => (
          <CalendarEvent
            key={record.id}
            info={info}
            record={record}
            spec={spec}
            compact
            onMove={onMove}
          />
        ))}
      </PopoverContent>
    </Popover>
  );
}

function Agenda({
  info,
  spec,
  from,
  fieldType,
  onMove,
}: {
  info: ObjectInfo;
  spec: CalendarSpec;
  from: Date;
  fieldType: string;
  onMove: (record: ViewRecord, key: string) => void;
}) {
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const filter = andFilters(spec.filter, {
    field: spec.dateField,
    op: "gte",
    value: fieldType === "date" ? dayKey(start) : start.toISOString(),
  });
  const fields = [spec.dateField, ...spec.cardFields];
  const query = useInfiniteQuery({
    queryKey: viewKey(info.name, "agenda", filter ?? null, fields),
    queryFn: ({ pageParam }) =>
      fetchRecords(info.name, {
        filter,
        sort: { field: spec.dateField, direction: "asc" },
        limit: 50,
        fields,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const groups = useMemo(() => {
    const map = new Map<string, ViewRecord[]>();
    for (const record of query.data?.pages.flatMap((p) => p.items) ?? []) {
      const key = valueDay(record.values[spec.dateField]) ?? "";
      map.set(key, [...(map.get(key) ?? []), record]);
    }
    return [...map];
  }, [query.data, spec.dateField]);

  if (query.isPending) {
    return (
      <div className="grid gap-2">
        <Skeleton className="h-12" />
        <Skeleton className="h-12" />
      </div>
    );
  }
  if (!groups.length) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Nothing scheduled from here on.
      </p>
    );
  }
  return (
    <div className="grid gap-4" data-testid="calendar-agenda">
      {groups.map(([key, items]) => (
        <section key={key} className="grid gap-2">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            {dayTitle.format(fromKey(key))}
            <Badge variant="secondary">{items.length}</Badge>
          </h3>
          {items.map((record) => (
            <div key={record.id} className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <CalendarEvent
                  info={info}
                  record={record}
                  spec={spec}
                  compact={false}
                  onMove={onMove}
                />
              </div>
            </div>
          ))}
        </section>
      ))}
      {query.hasNextPage && (
        <Button
          variant="outline"
          size="sm"
          className="justify-self-center"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          Later
        </Button>
      )}
    </div>
  );
}
