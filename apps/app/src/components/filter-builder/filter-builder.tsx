// Filter builder: and/or groups of conditions over an object's field registry, emitting filter
// JSON (`Filter`, ADR 0016). Controlled by `value`/`onChange`; edits apply as you type (debounced)
// and only complete conditions reach the filter. `/` opens it and focuses the first input.
import type { FieldDefinition, Filter, ObjectDefinition } from "@crm/core/client";
import { getField } from "@crm/core/client";
import { Badge } from "@crm/ui/components/badge";
import { Button } from "@crm/ui/components/button";
import { Input } from "@crm/ui/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "@crm/ui/components/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@crm/ui/components/select";
import { cn } from "@crm/ui/lib/utils";
import { FilterIcon, ListPlusIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useHotkey } from "#/lib/hotkeys";
import {
  appendChild,
  changeField,
  countConditions,
  type DraftCondition,
  type DraftGroup,
  emptyGroup,
  filterableFields,
  fromFilter,
  isListOp,
  MAX_GROUP_DEPTH,
  newCondition,
  OP_LABELS,
  opNeedsValue,
  opsForField,
  removeNode,
  toFilter,
  updateNode,
} from "./model.ts";

export interface FilterBuilderProps {
  /** The object whose field registry supplies fields and operators. */
  object: ObjectDefinition;
  /** The current filter JSON (e.g. from URL state). */
  value: Filter | undefined;
  /** Called with valid filter JSON, or undefined when there is no complete condition. */
  onChange: (filter: Filter | undefined) => void;
  /** Limit the offered fields (default: every filterable field). */
  fields?: readonly string[];
  /** Register the `/` shortcut (default true). Turn off when two builders share a page. */
  hotkey?: boolean;
  /** Debounce for typed values, in ms. */
  debounceMs?: number;
  className?: string;
}

const same = (a: Filter | undefined, b: Filter | undefined) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function FilterBuilder({
  object,
  value,
  onChange,
  fields,
  hotkey = true,
  debounceMs = 300,
  className,
}: FilterBuilderProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DraftGroup>(() => fromFilter(object, value));
  const lastEmitted = useRef<Filter | undefined>(value);
  const contentRef = useRef<HTMLDivElement>(null);

  const offered = useMemo(
    () => filterableFields(object).filter((f) => !fields || fields.includes(f.name)),
    [object, fields],
  );

  const defaultField =
    offered.find((f) => f.name === object.defaultSort.field)?.name ?? offered[0]?.name;

  // The value changed from outside (back button, saved view): rebuild the draft.
  useEffect(() => {
    if (!same(value, lastEmitted.current)) {
      lastEmitted.current = value;
      setDraft(fromFilter(object, value));
    }
  }, [value, object]);

  // Emit the draft's filter, debounced, when it differs from what we last emitted.
  useEffect(() => {
    const next = toFilter(object, draft);
    if (same(next, lastEmitted.current)) return;
    const timer = setTimeout(() => {
      lastEmitted.current = next;
      onChange(next);
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [draft, object, onChange, debounceMs]);

  useHotkey(
    "/",
    () => {
      if (!open && draft.children.length === 0) {
        setDraft((d) => appendChild(d, d.id, newCondition(object, defaultField)));
      }
      setOpen(true);
    },
    { enabled: hotkey },
  );

  const count = countConditions(value);

  function onOpenChange(next: boolean) {
    if (next && draft.children.length === 0) {
      setDraft((d) => appendChild(d, d.id, newCondition(object, defaultField)));
    }
    setOpen(next);
  }

  function clearAll() {
    setDraft(emptyGroup());
    lastEmitted.current = undefined;
    onChange(undefined);
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <div className={cn("flex items-center gap-1", className)}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" data-testid="filter-button" aria-keyshortcuts="/">
            <FilterIcon />
            Filter
            {count > 0 && (
              <Badge variant="secondary" className="ml-1 px-1.5" data-testid="filter-count">
                {count}
              </Badge>
            )}
          </Button>
        </PopoverTrigger>
        {count > 0 && (
          <Button variant="ghost" size="icon-sm" onClick={clearAll} aria-label="Clear filter">
            <XIcon />
          </Button>
        )}
      </div>
      <PopoverContent
        ref={contentRef}
        align="start"
        className="w-[min(calc(100vw-2rem),44rem)] p-3"
        aria-label="Filter builder"
        onOpenAutoFocus={(event) => {
          // Focus the first value input rather than the first select.
          event.preventDefault();
          requestAnimationFrame(() => {
            const root = contentRef.current;
            const target =
              root?.querySelector<HTMLElement>("input") ??
              root?.querySelector<HTMLElement>("[role=combobox]");
            target?.focus();
          });
        }}
      >
        <GroupEditor
          object={object}
          defaultField={defaultField}
          fields={offered}
          group={draft}
          depth={1}
          onChange={setDraft}
          root={draft}
        />
        <div className="mt-3 flex justify-end border-t pt-3">
          <Button variant="ghost" size="sm" onClick={clearAll}>
            Clear all
          </Button>
          <Button size="sm" className="ml-2" onClick={() => setOpen(false)}>
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface GroupEditorProps {
  object: ObjectDefinition;
  /** Field a new condition starts with. */
  defaultField: string | undefined;
  fields: FieldDefinition[];
  group: DraftGroup;
  root: DraftGroup;
  depth: number;
  onChange: (root: DraftGroup) => void;
}

function GroupEditor({
  object,
  defaultField,
  fields,
  group,
  root,
  depth,
  onChange,
}: GroupEditorProps) {
  const isRoot = depth === 1;
  return (
    <fieldset
      className={cn("grid gap-2", !isRoot && "rounded-md border bg-muted/30 p-2")}
      data-testid="filter-group"
    >
      <legend className="sr-only">{isRoot ? "Filter conditions" : "Condition group"}</legend>
      {group.children.length === 0 && (
        <p className="text-sm text-muted-foreground">No conditions. Add one below.</p>
      )}
      {group.children.map((child, index) => (
        <div key={child.id} className="flex items-start gap-2">
          <div className="w-14 shrink-0 pt-1.5 text-right text-xs text-muted-foreground">
            {index === 0 ? (
              "Where"
            ) : index === 1 ? (
              <Select
                value={group.mode}
                onValueChange={(mode) =>
                  onChange(
                    updateNode(root, group.id, (n) =>
                      n.kind === "group" ? { ...n, mode: mode as "and" | "or" } : n,
                    ),
                  )
                }
              >
                <SelectTrigger size="sm" className="h-7 px-2 text-xs" aria-label="Combine with">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="and">and</SelectItem>
                  <SelectItem value="or">or</SelectItem>
                </SelectContent>
              </Select>
            ) : (
              group.mode
            )}
          </div>
          <div className="min-w-0 flex-1">
            {child.kind === "group" ? (
              <GroupEditor
                object={object}
                defaultField={defaultField}
                fields={fields}
                group={child}
                root={root}
                depth={depth + 1}
                onChange={onChange}
              />
            ) : (
              <ConditionEditor
                object={object}
                fields={fields}
                condition={child}
                onChange={(next) => onChange(updateNode(root, child.id, () => next))}
              />
            )}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={child.kind === "group" ? "Remove group" : "Remove condition"}
            onClick={() => onChange(removeNode(root, child.id))}
          >
            <XIcon />
          </Button>
        </div>
      ))}
      <div className="flex gap-2 pl-16">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange(appendChild(root, group.id, newCondition(object, defaultField)))}
        >
          <PlusIcon />
          Add condition
        </Button>
        {depth < MAX_GROUP_DEPTH && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const sub = emptyGroup(group.mode === "and" ? "or" : "and");
              sub.children.push(newCondition(object, defaultField));
              onChange(appendChild(root, group.id, sub));
            }}
          >
            <ListPlusIcon />
            Add group
          </Button>
        )}
      </div>
    </fieldset>
  );
}

interface ConditionEditorProps {
  object: ObjectDefinition;
  fields: FieldDefinition[];
  condition: DraftCondition;
  onChange: (condition: DraftCondition) => void;
}

function ConditionEditor({ object, fields, condition, onChange }: ConditionEditorProps) {
  const field = getField(object, condition.field);
  const ops = field ? opsForField(field) : [];
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="filter-condition">
      <Select
        value={condition.field}
        onValueChange={(name) => onChange(changeField(object, condition, name))}
      >
        <SelectTrigger size="sm" className="w-40" aria-label="Field">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {fields.map((f) => (
            <SelectItem key={f.name} value={f.name}>
              {f.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={condition.op}
        onValueChange={(op) => onChange({ ...condition, op: op as DraftCondition["op"] })}
      >
        <SelectTrigger size="sm" className="w-40" aria-label="Operator">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ops.map((op) => (
            <SelectItem key={op} value={op}>
              {OP_LABELS[op]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {field && opNeedsValue(condition.op) && (
        <ValueInput field={field} condition={condition} onChange={onChange} />
      )}
    </div>
  );
}

function ValueInput({
  field,
  condition,
  onChange,
}: {
  field: FieldDefinition;
  condition: DraftCondition;
  onChange: (condition: DraftCondition) => void;
}) {
  if ((field.type === "boolean" || field.type === "enum") && !isListOp(condition.op)) {
    const options = field.type === "boolean" ? ["true", "false"] : (field.enumValues ?? []);
    return (
      <Select value={condition.value} onValueChange={(v) => onChange({ ...condition, value: v })}>
        <SelectTrigger size="sm" className="w-36" aria-label="Value">
          <SelectValue placeholder="Choose…" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {field.type === "boolean" ? (option === "true" ? "Yes" : "No") : option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  const type =
    isListOp(condition.op) || field.type === "text" || field.type === "id"
      ? "text"
      : field.type === "number"
        ? "number"
        : "date";
  const placeholder = isListOp(condition.op) ? "a, b, c" : "Value";
  const input = (key: "value" | "value2", label: string) => (
    <Input
      type={type}
      value={condition[key]}
      aria-label={label}
      placeholder={key === "value2" ? "and…" : placeholder}
      className="h-8 min-w-0 flex-1 basis-32"
      onChange={(event) => onChange({ ...condition, [key]: event.target.value })}
    />
  );
  return condition.op === "between" ? (
    <>
      {input("value", "From")}
      {input("value2", "To")}
    </>
  ) : (
    input("value", "Value")
  );
}
