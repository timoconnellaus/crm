// The view-type switcher (Table, Board, Calendar, Gallery) for any object's list page, its
// settings (group by, sum, date field, card fields, image), and the body that renders the
// chosen non-table view. The table itself stays the page's own DataTable.
import type { ObjectViewType } from "@relationship-os/core/client";
import { Button } from "@relationship-os/ui/components/button";
import { Checkbox } from "@relationship-os/ui/components/checkbox";
import { Label } from "@relationship-os/ui/components/label";
import { Popover, PopoverContent, PopoverTrigger } from "@relationship-os/ui/components/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@relationship-os/ui/components/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@relationship-os/ui/components/tooltip";
import { cn } from "@relationship-os/ui/lib/utils";
import {
  CalendarIcon,
  KanbanIcon,
  LayoutGridIcon,
  type LucideIcon,
  Settings2Icon,
  TableIcon,
} from "lucide-react";
import type { FieldInfo, ObjectInfo } from "#/lib/schema";
import { BoardView } from "./board-view.tsx";
import { type CalendarMode, CalendarView } from "./calendar-view.tsx";
import { GalleryView } from "./gallery-view.tsx";
import type { LayoutConfig, ViewStateApi } from "./view-state.ts";

/** Single-selects, and single relations to extension objects (a deal's stage), ADR 0103. */
export const groupableFields = (info: ObjectInfo) =>
  info.fields.filter(
    (f) =>
      !f.multi &&
      f.filterable &&
      (f.type === "enum" ||
        (f.fieldType === "relation" &&
          f.options?.many !== true &&
          String(f.options?.to ?? "").includes("."))),
  );
export const summableFields = (info: ObjectInfo) =>
  info.fields.filter((f) => f.type === "number" && !f.multi && f.sortable);
export const dateFields = (info: ObjectInfo) =>
  info.fields.filter(
    (f) => (f.type === "date" || f.type === "datetime") && !f.multi && f.filterable,
  );
const SYSTEM_DATES = new Set(["createdAt", "updatedAt", "completedAt", "deletedAt"]);
const imageFields = (info: ObjectInfo) =>
  info.fields.filter(
    (f) =>
      f.fieldType === "url" ||
      (f.type === "text" && /image|logo|photo|avatar/i.test(f.name) && f.filterable),
  );
const cardCandidates = (info: ObjectInfo) =>
  info.fields.filter(
    (f) => f.name !== "id" && f.name !== info.titleField && !f.multi && f.type !== "json",
  );

const TYPES: { type: ObjectViewType; label: string; icon: LucideIcon }[] = [
  { type: "table", label: "Table", icon: TableIcon },
  { type: "board", label: "Board", icon: KanbanIcon },
  { type: "calendar", label: "Calendar", icon: CalendarIcon },
  { type: "gallery", label: "Gallery", icon: LayoutGridIcon },
];

/** Settings for a type the object supports, or null when it cannot show that type. */
export function defaultLayout(
  info: ObjectInfo,
  type: ObjectViewType,
  current: LayoutConfig,
  columns: readonly string[],
): LayoutConfig | null {
  const cards = (current.cardFields ?? columns.filter((c) => c !== info.titleField)).slice(0, 4);
  switch (type) {
    case "board": {
      const group =
        groupableFields(info).find((f) => f.name === current.groupBy) ?? groupableFields(info)[0];
      if (!group) return null;
      return {
        groupBy: group.name,
        ...(current.sumField ? { sumField: current.sumField } : {}),
        cardFields: cards.filter((c) => c !== group.name),
      };
    }
    case "calendar": {
      const dates = dateFields(info);
      const date =
        dates.find((f) => f.name === current.dateField) ??
        dates.find((f) => !SYSTEM_DATES.has(f.name)) ??
        dates[0];
      if (!date) return null;
      return { dateField: date.name, mode: current.mode ?? "month", cardFields: cards.slice(0, 2) };
    }
    case "gallery":
      return {
        ...(current.imageField ? { imageField: current.imageField } : {}),
        cardFields: cards,
      };
    default:
      return {};
  }
}

export function ViewTypeSwitcher({ info, view }: { info: ObjectInfo; view: ViewStateApi }) {
  const current = view.state.type;
  return (
    <div className="flex items-center gap-1">
      <div
        className="flex items-center rounded-md border p-0.5"
        role="radiogroup"
        aria-label="View type"
      >
        {TYPES.map(({ type, label, icon: Icon }) => {
          const layout = defaultLayout(info, type, view.state.layout, view.state.columns);
          const disabled = layout === null;
          return (
            <Tooltip key={type}>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    variant={current === type ? "secondary" : "ghost"}
                    size="sm"
                    className="h-7 px-2"
                    role="radio"
                    aria-checked={current === type}
                    aria-label={label}
                    data-testid={`view-type-${type}`}
                    disabled={disabled}
                    onClick={() => layout && view.setType(type, type === "table" ? {} : layout)}
                  >
                    <Icon />
                    <span className="max-lg:sr-only">{label}</span>
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {disabled
                  ? type === "board"
                    ? `${info.label} has no single-select field to group by`
                    : `${info.label} has no date field`
                  : label}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      {current !== "table" && <LayoutSettings info={info} view={view} />}
    </div>
  );
}

function FieldSelect({
  label,
  fields,
  value,
  onChange,
  allowNone,
  testId,
}: {
  label: string;
  fields: FieldInfo[];
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  allowNone?: boolean;
  testId?: string;
}) {
  const NONE = "__none__";
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      <Select value={value ?? NONE} onValueChange={(v) => onChange(v === NONE ? undefined : v)}>
        <SelectTrigger size="sm" aria-label={label} data-testid={testId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {allowNone && <SelectItem value={NONE}>None</SelectItem>}
          {fields.map((f) => (
            <SelectItem key={f.name} value={f.name}>
              {f.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function LayoutSettings({ info, view }: { info: ObjectInfo; view: ViewStateApi }) {
  const { type, layout } = view.state;
  const set = (patch: Partial<LayoutConfig>) => {
    const next = { ...layout, ...patch };
    for (const key of Object.keys(next) as (keyof LayoutConfig)[]) {
      if (next[key] === undefined) delete next[key];
    }
    view.setLayout(next);
  };
  const cards = layout.cardFields ?? [];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7" data-testid="view-settings">
          <Settings2Icon />
          <span className="max-sm:sr-only">Settings</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="grid w-72 gap-3">
        {type === "board" && (
          <>
            <FieldSelect
              label="Group by"
              fields={groupableFields(info)}
              value={layout.groupBy}
              onChange={(groupBy) => set({ groupBy, columnOrder: undefined })}
              testId="board-group-by"
            />
            <FieldSelect
              label="Sum"
              fields={summableFields(info)}
              value={layout.sumField}
              onChange={(sumField) => set({ sumField })}
              allowNone
              testId="board-sum"
            />
          </>
        )}
        {type === "calendar" && (
          <FieldSelect
            label="Date field"
            fields={dateFields(info)}
            value={layout.dateField}
            onChange={(dateField) => set({ dateField })}
          />
        )}
        {type === "gallery" && (
          <FieldSelect
            label="Image"
            fields={imageFields(info)}
            value={layout.imageField}
            onChange={(imageField) => set({ imageField })}
            allowNone
          />
        )}
        <fieldset className="grid gap-1.5">
          <legend className="mb-1 text-sm font-medium">Fields on cards</legend>
          <div className="grid max-h-48 gap-1 overflow-y-auto pr-1">
            {cardCandidates(info).map((field) => (
              <Label key={field.name} className={cn("flex items-center gap-2 font-normal")}>
                <Checkbox
                  checked={cards.includes(field.name)}
                  onCheckedChange={(checked) =>
                    set({
                      cardFields:
                        checked === true
                          ? [...cards, field.name].slice(0, 8)
                          : cards.filter((c) => c !== field.name),
                    })
                  }
                />
                {field.label}
              </Label>
            ))}
          </div>
        </fieldset>
      </PopoverContent>
    </Popover>
  );
}

/** The non-table body of a list page: board, calendar or gallery of the view state. */
export function ObjectViewBody({ info, view }: { info: ObjectInfo; view: ViewStateApi }) {
  const { type, layout, filter, sort } = view.state;
  const cardFields = layout.cardFields ?? [];
  if (type === "board") {
    return (
      <BoardView
        info={info}
        spec={{
          groupBy: layout.groupBy ?? groupableFields(info)[0]?.name ?? "",
          sumField: layout.sumField,
          columnOrder: layout.columnOrder,
          cardFields,
          filter,
          sort,
        }}
      />
    );
  }
  if (type === "calendar") {
    return (
      <CalendarView
        info={info}
        spec={{
          dateField: layout.dateField ?? dateFields(info)[0]?.name ?? "",
          mode: layout.mode ?? "month",
          cardFields,
          filter,
        }}
        onModeChange={(mode: CalendarMode) => view.setLayout({ ...layout, mode })}
      />
    );
  }
  return (
    <GalleryView info={info} spec={{ imageField: layout.imageField, cardFields, filter, sort }} />
  );
}

/** How the page body scrolls for a view type: boards scroll per column. */
export function scrollFor(type: ObjectViewType): "body" | "none" {
  return type === "board" || type === "table" ? "none" : "body";
}
