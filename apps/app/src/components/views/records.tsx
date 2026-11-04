// What the board, calendar and gallery views share: reading records of any object (record.list,
// which returns core and extension fields alike), writing one through the object's own update
// operation (so validation and stage rules apply), cache keys that the usual write invalidation
// refreshes, and the card that shows a record.
import type { Filter, Sort } from "@crm/core/client";
import { Avatar, AvatarFallback, AvatarImage } from "@crm/ui/components/avatar";
import { Badge } from "@crm/ui/components/badge";
import { cn } from "@crm/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { FieldDisplay } from "#/components/fields/field-widgets";
import { listOperationOf } from "#/lib/count";
import { formatDate, formatDateTime, initials } from "#/lib/format";
import { callOp, OperationCallError } from "#/lib/operations";
import type { FieldInfo, ObjectInfo } from "#/lib/schema";
import { useUserLabel } from "#/lib/users-adapter";

export interface ViewRecord {
  id: string;
  title: string | null;
  values: Record<string, unknown>;
}

/**
 * Cache key for a view's reads of `object`. It sits under the object's list operation (core
 * objects) or `record.list` (extension objects), so the invalidation every write already does
 * for that prefix refreshes boards, calendars and galleries too.
 */
export function viewKey(object: string, ...parts: unknown[]): unknown[] {
  return ["op", listOperationOf(object), "view", object, ...parts];
}

/** A list read of any object's records, with the fields the view shows. */
export async function fetchRecords(
  object: string,
  input: {
    filter?: Filter | undefined;
    sort?: Sort | undefined;
    cursor?: string;
    limit?: number;
    fields: string[];
  },
): Promise<{ items: ViewRecord[]; nextCursor: string | null }> {
  const page = await callOp("record.list", {
    object,
    limit: input.limit ?? 50,
    fields: [...new Set(input.fields)].filter((f) => f !== "id"),
    ...(input.filter ? { filter: input.filter } : {}),
    ...(input.sort ? { sort: input.sort } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
  });
  return {
    items: page.items.map((r) => ({ id: r.id, title: r.title, values: r.values })),
    nextCursor: page.nextCursor,
  };
}

/** `a AND b`, leaving out the parts that are missing. */
export function andFilters(...parts: (Filter | null | undefined)[]): Filter | undefined {
  const present = parts.filter((p): p is Filter => Boolean(p));
  if (!present.length) return undefined;
  return present.length === 1 ? present[0] : { and: present };
}

/**
 * Writes field values of one record through its object's own operations: task status through
 * task.complete / task.reopen, other core fields through `<object>.update`, extension fields
 * through record.update. Operation errors (a stage rule naming a missing field) propagate.
 */
export async function updateRecord(
  info: ObjectInfo,
  id: string,
  values: Record<string, unknown>,
): Promise<void> {
  const isCore = !info.extension || !info.name.includes(".");
  const core: Record<string, unknown> = {};
  const extension: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(values)) {
    const field = info.fields.find((f) => f.name === name);
    if (isCore && field && !field.extension) core[name] = value;
    else extension[name] = value;
  }
  if (Object.keys(extension).length) {
    await callOp("record.update", { object: info.name, id, values: extension });
  }
  if (!Object.keys(core).length) return;
  if (info.name === "task" && "status" in core) {
    const { status, ...rest } = core;
    await callOp(status === "done" ? "task.complete" : "task.reopen", { id });
    if (!Object.keys(rest).length) return;
    // biome-ignore lint/suspicious/noExplicitAny: core field names are checked by the operation.
    await callOp("task.update", { id, ...rest } as any);
    return;
  }
  const op = `${info.name}.update` as "person.update";
  // biome-ignore lint/suspicious/noExplicitAny: core field names are checked by the operation.
  await callOp(op, { id, ...core } as any);
}

/**
 * The field an update was refused for, when the error names one the user can fill in (a stage
 * rule: "Done needs Spent"), or null.
 */
export function missingFieldOf(error: unknown, info: ObjectInfo): FieldInfo | null {
  if (!(error instanceof OperationCallError) || error.code !== "invalid_input") return null;
  const details = error.details as { field?: unknown } | undefined;
  const name = typeof details?.field === "string" ? details.field : null;
  const field = name ? info.fields.find((f) => f.name === name) : undefined;
  return field && !field.readOnly && field.extension ? field : null;
}

/** The choices of a select field, in declared order (extension choices or core enum values). */
export function choiceValues(field: FieldInfo): string[] {
  const choices = field.options?.choices as { value: string }[] | undefined;
  return choices?.map((c) => c.value) ?? field.enumValues ?? [];
}

/** The label of a choice of a select field (extension choices or core enum values). */
export function choiceLabel(field: FieldInfo, value: string | null): string {
  if (value === null) return `No ${field.label.toLowerCase()}`;
  const choices = field.options?.choices as { value: string; label?: string }[] | undefined;
  const label = choices?.find((c) => c.value === value)?.label;
  return label ?? value.charAt(0).toUpperCase() + value.slice(1);
}

/** A record's page, or null when the object has none (tasks, activities). */
export function RecordTitleLink({
  object,
  record,
  className,
}: {
  object: string;
  record: ViewRecord;
  className?: string;
}) {
  const title = record.title || (record.values.title as string | undefined) || "(untitled)";
  const cls = cn("font-medium hover:underline", className);
  if (object === "person") {
    return (
      <Link to="/people/$id" params={{ id: record.id }} className={cls}>
        {title}
      </Link>
    );
  }
  if (object === "organisation") {
    return (
      <Link to="/organisations/$id" params={{ id: record.id }} className={cls}>
        {title}
      </Link>
    );
  }
  if (object.includes(".")) {
    return (
      <Link to="/x/$object/$id" params={{ object, id: record.id }} className={cls}>
        {title}
      </Link>
    );
  }
  return <span className={cn("font-medium", className)}>{title}</span>;
}

/** One field value on a card: extension fields by their widget, core fields by type. */
export function CardValue({ field, value }: { field: FieldInfo; value: unknown }): ReactNode {
  const userLabel = useUserLabel();
  if (field.fieldType) return <FieldDisplay field={field} value={value} />;
  if (value === null || value === undefined || value === "") {
    return <span className="text-muted-foreground">—</span>;
  }
  if (field.type === "datetime") return formatDateTime(String(value));
  if (field.type === "date") return formatDate(String(value));
  if (field.type === "enum")
    return <Badge variant="secondary">{choiceLabel(field, String(value))}</Badge>;
  if (field.type === "id" && /(owner|assignee|author|user|createdBy)/i.test(field.name)) {
    return userLabel(String(value)) || String(value);
  }
  if (Array.isArray(value)) return value.map(String).join(", ");
  return String(value);
}

/** The card a board, calendar or gallery shows for a record. */
export function RecordCard({
  info,
  record,
  fields,
  image,
  compact,
  actions,
  className,
  ...rest
}: {
  info: ObjectInfo;
  record: ViewRecord;
  fields: readonly string[];
  /** Image URL, or true to show initials. */
  image?: string | true | null;
  compact?: boolean;
  actions?: ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLDivElement>) {
  const title = record.title || (record.values.title as string | undefined) || "(untitled)";
  const shown = fields
    .map((name) => info.fields.find((f) => f.name === name))
    .filter((f): f is FieldInfo => Boolean(f) && f?.name !== info.titleField);
  return (
    <div
      className={cn(
        "grid gap-1.5 rounded-lg border bg-card p-3 text-sm text-card-foreground shadow-xs",
        compact && "gap-0.5 p-1.5 text-xs",
        className,
      )}
      data-record-id={record.id}
      {...rest}
    >
      <div className="flex min-w-0 items-start gap-2">
        {image !== undefined && image !== null && (
          <Avatar className={cn("size-8 shrink-0", compact && "size-5")}>
            {typeof image === "string" && <AvatarImage src={image} alt="" />}
            <AvatarFallback className="text-[10px]">{initials(title)}</AvatarFallback>
          </Avatar>
        )}
        <RecordTitleLink object={info.name} record={record} className="min-w-0 flex-1 truncate" />
        {actions}
      </div>
      {!compact &&
        shown.map((field) => (
          <div key={field.name} className="flex min-w-0 items-baseline gap-2 text-xs">
            <span className="shrink-0 text-muted-foreground">{field.label}</span>
            <span className="min-w-0 truncate">
              <CardValue field={field} value={record.values[field.name]} />
            </span>
          </div>
        ))}
    </div>
  );
}
