// Board (Kanban) view (ADR 0027, ADR 0056): one column per choice of a single-select field, each
// with a live count and an optional sum (record.groups), its cards paged in with infinite
// scroll and virtualised when long. Dragging a card to another column (or "Move to" on a card,
// for keyboards and touch) calls the object's update operation, so validation and stage rules
// apply; when a rule names a missing field, a dialog asks for it and retries the move.
import type { Filter, Sort } from "@relationship-os/core/client";
import { Badge } from "@relationship-os/ui/components/badge";
import { Button } from "@relationship-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@relationship-os/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@relationship-os/ui/components/dropdown-menu";
import { Label } from "@relationship-os/ui/components/label";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { cn } from "@relationship-os/ui/lib/utils";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { MoreHorizontalIcon } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { FieldEditor } from "#/components/fields/field-widgets";
import { callOp } from "#/lib/operations";
import { errorMessage } from "#/lib/query";
import type { FieldInfo, ObjectInfo } from "#/lib/schema";
import { type BoardChoice, useBoardChoices } from "./board-choices.ts";
import {
  andFilters,
  fetchRecords,
  missingFieldOf,
  RecordCard,
  updateRecord,
  type ViewRecord,
  viewKey,
} from "./records.tsx";

export interface BoardSpec {
  groupBy: string;
  sumField?: string | undefined;
  columnOrder?: string[] | undefined;
  cardFields: string[];
  filter?: Filter | undefined;
  sort?: Sort | undefined;
}

const PAGE = 50;
/** Column values are strings; the "no value" column is this key. */
const NONE = "__none__";

interface PendingMove {
  record: ViewRecord;
  from: string;
  to: string;
}

interface MissingField {
  move: PendingMove;
  field: FieldInfo;
  message: string;
}

function formatSum(field: FieldInfo | undefined, value: number | null | undefined): string | null {
  if (!field || value === null || value === undefined) return null;
  const currency = field.options?.currency as string | undefined;
  try {
    return new Intl.NumberFormat("en", {
      ...(field.fieldType === "currency"
        ? { style: "currency", currency: currency ?? "USD", maximumFractionDigits: 0 }
        : { maximumFractionDigits: 2 }),
    }).format(value);
  } catch {
    return String(value);
  }
}

export function BoardView({ info, spec }: { info: ObjectInfo; spec: BoardSpec }) {
  const client = useQueryClient();
  const group = info.fields.find((f) => f.name === spec.groupBy);
  const sumField = spec.sumField ? info.fields.find((f) => f.name === spec.sumField) : undefined;
  const [pending, setPending] = useState<PendingMove[]>([]);
  const [missing, setMissing] = useState<MissingField | null>(null);

  const choices = useBoardChoices(info, group, spec.filter);
  const labelOf = (value: string | null) => boardLabel(group, choices, value);
  const groups = useQuery({
    queryKey: viewKey(
      info.name,
      "groups",
      spec.groupBy,
      spec.sumField ?? null,
      spec.filter ?? null,
    ),
    queryFn: () =>
      callOp("record.groups", {
        object: info.name,
        groupBy: spec.groupBy,
        ...(spec.sumField ? { sumField: spec.sumField } : {}),
        ...(spec.filter ? { filter: spec.filter } : {}),
      }),
    enabled: Boolean(group),
  });

  const columns = useMemo(() => {
    if (!group) return [];
    const values = choices.map((c) => c.value);
    const order = spec.columnOrder ?? [];
    const ordered = [
      ...order.filter((v) => values.includes(v)),
      ...values.filter((v) => !order.includes(v)),
    ];
    const hasNone = groups.data?.groups.some((g) => g.value === null && g.count > 0);
    return [...ordered, ...(hasNone ? [NONE] : [])];
  }, [group, choices, spec.columnOrder, groups.data]);

  if (!group) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        Pick a single-select field to group the board by.
      </p>
    );
  }

  const stats = (value: string) =>
    groups.data?.groups.find((g) => (g.value ?? NONE) === value) ?? { count: 0, sum: null };

  async function move(
    record: ViewRecord,
    from: string,
    to: string,
    extra: Record<string, unknown> = {},
  ) {
    if (from === to && !Object.keys(extra).length) return;
    const entry = { record, from, to };
    setPending((list) => [...list.filter((p) => p.record.id !== record.id), entry]);
    try {
      await updateRecord(info, record.id, { [spec.groupBy]: to === NONE ? null : to, ...extra });
      await client.invalidateQueries({ queryKey: viewKey(info.name) });
      setPending((list) => list.filter((p) => p.record.id !== record.id));
      toast.success(`Moved to ${labelOf(to === NONE ? null : to)}`);
    } catch (error) {
      // Roll back the card, then ask for a field a rule needs.
      setPending((list) => list.filter((p) => p.record.id !== record.id));
      const field = missingFieldOf(error, info);
      if (field) setMissing({ move: entry, field, message: errorMessage(error) });
      else toast.error(errorMessage(error));
    }
  }

  return (
    <div
      className="flex h-full min-h-0 gap-3 overflow-x-auto overscroll-x-contain p-4 sm:px-6"
      data-testid="board"
    >
      {columns.map((value) => (
        <BoardColumn
          key={value}
          info={info}
          spec={spec}
          value={value}
          label={labelOf(value === NONE ? null : value)}
          count={stats(value).count}
          sum={formatSum(sumField, stats(value).sum)}
          sumLabel={sumField?.label}
          countPending={groups.isPending}
          pending={pending}
          columns={columns}
          labelOf={labelOf}
          onMove={move}
        />
      ))}
      {missing && (
        <MissingFieldDialog
          info={info}
          missing={missing}
          targetLabel={labelOf(missing.move.to === NONE ? null : missing.move.to)}
          onCancel={() => setMissing(null)}
          onSubmit={async (value) => {
            const { move: m, field } = missing;
            setMissing(null);
            await move(m.record, m.from, m.to, { [field.name]: value });
          }}
        />
      )}
    </div>
  );
}

function BoardColumn({
  info,
  spec,
  value,
  label,
  count,
  sum,
  sumLabel,
  countPending,
  pending,
  columns,
  labelOf,
  onMove,
}: {
  info: ObjectInfo;
  spec: BoardSpec;
  value: string;
  label: string;
  count: number;
  sum: string | null;
  sumLabel: string | undefined;
  countPending: boolean;
  pending: PendingMove[];
  columns: string[];
  labelOf: (value: string | null) => string;
  onMove: (record: ViewRecord, from: string, to: string) => void;
}) {
  const filter = andFilters(
    spec.filter,
    value === NONE
      ? { field: spec.groupBy, op: "is_null" }
      : { field: spec.groupBy, op: "eq", value },
  );
  const fields = [spec.groupBy, ...(spec.sumField ? [spec.sumField] : []), ...spec.cardFields];
  const query = useInfiniteQuery({
    queryKey: viewKey(info.name, "board", value, filter ?? null, spec.sort ?? null, fields),
    queryFn: ({ pageParam }) =>
      fetchRecords(info.name, {
        filter,
        sort: spec.sort,
        limit: PAGE,
        fields,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const movedAway = useMemo(
    () => new Set(pending.filter((p) => p.from === value).map((p) => p.record.id)),
    [pending, value],
  );
  const arriving = useMemo(
    () => pending.filter((p) => p.to === value).map((p) => p.record),
    [pending, value],
  );
  const cards = useMemo(() => {
    const loaded = query.data?.pages.flatMap((p) => p.items) ?? [];
    const kept = loaded.filter((r) => !movedAway.has(r.id) && !arriving.some((a) => a.id === r.id));
    return [...arriving, ...kept];
  }, [query.data, movedAway, arriving]);
  const shownCount =
    count -
    movedAway.size +
    arriving.filter((a) => !query.data?.pages.some((p) => p.items.some((i) => i.id === a.id)))
      .length;

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: cards.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 92,
    overscan: 6,
    getItemKey: (index) => cards[index]?.id ?? index,
  });
  const items = virtualizer.getVirtualItems();
  const last = items.at(-1);
  useEffect(() => {
    if (!last) return;
    if (last.index >= cards.length - 8 && query.hasNextPage && !query.isFetchingNextPage) {
      void query.fetchNextPage();
    }
  }, [last, cards.length, query]);

  const [over, setOver] = useState(false);

  return (
    <section
      className={cn(
        "flex h-full w-72 shrink-0 flex-col rounded-xl border bg-muted/40",
        over && "ring-2 ring-ring",
      )}
      aria-label={label}
      data-testid={`board-column-${value}`}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("application/x-crm-card")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        setOver(false);
        const raw = event.dataTransfer.getData("application/x-crm-card");
        if (!raw) return;
        event.preventDefault();
        const { record, from } = JSON.parse(raw) as { record: ViewRecord; from: string };
        onMove(record, from, value);
      }}
    >
      <header className="flex items-center gap-2 px-3 pt-3 pb-2">
        <h3 className="truncate text-sm font-medium">{label}</h3>
        <Badge variant="secondary" data-testid="board-column-count">
          {countPending ? "…" : Math.max(0, shownCount)}
        </Badge>
        {sum !== null && (
          <span
            className="ml-auto truncate text-xs text-muted-foreground"
            title={sumLabel}
            data-testid="board-column-sum"
          >
            {sum}
          </span>
        )}
      </header>
      <div
        ref={scrollRef}
        className="min-h-24 flex-1 overflow-y-auto overscroll-y-contain px-2 pb-2"
      >
        {query.isPending ? (
          <div className="grid gap-2">
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
          </div>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {items.map((item) => {
              const record = cards[item.index] as ViewRecord;
              return (
                <div
                  key={item.key}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  className="absolute top-0 left-0 w-full pb-2"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <RecordCard
                    info={info}
                    record={record}
                    fields={spec.cardFields}
                    draggable
                    className="cursor-grab active:cursor-grabbing"
                    data-testid="board-card"
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData(
                        "application/x-crm-card",
                        JSON.stringify({ record, from: value }),
                      );
                    }}
                    actions={
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="-my-1 size-6 shrink-0"
                            aria-label={`Move ${record.title ?? "card"}`}
                          >
                            <MoreHorizontalIcon />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuLabel>Move to</DropdownMenuLabel>
                          {columns
                            .filter((c) => c !== value)
                            .map((c) => (
                              <DropdownMenuItem key={c} onSelect={() => onMove(record, value, c)}>
                                {labelOf(c === NONE ? null : c)}
                              </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    }
                  />
                </div>
              );
            })}
          </div>
        )}
        {!query.isPending && !cards.length && (
          <p className="px-1 py-6 text-center text-xs text-muted-foreground">Drop cards here</p>
        )}
      </div>
    </section>
  );
}

function boardLabel(
  group: FieldInfo | undefined,
  choices: readonly BoardChoice[],
  value: string | null,
): string {
  if (value === null) return `No ${(group?.label ?? "value").toLowerCase()}`;
  return choices.find((c) => c.value === value)?.label ?? value;
}

/** Asks for the field a stage rule needs, then retries the move with it. */
export function MissingFieldDialog({
  info,
  missing,
  targetLabel,
  onCancel,
  onSubmit,
}: {
  info: ObjectInfo;
  missing: MissingField;
  targetLabel: string;
  onCancel: () => void;
  onSubmit: (value: unknown) => Promise<void>;
}) {
  const [value, setValue] = useState<unknown>(
    missing.move.record.values[missing.field.name] ?? null,
  );
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await onSubmit(value);
    } finally {
      setSaving(false);
    }
  }
  const title = missing.move.record.title ?? info.label;
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-md" data-testid="missing-field-dialog">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>
              Move “{title}” to {targetLabel}
            </DialogTitle>
            <DialogDescription>{missing.message}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="missing-field">{missing.field.label}</Label>
            <FieldEditor
              id="missing-field"
              field={missing.field}
              value={value}
              onChange={setValue}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || value === null || value === ""}>
              Move
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
