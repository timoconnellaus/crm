// Create a record of an extension object: a form of its writable fields (field widgets), saved
// with record.create.
import { Button } from "@relationship-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@relationship-os/ui/components/dialog";
import { Label } from "@relationship-os/ui/components/label";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { errorMessage, useOpMutation } from "#/lib/query";
import type { ObjectInfo } from "#/lib/schema";
import { FieldEditor } from "./field-widgets.tsx";

export function CreateRecordDialog({
  object,
  open,
  onOpenChange,
  onCreated,
}: {
  object: ObjectInfo;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const fields = object.fields.filter((f) => f.extension === object.extension && !f.readOnly);
  // Declared defaults show in the form; a default an admin's setting chooses is left to the host.
  const initial = () =>
    Object.fromEntries(
      fields.flatMap((f) =>
        f.options?.default !== undefined && !f.options.defaultSetting
          ? [[f.name, f.options.default]]
          : [],
      ),
    );
  const [values, setValues] = useState<Record<string, unknown>>(initial);
  // An object that names untitled records (a lead) lets the title be left blank.
  const namedFrom = object.titleDefaultFrom
    .map((name) => object.fields.find((f) => f.name === name)?.label.toLowerCase() ?? name)
    .join(" or ");
  const create = useOpMutation("record.create", { invalidates: ["record."] });

  async function submit(event: FormEvent) {
    event.preventDefault();
    const filled = Object.fromEntries(
      Object.entries(values).filter(([, v]) => v !== null && v !== undefined),
    );
    try {
      const record = await create.mutateAsync({ object: object.name, values: filled });
      toast.success(`${object.label} created`);
      setValues(initial());
      onCreated(record.id);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New {object.label.toLowerCase()}</DialogTitle>
            {object.description && <DialogDescription>{object.description}</DialogDescription>}
          </DialogHeader>
          {fields.map((field) => (
            <div key={field.name} className="grid gap-1.5">
              <Label htmlFor={`new-${field.name}`}>
                {field.label}
                {field.required && !(namedFrom && field.name === object.titleField) && (
                  <span className="text-destructive"> *</span>
                )}
              </Label>
              <FieldEditor
                id={`new-${field.name}`}
                field={field}
                value={values[field.name] ?? null}
                onChange={(value) => setValues((v) => ({ ...v, [field.name]: value }))}
              />
              {namedFrom && field.name === object.titleField && (
                <p className="text-xs text-muted-foreground">
                  Leave blank to name it after the {namedFrom}.
                </p>
              )}
            </div>
          ))}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              Create {object.label.toLowerCase()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
