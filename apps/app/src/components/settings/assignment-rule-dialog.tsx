// The assignment rule editor (ADR 0246): a name, conditions (a field of the record, or of a record
// it links to, with an operator and value), and who it assigns: round-robin among chosen users, or
// one user. Values use the same field widgets as a record's form.
import { Button } from "@relationship-os/ui/components/button";
import { Checkbox } from "@relationship-os/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@relationship-os/ui/components/dialog";
import { Input } from "@relationship-os/ui/components/input";
import { Label } from "@relationship-os/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@relationship-os/ui/components/select";
import { Trash2Icon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { FieldEditor } from "#/components/fields/field-widgets";
import { errorMessage, useOpMutation } from "#/lib/query";
import type { FieldInfo, ObjectInfo } from "#/lib/schema";
import { useUsers } from "#/lib/users-adapter";

export type AssignmentOp = "eq" | "in" | "between" | "is_null" | "is_not_null";

export interface AssignmentCondition {
  field: string;
  op: AssignmentOp;
  value?: unknown;
  via?: string | undefined;
}

export interface AssignmentRule {
  id: string;
  object: string;
  name: string;
  position: number;
  enabled: boolean;
  conditions: AssignmentCondition[];
  method: "roundRobin" | "user";
  userIds: string[];
}

const OP_LABELS: Record<AssignmentOp, string> = {
  eq: "equals",
  in: "is one of",
  between: "is between",
  is_null: "is empty",
  is_not_null: "is not empty",
};

const SELF = "__self__";

/** Fields a condition can test: single-valued and filterable. */
function conditionFields(info: ObjectInfo): FieldInfo[] {
  return info.fields.filter((f) => f.filterable && !f.multi && f.type !== "json");
}

/** The object's single relations, whose records a condition can test (a lead's organisation). */
function relations(info: ObjectInfo, objects: readonly ObjectInfo[]) {
  return info.fields.flatMap((f) => {
    const to = f.options?.to;
    const target = typeof to === "string" ? objects.find((o) => o.name === to) : undefined;
    return f.fieldType === "relation" && !f.options?.many && target ? [{ field: f, target }] : [];
  });
}

function opsFor(field: FieldInfo | undefined): AssignmentOp[] {
  const ranged = field?.type === "number" || field?.type?.startsWith("date");
  return ["eq", "in", ...(ranged ? (["between"] as const) : []), "is_null", "is_not_null"];
}

/** A field as the value editors want it: core fields declare a type but no widget. */
export function editorField(field: FieldInfo): FieldInfo {
  if (field.fieldType) return field;
  const fieldType = (["number", "date", "datetime"] as const).find((t) => t === field.type);
  return fieldType ? { ...field, fieldType } : field;
}

function targetOf(info: ObjectInfo, objects: readonly ObjectInfo[], via: string | undefined) {
  if (!via) return info;
  return relations(info, objects).find((r) => r.field.name === via)?.target ?? info;
}

/** "Organisation Country is one of AU, NZ", for the rule list. */
export function conditionText(
  info: ObjectInfo,
  objects: readonly ObjectInfo[],
  condition: AssignmentCondition,
): string {
  const target = targetOf(info, objects, condition.via);
  const field = target.fields.find((f) => f.name === condition.field);
  const via = condition.via
    ? `${info.fields.find((f) => f.name === condition.via)?.label ?? condition.via} `
    : "";
  const value = Array.isArray(condition.value)
    ? condition.value.join(condition.op === "between" ? " and " : ", ")
    : (condition.value ?? "");
  return `${via}${field?.label ?? condition.field} ${OP_LABELS[condition.op]} ${value}`.trim();
}

function ValueEditor({
  field,
  condition,
  id,
  onChange,
}: {
  field: FieldInfo;
  condition: AssignmentCondition;
  id: string;
  onChange: (value: unknown) => void;
}) {
  const editor = editorField(field);
  if (condition.op === "is_null" || condition.op === "is_not_null") return null;
  if (condition.op === "between") {
    const [low, high] = Array.isArray(condition.value) ? condition.value : [null, null];
    return (
      <div className="grid grid-cols-2 gap-2">
        <FieldEditor
          id={`${id}-low`}
          field={editor}
          value={low ?? null}
          onChange={(v) => onChange([v, high ?? null])}
        />
        <FieldEditor
          id={`${id}-high`}
          field={editor}
          value={high ?? null}
          onChange={(v) => onChange([low ?? null, v])}
        />
      </div>
    );
  }
  if (condition.op === "in") {
    const list = Array.isArray(condition.value) ? (condition.value as unknown[]) : [];
    if (field.options?.choices) {
      return (
        <FieldEditor
          id={id}
          field={{ ...field, fieldType: "multiSelect" }}
          value={list}
          onChange={(v) => onChange(v ?? [])}
        />
      );
    }
    return (
      <Input
        id={id}
        aria-label="Values, separated by commas"
        placeholder="Separate values with commas"
        defaultValue={list.join(", ")}
        onChange={(e) =>
          onChange(
            e.target.value
              .split(",")
              .map((v) => v.trim())
              .filter(Boolean)
              .map((v) => (field.type === "number" ? Number(v) : v)),
          )
        }
      />
    );
  }
  return <FieldEditor id={id} field={editor} value={condition.value ?? null} onChange={onChange} />;
}

function ConditionRow({
  info,
  objects,
  condition,
  index,
  onChange,
  onRemove,
}: {
  info: ObjectInfo;
  objects: readonly ObjectInfo[];
  condition: AssignmentCondition;
  index: number;
  onChange: (next: AssignmentCondition) => void;
  onRemove: () => void;
}) {
  const links = relations(info, objects);
  const target = targetOf(info, objects, condition.via);
  const fields = conditionFields(target);
  const field = fields.find((f) => f.name === condition.field);
  return (
    <fieldset className="grid gap-2 rounded-md border p-3" data-testid="assignment-condition">
      <legend className="sr-only">Condition {index + 1}</legend>
      <div className="flex flex-wrap items-center gap-2">
        {links.length > 0 && (
          <Select
            value={condition.via ?? SELF}
            onValueChange={(via) =>
              onChange({
                field: "",
                op: "eq",
                ...(via === SELF ? {} : { via }),
              })
            }
          >
            <SelectTrigger aria-label="Which record" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SELF}>This record</SelectItem>
              {links.map((l) => (
                <SelectItem key={l.field.name} value={l.field.name}>
                  {l.field.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select
          value={condition.field || undefined}
          onValueChange={(name) => onChange({ ...condition, field: name, value: undefined })}
        >
          <SelectTrigger aria-label="Field" className="w-48">
            <SelectValue placeholder="Field" />
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
          onValueChange={(op) =>
            onChange({ ...condition, op: op as AssignmentOp, value: undefined })
          }
        >
          <SelectTrigger aria-label="Operator" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {opsFor(field).map((op) => (
              <SelectItem key={op} value={op}>
                {OP_LABELS[op]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={`Remove condition ${index + 1}`}
          onClick={onRemove}
        >
          <Trash2Icon />
        </Button>
      </div>
      {field && (
        <ValueEditor
          field={field}
          condition={condition}
          id={`condition-${index}`}
          onChange={(value) => onChange({ ...condition, value })}
        />
      )}
    </fieldset>
  );
}

export function RuleDialog({
  info,
  objects,
  rule,
  onClose,
}: {
  info: ObjectInfo;
  objects: readonly ObjectInfo[];
  rule: AssignmentRule | null;
  onClose: () => void;
}) {
  const users = useUsers();
  const [name, setName] = useState(rule?.name ?? "");
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [conditions, setConditions] = useState<AssignmentCondition[]>(rule?.conditions ?? []);
  const [method, setMethod] = useState<AssignmentRule["method"]>(rule?.method ?? "roundRobin");
  const [userIds, setUserIds] = useState<string[]>(rule?.userIds ?? []);
  const create = useOpMutation("assignment.create");
  const update = useOpMutation("assignment.update");
  const pending = create.isPending || update.isPending;

  function toggleUser(id: string, on: boolean) {
    setUserIds((ids) => (on ? [...ids, id] : ids.filter((u) => u !== id)));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const clean = conditions.filter((c) => c.field);
    const body = { name, enabled, conditions: clean, method, userIds };
    try {
      if (rule) await update.mutateAsync({ id: rule.id, ...body });
      else await create.mutateAsync({ object: info.name, ...body });
      toast.success("Rule saved");
      onClose();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{rule ? "Edit rule" : "New rule"}</DialogTitle>
            <DialogDescription>
              All conditions must hold. With none, the rule matches every record.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="rule-name">Name</Label>
            <Input
              id="rule-name"
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <Label className="flex items-center gap-2 font-normal">
            <Checkbox checked={enabled} onCheckedChange={(on) => setEnabled(on === true)} />
            On
          </Label>
          <div className="grid gap-2">
            <p className="text-sm font-medium">Conditions</p>
            {conditions.map((condition, i) => (
              <ConditionRow
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id, and are edited in place.
                key={i}
                info={info}
                objects={objects}
                condition={condition}
                index={i}
                onChange={(next) =>
                  setConditions((list) => list.map((c, at) => (at === i ? next : c)))
                }
                onRemove={() => setConditions((list) => list.filter((_, at) => at !== i))}
              />
            ))}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="justify-self-start"
              onClick={() => setConditions((list) => [...list, { field: "", op: "eq" }])}
            >
              Add condition
            </Button>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="rule-method">Assign to</Label>
            <Select
              value={method}
              onValueChange={(next) => {
                setMethod(next as AssignmentRule["method"]);
                if (next === "user") setUserIds((ids) => ids.slice(0, 1));
              }}
            >
              <SelectTrigger id="rule-method" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="roundRobin">Round-robin among users</SelectItem>
                <SelectItem value="user">One user</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {method === "user" ? (
            <Select value={userIds[0] ?? ""} onValueChange={(id) => setUserIds([id])}>
              <SelectTrigger aria-label="User" className="w-56">
                <SelectValue placeholder="Choose a user" />
              </SelectTrigger>
              <SelectContent>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <fieldset className="grid gap-1.5">
              <legend className="sr-only">Users to rotate through</legend>
              {users.map((u) => (
                <Label key={u.id} className="flex items-center gap-2 font-normal">
                  <Checkbox
                    checked={userIds.includes(u.id)}
                    onCheckedChange={(on) => toggleUser(u.id, on === true)}
                  />
                  {u.name}
                </Label>
              ))}
            </fieldset>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !userIds.length}>
              Save rule
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
