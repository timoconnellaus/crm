// Forms and input. A form's values go to one operation, so it is a change set where review applies;
// a choice answers the assistant as the person's message.
import type { FormField, FormSubmit } from "@relationship-os/agent-a2ui";
import {
  type RendererProps,
  submitAction,
  useA2uiAction,
  useA2uiRunner,
} from "@relationship-os/agent-a2ui/react";
import { Button } from "@relationship-os/ui/components/button";
import { Checkbox } from "@relationship-os/ui/components/checkbox";
import { Input } from "@relationship-os/ui/components/input";
import { Label } from "@relationship-os/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@relationship-os/ui/components/select";
import { Textarea } from "@relationship-os/ui/components/textarea";
import { cn } from "@relationship-os/ui/lib/utils";
import { UploadIcon } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { UserEditor } from "#/components/fields/field-widgets";
import { RecordPicker } from "#/components/record-picker";
import { ActionButton, Body, CardLink, Footer, Frame, Header } from "./parts.tsx";

type Value = string | number | boolean | null;
type Values = Record<string, Value>;

export interface FormState {
  values: Values;
  set(name: string, value: Value): void;
  /** Every required field has a value. */
  complete: boolean;
}

const filled = (value: Value | undefined) => value !== null && value !== undefined && value !== "";

export function useFormValues(fields: readonly FormField[]): FormState {
  const [values, setValues] = useState<Values>(() =>
    Object.fromEntries(fields.map((f) => [f.name, f.value ?? null])),
  );
  return useMemo(
    () => ({
      values,
      set: (name, value) => setValues((current) => ({ ...current, [name]: value })),
      complete: fields.every((f) => !f.required || filled(values[f.name])),
    }),
    [fields, values],
  );
}

/** What is sent: filled fields, with numbers as numbers. */
export function formValues(fields: readonly FormField[], values: Values): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.name];
    if (!filled(value)) continue;
    out[field.name] =
      field.kind === "number" || field.kind === "money" ? Number(value) : (value as Value);
  }
  return out;
}

function Control({ field, form, id }: { field: FormField; form: FormState; id: string }) {
  const value = form.values[field.name] ?? null;
  const set = (next: Value) => form.set(field.name, next);
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  const common = { id, required: field.required, placeholder: field.placeholder };
  switch (field.kind) {
    case "textarea":
      return (
        <Textarea
          {...common}
          className="min-h-16 text-[13px]"
          value={text}
          onChange={(e) => set(e.target.value)}
        />
      );
    case "number":
    case "money":
      return (
        <Input
          {...common}
          className="h-8"
          type="number"
          inputMode="decimal"
          value={text}
          onChange={(e) => set(e.target.value)}
        />
      );
    case "date":
      return (
        <Input
          {...common}
          className="h-8"
          type="date"
          value={text.slice(0, 10)}
          onChange={(e) => set(e.target.value)}
        />
      );
    case "select":
      return (
        <Select value={text} onValueChange={set}>
          <SelectTrigger id={id} size="sm" className="w-full min-w-0">
            <SelectValue placeholder={field.placeholder ?? "Choose"} />
          </SelectTrigger>
          <SelectContent>
            {field.options?.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case "user":
      return <UserEditor id={id} value={value} onChange={(next) => set(next as Value)} />;
    case "record":
      if (field.object === "person" || field.object === "organisation") {
        return (
          <RecordPicker
            id={id}
            object={field.object}
            label={field.label}
            placeholder={field.placeholder ?? `Choose ${field.label.toLowerCase()}`}
            value={value ? { id: String(value), name: field.valueLabel ?? String(value) } : null}
            onChange={(picked) => set(picked?.id ?? null)}
          />
        );
      }
      return (
        <Input {...common} className="h-8" readOnly value={field.valueLabel ?? text} />
      );
    case "checkbox":
      return (
        <Checkbox id={id} checked={value === true} onCheckedChange={(next) => set(next === true)} />
      );
    default:
      return (
        <Input {...common} className="h-8" value={text} onChange={(e) => set(e.target.value)} />
      );
  }
}

export function Fields({ fields, form }: { fields: readonly FormField[]; form: FormState }) {
  const base = useId();
  return (
    <div className="grid min-w-0 gap-3">
      {fields.map((field) => {
        const id = `${base}-${field.name}`;
        return (
          <div
            key={field.name}
            className={cn(
              "grid min-w-0 gap-1",
              field.kind === "checkbox" && "flex flex-row-reverse items-center justify-end gap-2",
            )}
          >
            <Label htmlFor={id} className="text-xs">
              {field.label}
              {field.required && <span className="text-destructive"> *</span>}
            </Label>
            <Control field={field} form={form} id={id} />
            {field.help && <p className="text-xs text-muted-foreground">{field.help}</p>}
          </div>
        );
      })}
    </div>
  );
}

function FormCard({
  type,
  title,
  text,
  fields,
  submit,
}: {
  type: string;
  title: string;
  text?: string | undefined;
  fields: readonly FormField[];
  submit: FormSubmit;
}) {
  const form = useFormValues(fields);
  const action = useA2uiAction(useMemo(() => submitAction(submit), [submit]));
  const done = action.status === "done";
  return (
    <Frame type={type}>
      <Header title={title} subtitle={text} />
      <Body>
        <Fields fields={fields} form={form} />
      </Body>
      <Footer>
        <Button
          size="xs"
          className="max-md:h-8"
          disabled={action.status === "busy" || done || !form.complete}
          onClick={() => void action.run(formValues(fields, form.values))}
        >
          {submit.label}
        </Button>
        {action.message && (
          <span
            role="status"
            className={cn(
              "text-xs",
              action.status === "failed" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {action.message}
          </span>
        )}
      </Footer>
    </Frame>
  );
}

export function RecordFormComponent({ props }: RendererProps<"recordForm">) {
  return (
    <FormCard type="recordForm" title={props.title} fields={props.fields} submit={props.submit} />
  );
}

export function FormComponent({ props }: RendererProps<"form">) {
  return (
    <FormCard
      type="form"
      title={props.title}
      text={props.text}
      fields={props.fields}
      submit={props.submit}
    />
  );
}

export function ChoiceComponent({ props }: RendererProps<"choice">) {
  const run = useA2uiRunner();
  const [picked, setPicked] = useState<string[]>([]);
  const [sent, setSent] = useState(false);
  const answer = (option: { label: string; reply?: string | undefined }) =>
    option.reply ?? option.label;

  function send(text: string) {
    setSent(true);
    void run({ kind: "reply", label: "Answer", text });
  }

  return (
    <Frame type="choice" className="grid gap-2 px-3 py-2.5">
      {props.question && <p>{props.question}</p>}
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={props.question ?? "Choices"}>
        {props.options.map((option) => {
          const on = picked.includes(option.label);
          return (
            <button
              key={option.label}
              type="button"
              disabled={sent}
              aria-pressed={props.multiple ? on : undefined}
              className={cn(
                "max-w-full truncate rounded-full border px-3 py-1 text-[13px] hover:bg-accent disabled:opacity-60",
                on && "border-primary bg-primary text-primary-foreground hover:bg-primary",
              )}
              onClick={() => {
                if (!props.multiple) {
                  setPicked([option.label]);
                  send(answer(option));
                  return;
                }
                setPicked((current) =>
                  on ? current.filter((l) => l !== option.label) : [...current, option.label],
                );
              }}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {props.multiple && !sent && (
        <div>
          <Button
            size="xs"
            className="max-md:h-8"
            disabled={!picked.length}
            onClick={() =>
              send(
                props.options
                  .filter((o) => picked.includes(o.label))
                  .map(answer)
                  .join(", "),
              )
            }
          >
            Send
          </Button>
        </div>
      )}
    </Frame>
  );
}

export function ConfirmComponent({ props }: RendererProps<"confirm">) {
  const [cancelled, setCancelled] = useState(false);
  if (cancelled) {
    return (
      <Frame type="confirm" className="px-3 py-2.5 text-muted-foreground">
        Cancelled.
      </Frame>
    );
  }
  return (
    <Frame type="confirm" tone="blocked">
      <Header title={props.title} />
      <Body>
        <ul className="grid list-disc gap-0.5 pl-4 text-[13px]">
          {props.consequences.map((line) => (
            <li key={line} className="break-words">
              {line}
            </li>
          ))}
        </ul>
      </Body>
      <Footer>
        <ActionButton action={props.confirm} />
        <Button
          size="xs"
          variant="ghost"
          className="max-md:h-8"
          onClick={() => setCancelled(true)}
        >
          {props.cancelLabel}
        </Button>
      </Footer>
    </Frame>
  );
}

export function FileUploadComponent({ props }: RendererProps<"fileUpload">) {
  return (
    <Frame type="fileUpload">
      <Header title={props.title} subtitle={props.record?.label} />
      <Footer>
        <Button size="xs" variant="outline" className="max-md:h-8" asChild>
          <CardLink href={props.href}>
            <UploadIcon />
            Choose a file
          </CardLink>
        </Button>
        {props.accept && <span className="text-xs text-muted-foreground">{props.accept}</span>}
      </Footer>
    </Frame>
  );
}
