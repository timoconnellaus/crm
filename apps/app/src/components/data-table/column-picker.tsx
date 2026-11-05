// Column picker: toggles which registry fields a DataTable shows. Order follows `available`.
import type { ObjectDefinition } from "@relationship-os/core/client";
import { getField } from "@relationship-os/core/client";
import { Button } from "@relationship-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@relationship-os/ui/components/dropdown-menu";
import { Columns3Icon } from "lucide-react";

export interface ColumnPickerProps {
  object: ObjectDefinition;
  /** Field names that can be shown, in display order. */
  available: readonly string[];
  /** Currently visible field names. */
  value: readonly string[];
  onChange: (columns: string[]) => void;
  /** Field names that cannot be hidden (default: the first available). */
  required?: readonly string[];
}

export function ColumnPicker({ object, available, value, onChange, required }: ColumnPickerProps) {
  const locked = new Set(required ?? available.slice(0, 1));

  function toggle(name: string, on: boolean) {
    const next = new Set(value);
    if (on) next.add(name);
    else next.delete(name);
    // Keep the picker's order so toggling never shuffles columns.
    onChange(available.filter((col) => next.has(col)));
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" data-testid="column-picker">
          <Columns3Icon />
          <span className="hidden sm:inline">Columns</span>
          <span className="sr-only sm:hidden">Columns</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-96 w-56 overflow-y-auto">
        <DropdownMenuLabel>Show columns</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {available.map((name) => (
          <DropdownMenuCheckboxItem
            key={name}
            checked={value.includes(name)}
            disabled={locked.has(name)}
            onCheckedChange={(on) => toggle(name, on === true)}
            onSelect={(event) => event.preventDefault()}
          >
            {getField(object, name)?.label ?? name}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
