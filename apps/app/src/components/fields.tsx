// Small form controls for record editors: a tag input and a repeatable-row list editor.
import { Badge } from "@relationship-os/ui/components/badge";
import { Button } from "@relationship-os/ui/components/button";
import { PlusIcon, XIcon } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useState } from "react";

export interface TagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  id?: string;
  placeholder?: string;
}

/** Type a tag and press Enter or comma; Backspace on an empty input removes the last one. */
export function TagInput({ value, onChange, id, placeholder = "Add a tag…" }: TagInputProps) {
  const [text, setText] = useState("");

  function add(raw: string) {
    const tags = raw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (tags.length) onChange([...new Set([...value, ...tags])]);
    setText("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      if (!text.trim()) return;
      event.preventDefault();
      add(text);
    } else if (event.key === "Backspace" && !text && value.length) {
      onChange(value.slice(0, -1));
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1 rounded-md border px-2 py-1.5 focus-within:ring-[3px] focus-within:ring-ring/50">
      {value.map((tag) => (
        <Badge key={tag} variant="secondary" className="gap-1 pr-1">
          {tag}
          <button
            type="button"
            className="rounded-sm hover:bg-muted-foreground/20"
            aria-label={`Remove tag ${tag}`}
            onClick={() => onChange(value.filter((t) => t !== tag))}
          >
            <XIcon className="size-3" />
          </button>
        </Badge>
      ))}
      <input
        id={id}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => text.trim() && add(text)}
        placeholder={value.length ? "" : placeholder}
        className="min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}

export interface RowListProps<T> {
  /** Accessible group name, e.g. "Emails". */
  label: string;
  rows: T[];
  onChange: (rows: T[]) => void;
  /** A new empty row. */
  blank: () => T;
  renderRow: (row: T, update: (patch: Partial<T>) => void, index: number) => ReactNode;
  addLabel: string;
}

/** Repeatable rows (emails, phones, social profiles) with add and remove. */
export function RowList<T>({ label, rows, onChange, blank, renderRow, addLabel }: RowListProps<T>) {
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">{label}</legend>
      {rows.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place by position.
        <div key={index} className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            {renderRow(
              row,
              (patch) => onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r))),
              index,
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            <XIcon />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="w-fit"
        onClick={() => onChange([...rows, blank()])}
      >
        <PlusIcon />
        {addLabel}
      </Button>
    </fieldset>
  );
}
