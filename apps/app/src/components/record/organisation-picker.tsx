// Pick an organisation by typing its name or domain (search.global over organisations), or
// create one by name when it does not exist yet. Inline (no popover), so it works inside dialogs
// and on phones.
import { Button } from "@relationship-os/ui/components/button";
import { Input } from "@relationship-os/ui/components/input";
import { cn } from "@relationship-os/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Building2Icon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { callOp } from "#/lib/operations";
import { errorMessage, useOpMutation } from "#/lib/query";

export interface PickedOrganisation {
  id: string;
  name: string;
}

export interface OrganisationPickerProps {
  value: PickedOrganisation | null;
  onChange: (value: PickedOrganisation | null) => void;
  /** Id of the text input, for a <Label htmlFor>. */
  id?: string;
  autoFocus?: boolean;
}

export function OrganisationPicker({ value, onChange, id, autoFocus }: OrganisationPickerProps) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const listId = useId();
  const create = useOpMutation("organisation.create");

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 150);
    return () => clearTimeout(timer);
  }, [query]);

  const results = useQuery({
    queryKey: ["op", "search.global", { query: debounced, objects: ["organisation"] }],
    queryFn: () =>
      callOp("search.global", { query: debounced, objects: ["organisation"], limit: 6 }),
    enabled: debounced.length > 0 && !value,
  });

  if (value) {
    return (
      <div className="flex h-9 items-center gap-2 rounded-md border px-3 text-sm">
        <Building2Icon className="size-4 text-muted-foreground" aria-hidden />
        <span className="flex-1 truncate" data-testid="picked-organisation">
          {value.name}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Clear ${value.name}`}
          onClick={() => onChange(null)}
        >
          <XIcon />
        </Button>
      </div>
    );
  }

  const hits = debounced ? (results.data?.hits ?? []) : [];
  const exact = hits.some((h) => h.title.toLowerCase() === query.trim().toLowerCase());

  async function createNew() {
    const name = query.trim();
    if (!name) return;
    try {
      const org = await create.mutateAsync({ name });
      onChange({ id: org.id, name: org.name });
      toast.success(`Created ${org.name}`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <div className="grid gap-1">
      <Input
        id={id}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search organisations…"
        autoComplete="off"
        aria-controls={listId}
        autoFocus={autoFocus}
      />
      {query.trim() && (
        <ul
          id={listId}
          aria-label="Matching organisations"
          className="grid max-h-48 overflow-y-auto rounded-md border p-1"
        >
          {hits.map((hit) => (
            <li key={hit.id}>
              <button
                type="button"
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent",
                )}
                onClick={() => onChange({ id: hit.id, name: hit.title })}
              >
                <Building2Icon className="size-4 text-muted-foreground" aria-hidden />
                <span className="truncate">{hit.title}</span>
                {hit.subtitle && (
                  <span className="ml-auto truncate text-xs text-muted-foreground">
                    {hit.subtitle}
                  </span>
                )}
              </button>
            </li>
          ))}
          {results.isFetching && hits.length === 0 && (
            <li className="px-2 py-1.5 text-sm text-muted-foreground">Searching…</li>
          )}
          {!exact && (
            <li>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                onClick={() => void createNew()}
                disabled={create.isPending}
              >
                <PlusIcon className="size-4 text-muted-foreground" aria-hidden />
                Create “{query.trim()}”
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
