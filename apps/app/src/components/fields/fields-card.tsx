// Cards that show and edit extension fields with the field widgets: one card of fields with an
// Edit mode (saved through record.update), the details cards of extension records, and the
// "extension fields on a core record" cards, one per extension.
import { Button } from "@crm/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@crm/ui/components/card";
import { Label } from "@crm/ui/components/label";
import { Skeleton } from "@crm/ui/components/skeleton";
import { PencilIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";
import { type FieldInfo, fieldsByExtension, useObjectInfo } from "#/lib/schema";
import { FieldDisplay, FieldEditor } from "./field-widgets.tsx";

export interface FieldsCardProps {
  title: string;
  object: string;
  id: string;
  fields: FieldInfo[];
  values: Record<string, unknown>;
  readOnly?: boolean;
  testId?: string;
}

/** A card of fields with an Edit mode that saves changed values with record.update. */
export function FieldsCard({
  title,
  object,
  id,
  fields,
  values,
  readOnly,
  testId,
}: FieldsCardProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const update = useOpMutation("record.update", { invalidates: ["record.", "schema."] });
  const editable = fields.filter((f) => !f.readOnly);

  function start() {
    setDraft(Object.fromEntries(editable.map((f) => [f.name, values[f.name] ?? null])));
    setEditing(true);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const changed = Object.fromEntries(
      Object.entries(draft).filter(
        ([k, v]) => JSON.stringify(v) !== JSON.stringify(values[k] ?? null),
      ),
    );
    if (Object.keys(changed).length) {
      try {
        await update.mutateAsync({ object, id, values: changed });
        toast.success("Saved");
      } catch (error) {
        toast.error(errorMessage(error));
        return;
      }
    }
    setEditing(false);
  }

  return (
    <Card data-testid={testId}>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">{title}</CardTitle>
        {!readOnly && !editing && editable.length > 0 && (
          <Button variant="ghost" size="sm" onClick={start} aria-label={`Edit ${title}`}>
            <PencilIcon />
            Edit
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {editing ? (
          <form className="grid gap-3" onSubmit={save}>
            {fields.map((field) => (
              <div key={field.name} className="grid gap-1.5">
                <Label htmlFor={`f-${field.name}`}>{field.label}</Label>
                <FieldEditor
                  id={`f-${field.name}`}
                  field={field}
                  value={field.readOnly ? values[field.name] : draft[field.name]}
                  onChange={(value) => setDraft((d) => ({ ...d, [field.name]: value }))}
                />
              </div>
            ))}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={update.isPending}>
                Save
              </Button>
            </div>
          </form>
        ) : (
          <dl className="grid gap-2 text-sm">
            {fields.map((field) => (
              <div key={field.name} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2">
                <dt className="text-muted-foreground">{field.label}</dt>
                <dd className="min-w-0 truncate" data-field={field.name}>
                  <FieldDisplay field={field} value={values[field.name]} />
                </dd>
              </div>
            ))}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Extension fields on a core record (person, organisation), one card per extension, in the
 * record page's side panel. Renders nothing when no extension adds fields to the object.
 */
export function ExtensionFieldsCards({
  object,
  id,
  readOnly,
}: {
  object: "person" | "organisation";
  id: string;
  readOnly?: boolean;
}) {
  const { object: info } = useObjectInfo(object);
  const groups = info ? fieldsByExtension(info) : [];
  const record = useOp("record.get", { object, id }, { enabled: groups.length > 0 });
  if (!groups.length) return null;
  if (record.isPending) return <Skeleton className="h-24 w-full" />;
  if (record.error) return null;
  return (
    <>
      {groups.map(([extension, fields]) => (
        <FieldsCard
          key={extension}
          title={extensionLabel(extension)}
          object={object}
          id={id}
          fields={fields}
          values={record.data?.values ?? {}}
          readOnly={readOnly}
          testId={`extension-fields-${extension}`}
        />
      ))}
    </>
  );
}

function extensionLabel(id: string): string {
  return `${id.charAt(0).toUpperCase()}${id.slice(1)}`;
}
