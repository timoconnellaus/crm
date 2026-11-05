// Pick a person or an organisation by searching for it: `RecordSearch` is the inline search list
// (used in the merge dialog), `RecordPicker` the same list in a popover behind a button (the
// parent-organisation field). Searches the object's list operation by name, email or domain.
import type { Filter } from "@relationship-os/core/client";
import { Button } from "@relationship-os/ui/components/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@relationship-os/ui/components/command";
import { Popover, PopoverContent, PopoverTrigger } from "@relationship-os/ui/components/popover";
import { useQuery } from "@tanstack/react-query";
import { ChevronsUpDownIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { callOp } from "#/lib/operations";

export type PickableObject = "person" | "organisation";

export interface PickedRecord {
  id: string;
  title: string;
  subtitle: string | null;
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** Live records matching `query` (name, email or domain), at most `limit`. */
export async function searchRecords(
  object: PickableObject,
  query: string,
  limit = 8,
): Promise<PickedRecord[]> {
  const q = query.trim();
  if (object === "person") {
    const filter: Filter | undefined = q
      ? {
          or: [
            { field: "displayName", op: "contains", value: q },
            { field: "emails", op: "contains", value: q },
          ],
        }
      : undefined;
    const page = await callOp("person.list", {
      ...(filter ? { filter } : {}),
      limit,
      fields: ["displayName", "primaryEmail", "organisationName"],
    });
    return page.items.map((p) => ({
      id: p.id,
      title: p.displayName ?? p.id,
      subtitle: [p.primaryEmail, p.organisationName].filter(Boolean).join(" · ") || null,
    }));
  }
  const filter: Filter | undefined = q
    ? {
        or: [
          { field: "name", op: "contains", value: q },
          { field: "domains", op: "contains", value: q },
        ],
      }
    : undefined;
  const page = await callOp("organisation.list", {
    ...(filter ? { filter } : {}),
    limit,
    fields: ["name", "primaryDomain"],
  });
  return page.items.map((o) => ({
    id: o.id,
    title: o.name ?? o.id,
    subtitle: o.primaryDomain ?? null,
  }));
}

export interface RecordSearchProps {
  object: PickableObject;
  onSelect: (record: PickedRecord) => void;
  /** Ids not offered (e.g. the record itself). */
  exclude?: readonly string[];
  placeholder?: string;
  label: string;
  autoFocus?: boolean;
}

export function RecordSearch({
  object,
  onSelect,
  exclude = [],
  placeholder,
  label,
  autoFocus,
}: RecordSearchProps) {
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query.trim(), 200);
  const results = useQuery({
    queryKey: ["record-search", object, debounced],
    queryFn: () => searchRecords(object, debounced, 10),
    staleTime: 5_000,
  });
  const hits = (results.data ?? []).filter((r) => !exclude.includes(r.id));

  return (
    <Command shouldFilter={false} className="rounded-md border">
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={
          placeholder ?? (object === "person" ? "Search people…" : "Search organisations…")
        }
        aria-label={label}
        autoFocus={autoFocus}
      />
      <CommandList className="max-h-60">
        {results.isFetching && hits.length === 0 ? (
          <div className="px-3 py-2 text-sm text-muted-foreground">Searching…</div>
        ) : (
          <CommandEmpty>No matches.</CommandEmpty>
        )}
        {hits.map((hit) => (
          <CommandItem key={hit.id} value={hit.id} onSelect={() => onSelect(hit)}>
            <span className="truncate">{hit.title}</span>
            {hit.subtitle && (
              <span className="ml-auto truncate text-xs text-muted-foreground">{hit.subtitle}</span>
            )}
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  );
}

export interface RecordPickerProps {
  object: PickableObject;
  value: { id: string; name: string } | null;
  onChange: (value: { id: string; name: string } | null) => void;
  exclude?: readonly string[];
  id?: string;
  /** Shown when nothing is picked. */
  placeholder: string;
  label: string;
}

export function RecordPicker({
  object,
  value,
  onChange,
  exclude,
  id,
  placeholder,
  label,
}: RecordPickerProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            className="min-w-0 flex-1 justify-between font-normal"
            aria-label={`${label}: ${value?.name ?? "none"}`}
          >
            <span className={value ? "truncate" : "truncate text-muted-foreground"}>
              {value?.name ?? placeholder}
            </span>
            <ChevronsUpDownIcon className="opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[min(22rem,calc(100vw-2rem))] p-0" align="start">
          <RecordSearch
            object={object}
            exclude={exclude}
            label={`Search for ${label.toLowerCase()}`}
            autoFocus
            onSelect={(record) => {
              onChange({ id: record.id, name: record.title });
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
      {value && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Clear ${label.toLowerCase()}`}
          onClick={() => onChange(null)}
        >
          <XIcon />
        </Button>
      )}
    </div>
  );
}
