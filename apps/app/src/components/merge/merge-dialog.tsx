// Merge two people or two organisations (person.merge / organisation.merge):
//   1. choose the duplicate (search), unless both records are given (a list's bulk action)
//   2. pick which record survives, choose field values side by side, and see what moves
//   3. confirm; land on the survivor, with a toast linking to the merged-away record in Trash.
import type { CoreInput } from "@relationship-os/core";
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
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { cn } from "@relationship-os/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRightIcon, MergeIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { callOp } from "#/lib/operations";
import { errorMessage, invalidateAfterWrite } from "#/lib/query";
import { useUserLabel } from "#/lib/users-adapter";
import { RecordSearch } from "../record-picker.tsx";
import {
  addedListValues,
  defaultChoices,
  differingFields,
  MERGE_FIELDS,
  type MergeObject,
  type MergeRecord,
  type MergeSide,
  mergeInput,
  organisationToMergeRecord,
  personToMergeRecord,
} from "./merge-model.ts";

export interface MergeDialogProps {
  object: MergeObject;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * The records to merge. One id (a record page): the dialog asks for the duplicate first. Two
   * ids (a list with two rows selected): it starts at the field chooser.
   */
  ids: readonly string[];
  /** Called after a successful merge (e.g. to clear a list selection). */
  onMerged?: (survivorId: string) => void;
  /** Stay on the current page after merging instead of opening the survivor (Duplicates). */
  stayOnPage?: boolean;
}

const NOUN = {
  person: { one: "person", many: "people", path: "/people/$id" as const },
  organisation: { one: "organisation", many: "organisations", path: "/organisations/$id" as const },
};

async function loadMergeRecord(object: MergeObject, id: string): Promise<MergeRecord> {
  if (object === "person") return personToMergeRecord(await callOp("person.get", { id }));
  return organisationToMergeRecord(await callOp("organisation.get", { id }));
}

interface MovePreview {
  activities: number;
  activitiesMore: boolean;
  tasks: number;
  tasksMore: boolean;
  affiliations: number;
  children: number | null;
}

/** What would move from `id` onto the survivor: linked activities, tasks, affiliations, children. */
async function loadMovePreview(object: MergeObject, id: string): Promise<MovePreview> {
  const [activities, tasks, affiliations, children] = await Promise.all([
    callOp("activity.listForRecord", { object, recordId: id, limit: 100 }),
    callOp("task.list", {
      filter: { field: "linkedRecordId", op: "eq", value: id },
      limit: 100,
      fields: ["id"],
    }),
    callOp(
      "affiliation.list",
      object === "person" ? { personId: id, limit: 500 } : { organisationId: id, limit: 500 },
    ),
    object === "organisation"
      ? callOp("organisation.list", {
          filter: { field: "parentId", op: "eq", value: id },
          limit: 100,
          fields: ["id"],
        })
      : null,
  ]);
  return {
    activities: activities.items.length,
    activitiesMore: Boolean(activities.nextCursor),
    tasks: tasks.items.length,
    tasksMore: Boolean(tasks.nextCursor),
    affiliations: affiliations.items.length,
    children: children ? children.items.length : null,
  };
}

export function MergeDialog({
  object,
  open,
  onOpenChange,
  ids,
  onMerged,
  stayOnPage = false,
}: MergeDialogProps) {
  const noun = NOUN[object];
  const idsKey = ids.join(",");
  const [pair, setPair] = useState<string[]>([...ids]);
  useEffect(() => {
    if (open) setPair(idsKey ? idsKey.split(",") : []);
  }, [open, idsKey]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Merge {noun.many}</DialogTitle>
          <DialogDescription>
            {pair.length < 2
              ? `Choose the duplicate ${noun.one} to merge with.`
              : "Pick the record to keep, and which values it keeps. The other goes to Trash."}
          </DialogDescription>
        </DialogHeader>
        {open && pair.length < 2 && (
          <RecordSearch
            object={object}
            label={`Search for the duplicate ${noun.one}`}
            exclude={pair}
            autoFocus
            onSelect={(record) => setPair([...pair, record.id])}
          />
        )}
        {open && pair.length >= 2 && pair[0] && pair[1] && (
          <MergeChooser
            object={object}
            firstId={pair[0]}
            secondId={pair[1]}
            onBack={ids.length < 2 ? () => setPair(pair.slice(0, 1)) : undefined}
            stayOnPage={stayOnPage}
            onCancel={() => onOpenChange(false)}
            onMerged={(survivorId) => {
              onOpenChange(false);
              onMerged?.(survivorId);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function MergeChooser({
  object,
  firstId,
  secondId,
  onBack,
  onCancel,
  onMerged,
  stayOnPage = false,
}: {
  object: MergeObject;
  firstId: string;
  secondId: string;
  stayOnPage?: boolean;
  onBack?: () => void;
  onCancel: () => void;
  onMerged: (survivorId: string) => void;
}) {
  const noun = NOUN[object];
  const navigate = useNavigate();
  const client = useQueryClient();
  const userLabel = useUserLabel();
  const records = useQuery({
    queryKey: ["merge-records", object, firstId, secondId],
    queryFn: () =>
      Promise.all([loadMergeRecord(object, firstId), loadMergeRecord(object, secondId)]),
    staleTime: 0,
  });
  const [survivorId, setSurvivorId] = useState(firstId);
  // Field choices the user changed; the rest follow the defaults for the current survivor.
  const [overrides, setOverrides] = useState<Record<string, MergeSide>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [survivor, merged] = useMemo(() => {
    const list = records.data ?? [];
    const s = list.find((r) => r.id === survivorId);
    const m = list.find((r) => r.id !== survivorId);
    return [s, m] as const;
  }, [records.data, survivorId]);

  const choices = useMemo(
    () => (survivor && merged ? { ...defaultChoices(survivor, merged), ...overrides } : null),
    [survivor, merged, overrides],
  );

  const moves = useQuery({
    queryKey: ["merge-preview", object, merged?.id],
    queryFn: () => loadMovePreview(object, merged?.id as string),
    enabled: Boolean(merged),
    staleTime: 0,
  });

  if (records.isPending) {
    return (
      <div className="grid gap-2" aria-busy="true">
        <Skeleton className="h-16" />
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (records.isError || !survivor || !merged || !choices) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {records.isError ? errorMessage(records.error) : "Loading…"}
      </p>
    );
  }

  const differing = differingFields(survivor, merged);
  const same = MERGE_FIELDS[object].filter((f) => !differing.includes(f));
  const added = addedListValues(survivor, merged);
  const show = (record: MergeRecord, field: string) => {
    const raw = record.values[field];
    if (raw === null || raw === undefined || raw === "") return null;
    if (field === "ownerId") return userLabel(raw);
    return record.display[field] ?? raw;
  };

  async function confirm() {
    if (!survivor || !merged || !choices) return;
    setPending(true);
    setError(null);
    try {
      const input = mergeInput(survivor, merged, choices);
      if (object === "person") await callOp("person.merge", input as CoreInput<"person.merge">);
      else await callOp("organisation.merge", input as CoreInput<"organisation.merge">);
      await invalidateAfterWrite(client, `${object}.merge`, [
        "person.",
        "organisation.",
        "affiliation.",
        "task.",
        "duplicate.",
      ]);
      const mergedId = merged.id;
      const mergedTitle = merged.title;
      onMerged(survivor.id);
      if (!stayOnPage) navigate({ to: noun.path, params: { id: survivor.id } });
      toast.success(`Merged ${mergedTitle} into ${survivor.title}`, {
        description: `${mergedTitle} is in Trash and can be restored for 30 days.`,
        action: {
          label: "View in Trash",
          onClick: () => navigate({ to: noun.path, params: { id: mergedId } }),
        },
      });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-5" data-testid="merge-chooser">
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Keep</legend>
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Record to keep">
          {(records.data ?? []).map((record) => {
            const keep = record.id === survivorId;
            return (
              // biome-ignore lint/a11y/useSemanticElements: a card-style radio.
              <button
                key={record.id}
                type="button"
                role="radio"
                aria-checked={keep}
                aria-label={`Keep ${record.title}`}
                onClick={() => {
                  setSurvivorId(record.id);
                  setOverrides({});
                }}
                className={cn(
                  "grid gap-0.5 rounded-md border p-3 text-left transition-colors hover:bg-accent",
                  keep && "border-primary ring-2 ring-primary/30",
                )}
              >
                <span className="flex items-center gap-2">
                  <span className="truncate font-medium">{record.title}</span>
                  <Badge variant={keep ? "default" : "secondary"} className="ml-auto">
                    {keep ? "Keep" : "Merge away"}
                  </Badge>
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {record.subtitle ?? record.id}
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <section className="grid gap-2" aria-labelledby="merge-fields-heading">
        <h3 id="merge-fields-heading" className="text-sm font-medium">
          Field values
        </h3>
        {differing.length === 0 ? (
          <p className="text-sm text-muted-foreground">Both records have the same values.</p>
        ) : (
          <div className="grid gap-2">
            {differing.map((field) => (
              <fieldset
                key={field.name}
                className="grid gap-1.5 sm:grid-cols-[8rem_1fr_1fr] sm:items-stretch"
                aria-label={field.label}
              >
                <legend className="sr-only">{field.label}</legend>
                <span className="text-xs text-muted-foreground sm:self-center">{field.label}</span>
                {(["survivor", "merged"] as const).map((side) => {
                  const record = side === "survivor" ? survivor : merged;
                  const value = show(record, field.name);
                  const chosen = choices[field.name] === side;
                  return (
                    <label
                      key={side}
                      className={cn(
                        "flex min-w-0 cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2 text-sm",
                        chosen && "border-primary bg-primary/5",
                      )}
                    >
                      <input
                        type="radio"
                        name={`merge-${field.name}`}
                        checked={chosen}
                        onChange={() => setOverrides({ ...overrides, [field.name]: side })}
                        aria-label={`${field.label} from ${record.title}`}
                        className="mt-0.5 accent-primary"
                      />
                      <span
                        className={cn(
                          "line-clamp-3 break-words",
                          !value && "text-muted-foreground",
                        )}
                      >
                        {value ?? "Empty"}
                      </span>
                    </label>
                  );
                })}
              </fieldset>
            ))}
          </div>
        )}
        {same.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Same on both: {same.map((f) => f.label).join(", ")}.
          </p>
        )}
      </section>

      <section
        className="grid gap-2 rounded-md border bg-muted/40 p-3 text-sm"
        aria-labelledby="merge-moves-heading"
        data-testid="merge-preview"
      >
        <h3 id="merge-moves-heading" className="font-medium">
          What moves from {merged.title} to {survivor.title}
        </h3>
        {moves.isPending ? (
          <Skeleton className="h-10" />
        ) : moves.isError ? (
          <p className="text-destructive">{errorMessage(moves.error)}</p>
        ) : (
          <ul className="grid gap-1">
            <MoveLine
              count={moves.data.activities}
              more={moves.data.activitiesMore}
              one="activity"
              many="activities"
            />
            <MoveLine
              count={moves.data.tasks}
              more={moves.data.tasksMore}
              one="task"
              many="tasks"
            />
            <MoveLine count={moves.data.affiliations} one="affiliation" many="affiliations" />
            {moves.data.children !== null && (
              <MoveLine
                count={moves.data.children}
                one="child organisation"
                many="child organisations"
              />
            )}
          </ul>
        )}
        {added.length > 0 && (
          <ul className="grid gap-1">
            {added.map((list) => (
              <li key={list.name} className="flex flex-wrap items-center gap-1">
                <span className="text-muted-foreground">{list.label} added:</span>
                {list.values.map((value) => (
                  <Badge key={value} variant="secondary" className="max-w-full truncate">
                    {value}
                  </Badge>
                ))}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          {merged.title} goes to Trash pointing at {survivor.title}. It can be restored for 30 days,
          without what moved.
        </p>
      </section>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <DialogFooter className="gap-2">
        {onBack && (
          <Button type="button" variant="ghost" onClick={onBack} className="sm:mr-auto">
            Choose another
          </Button>
        )}
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" onClick={confirm} disabled={pending}>
          <MergeIcon />
          {pending ? "Merging…" : `Merge into ${survivor.title}`}
        </Button>
      </DialogFooter>
    </div>
  );
}

function MoveLine({
  count,
  more,
  one,
  many,
}: {
  count: number;
  more?: boolean;
  one: string;
  many: string;
}) {
  return (
    <li className={cn("flex items-center gap-2", count === 0 && "text-muted-foreground")}>
      <ArrowRightIcon className="size-3.5" aria-hidden />
      {count}
      {more ? "+" : ""} {count === 1 && !more ? one : many}
    </li>
  );
}
