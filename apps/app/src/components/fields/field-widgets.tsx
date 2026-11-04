// Display and edit widgets for every extension field type (ADR 0023), picked by the field-type
// registry's widget descriptor (`FIELD_TYPE_REGISTRY[type].widget`). Formula fields are read-only
// and show their expression in a tooltip.
import { FIELD_TYPE_REGISTRY } from "@crm/core/client";
import { Badge } from "@crm/ui/components/badge";
import { Checkbox } from "@crm/ui/components/checkbox";
import { Input } from "@crm/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@crm/ui/components/select";
import { Textarea } from "@crm/ui/components/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@crm/ui/components/tooltip";
import { Link } from "@tanstack/react-router";
import { SigmaIcon } from "lucide-react";
import { RecordPicker } from "#/components/record-picker";
import { formatDate, formatDateTime } from "#/lib/format";
import { useOp } from "#/lib/query";
import type { FieldInfo } from "#/lib/schema";
import { recordHref } from "#/lib/schema";
import { useUserLabel, useUsers } from "#/lib/users-adapter";

type Choice = { value: string; label: string; color?: string };

const NONE = "__none__";

function choices(field: FieldInfo): Choice[] {
  return ((field.options?.choices as Choice[] | undefined) ?? []).map((c) => ({
    ...c,
    label: c.label ?? c.value,
  }));
}

function widgetOf(field: FieldInfo) {
  const type = (field.fieldType ?? "text") as keyof typeof FIELD_TYPE_REGISTRY;
  return (FIELD_TYPE_REGISTRY[type] ?? FIELD_TYPE_REGISTRY.text).widget;
}

const Empty = () => <span className="text-muted-foreground">—</span>;

/** The deployment's base currency (Settings → General, ADR 0101). */
export function useBaseCurrency(): string {
  const settings = useOp("settings.get", {}, { staleTime: 5 * 60_000 });
  return settings.data?.baseCurrency ?? "USD";
}

/** A currency amount in `currency`. */
export function formatCurrency(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).format(value);
  } catch {
    return `${currency} ${value}`;
  }
}

/** A currency field's value: in the field's own currency, else the base currency. */
function CurrencyValue({ field, value }: { field: FieldInfo; value: number }) {
  const base = useBaseCurrency();
  return <>{formatCurrency(value, (field.options?.currency as string | undefined) ?? base)}</>;
}

function formatNumber(_field: FieldInfo, value: number, kind: string): string {
  if (kind === "percent") return `${new Intl.NumberFormat("en").format(value)}%`;
  return new Intl.NumberFormat("en").format(value);
}

function RecordLink({ object, id }: { object: string; id: string }) {
  const query = useOp("record.get", { object, id }, { staleTime: 60_000, retry: false });
  const href = recordHref(object, id);
  const label = query.data?.title ?? id;
  return href.startsWith("/x/") ? (
    <Link to="/x/$object/$id" params={{ object, id }} className="hover:underline">
      {label}
    </Link>
  ) : (
    <a href={href} className="hover:underline">
      {label}
    </a>
  );
}

function UserName({ id }: { id: string }) {
  const label = useUserLabel();
  return <>{label(id)}</>;
}

/** Read-only rendering of a field value. */
export function FieldDisplay({ field, value }: { field: FieldInfo; value: unknown }) {
  const kind = widgetOf(field).display;
  if (kind === "formula") return <FormulaValue field={field} value={value} />;
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && !value.length)
  ) {
    return <Empty />;
  }
  switch (kind) {
    case "currency":
      return typeof value === "number" ? (
        <CurrencyValue field={field} value={value} />
      ) : (
        <>{String(value)}</>
      );
    case "number":
    case "percent":
      return <>{typeof value === "number" ? formatNumber(field, value, kind) : String(value)}</>;
    case "date":
      return <time dateTime={String(value)}>{formatDate(String(value))}</time>;
    case "datetime":
      return <time dateTime={String(value)}>{formatDateTime(String(value))}</time>;
    case "checkbox":
      return <>{value ? "Yes" : "No"}</>;
    case "select": {
      const choice = choices(field).find((c) => c.value === value);
      return <Badge variant="secondary">{choice?.label ?? String(value)}</Badge>;
    }
    case "multiSelect":
      return (
        <span className="flex flex-wrap gap-1">
          {(value as string[]).map((v) => (
            <Badge key={v} variant="secondary">
              {choices(field).find((c) => c.value === v)?.label ?? v}
            </Badge>
          ))}
        </span>
      );
    case "relation": {
      const to = String(field.options?.to ?? "");
      const ids = Array.isArray(value) ? (value as string[]) : [String(value)];
      return (
        <span className="flex flex-wrap gap-x-2">
          {ids.map((id) => (
            <RecordLink key={id} object={to} id={id} />
          ))}
        </span>
      );
    }
    case "user":
      return <UserName id={String(value)} />;
    case "email":
      return (
        <a href={`mailto:${String(value)}`} className="hover:underline">
          {String(value)}
        </a>
      );
    case "phone":
      return (
        <a href={`tel:${String(value)}`} className="hover:underline">
          {String(value)}
        </a>
      );
    case "url":
      return (
        <a href={String(value)} target="_blank" rel="noreferrer" className="hover:underline">
          {String(value)}
        </a>
      );
    case "textarea":
      return <span className="whitespace-pre-wrap">{String(value)}</span>;
    default:
      return <>{String(value)}</>;
  }
}

/** A formula's value with its expression in a tooltip. Never editable. */
function FormulaValue({ field, value }: { field: FieldInfo; value: unknown }) {
  const resultType = String(field.options?.resultType ?? "text");
  const expression = String(field.options?.expression ?? "");
  let text: string;
  if (value === null || value === undefined || value === "") text = "—";
  else if (resultType === "number" && typeof value === "number")
    text = formatNumber(field, value, "number");
  else if (resultType === "boolean") text = value ? "Yes" : "No";
  else if (resultType === "date") text = formatDate(String(value));
  else if (resultType === "datetime") text = formatDateTime(String(value));
  else text = String(value);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex cursor-help items-center gap-1"
          data-testid={`formula-${field.name}`}
        >
          <SigmaIcon className="size-3 text-muted-foreground" aria-hidden />
          {text}
          <span className="sr-only">(computed: {expression})</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <span className="font-mono text-xs">= {expression}</span>
      </TooltipContent>
    </Tooltip>
  );
}

function RelationEditor({
  field,
  value,
  onChange,
  id,
}: {
  field: FieldInfo;
  value: unknown;
  onChange: (value: unknown) => void;
  id?: string;
}) {
  const to = String(field.options?.to ?? "");
  const many = field.options?.many === true;
  if (!many && (to === "organisation" || to === "person")) {
    return <CoreRecordEditor to={to} field={field} value={value} onChange={onChange} id={id} />;
  }
  return <ExtensionRelationEditor field={field} value={value} onChange={onChange} id={id} />;
}

/** One person or organisation, picked by searching (there may be thousands). */
function CoreRecordEditor({
  to,
  field,
  value,
  onChange,
  id,
}: {
  to: "organisation" | "person";
  field: FieldInfo;
  value: unknown;
  onChange: (value: unknown) => void;
  id?: string;
}) {
  const current = typeof value === "string" ? value : null;
  const record = useOp(
    "record.get",
    { object: to, id: current ?? "" },
    { enabled: Boolean(current), staleTime: 60_000, retry: false },
  );
  return (
    <RecordPicker
      id={id}
      object={to}
      label={field.label}
      placeholder={to === "organisation" ? "Choose an organisation" : "Choose a person"}
      value={current ? { id: current, name: record.data?.title ?? current } : null}
      onChange={(picked) => onChange(picked?.id ?? null)}
    />
  );
}

function ExtensionRelationEditor({
  field,
  value,
  onChange,
  id,
}: {
  field: FieldInfo;
  value: unknown;
  onChange: (value: unknown) => void;
  id?: string;
}) {
  const to = String(field.options?.to ?? "");
  const many = field.options?.many === true;
  const query = useOp("record.list", { object: to, limit: 200 }, { staleTime: 30_000 });
  const options = query.data?.items ?? [];
  if (many) {
    const selected = new Set((value as string[] | null) ?? []);
    return (
      <div className="grid max-h-40 gap-1 overflow-y-auto rounded-md border p-2" id={id}>
        {options.map((o) => (
          <div key={o.id} className="flex items-center gap-2 text-sm">
            <Checkbox
              aria-label={o.title ?? o.id}
              checked={selected.has(o.id)}
              onCheckedChange={(on) => {
                const next = new Set(selected);
                if (on) next.add(o.id);
                else next.delete(o.id);
                onChange(next.size ? [...next] : null);
              }}
            />
            <span aria-hidden>{o.title ?? o.id}</span>
          </div>
        ))}
      </div>
    );
  }
  return (
    <Select
      value={(value as string | null) ?? NONE}
      onValueChange={(v) => onChange(v === NONE ? null : v)}
    >
      <SelectTrigger id={id} className="w-full">
        <SelectValue placeholder="None" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>None</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.id} value={o.id}>
            {o.title ?? o.id}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function UserEditor({
  value,
  onChange,
  id,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
  id?: string;
}) {
  const users = useUsers();
  return (
    <Select
      value={(value as string | null) ?? NONE}
      onValueChange={(v) => onChange(v === NONE ? null : v)}
    >
      <SelectTrigger id={id} className="w-full">
        <SelectValue placeholder="Nobody" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>Nobody</SelectItem>
        {users.map((u) => (
          <SelectItem key={u.id} value={u.id}>
            {u.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function toLocalInput(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

/** An input for a writable field. `onChange` receives the API value (null clears). */
export function FieldEditor({
  field,
  value,
  onChange,
  id,
}: {
  field: FieldInfo;
  value: unknown;
  onChange: (value: unknown) => void;
  id?: string;
}) {
  const kind = widgetOf(field).edit;
  const text = (v: string) => onChange(v === "" ? null : v);
  switch (kind) {
    case null:
    case "formula":
      return <FieldDisplay field={field} value={value} />;
    case "textarea":
      return (
        <Textarea id={id} value={(value as string) ?? ""} onChange={(e) => text(e.target.value)} />
      );
    case "number":
    case "currency":
    case "percent":
      return (
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          step="any"
          value={value === null || value === undefined ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        />
      );
    case "date":
      return (
        <Input
          id={id}
          type="date"
          value={(value as string) ?? ""}
          onChange={(e) => text(e.target.value)}
        />
      );
    case "datetime":
      return (
        <Input
          id={id}
          type="datetime-local"
          value={toLocalInput(value)}
          onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)}
        />
      );
    case "checkbox":
      return (
        <Checkbox
          id={id}
          checked={value === true}
          onCheckedChange={(on) => onChange(on === true)}
        />
      );
    case "select":
      return (
        <Select
          value={(value as string | null) ?? NONE}
          onValueChange={(v) => onChange(v === NONE ? null : v)}
        >
          <SelectTrigger id={id} className="w-full">
            <SelectValue placeholder="None" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>None</SelectItem>
            {choices(field).map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case "multiSelect": {
      const selected = new Set((value as string[] | null) ?? []);
      return (
        <div className="flex flex-wrap gap-3" id={id}>
          {choices(field).map((c) => (
            <div key={c.value} className="flex items-center gap-1.5 text-sm">
              <Checkbox
                aria-label={c.label}
                checked={selected.has(c.value)}
                onCheckedChange={(on) => {
                  const next = new Set(selected);
                  if (on) next.add(c.value);
                  else next.delete(c.value);
                  onChange(next.size ? [...next] : null);
                }}
              />
              <span aria-hidden>{c.label}</span>
            </div>
          ))}
        </div>
      );
    }
    case "relation":
      return (
        <RelationEditor field={field} value={value} onChange={onChange} {...(id ? { id } : {})} />
      );
    case "user":
      return <UserEditor value={value} onChange={onChange} {...(id ? { id } : {})} />;
    case "email":
      return (
        <Input
          id={id}
          type="email"
          value={(value as string) ?? ""}
          onChange={(e) => text(e.target.value)}
        />
      );
    case "url":
      return (
        <Input
          id={id}
          type="url"
          value={(value as string) ?? ""}
          onChange={(e) => text(e.target.value)}
        />
      );
    case "phone":
      return (
        <Input
          id={id}
          type="tel"
          value={(value as string) ?? ""}
          onChange={(e) => text(e.target.value)}
        />
      );
    default:
      return (
        <Input id={id} value={(value as string) ?? ""} onChange={(e) => text(e.target.value)} />
      );
  }
}
