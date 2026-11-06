// Admin-editable select options of an extension's fields (ADR 0246): add, relabel, reorder and
// remove options (a lead's status and source). Options the extension relies on stay; records
// holding a removed option keep their value. Saved with fieldOptions.update.
import { Button } from "@relationship-os/ui/components/button";
import { Input } from "@relationship-os/ui/components/input";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

type FieldOptionsOutput = Awaited<
  ReturnType<typeof import("#/lib/operations").callOp<"fieldOptions.list">>
>;
type EditableField = FieldOptionsOutput["items"][number];
type Option = EditableField["options"][number];

const slug = (label: string) =>
  label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

function FieldOptions({ field, canEdit }: { field: EditableField; canEdit: boolean }) {
  const save = useOpMutation("fieldOptions.update", { invalidates: ["schema.", "record."] });
  const [draft, setDraft] = useState<Option[] | null>(null);
  const [added, setAdded] = useState("");
  const options = draft ?? field.options;

  function move(index: number, by: -1 | 1) {
    const next = [...options];
    const [option] = next.splice(index, 1);
    if (!option) return;
    next.splice(index + by, 0, option);
    setDraft(next);
  }

  function add() {
    const value = slug(added);
    if (!value || options.some((o) => o.value === value)) return;
    setDraft([...options, { value, label: added.trim(), fixed: false }]);
    setAdded("");
  }

  async function submit(reset: boolean) {
    try {
      await save.mutateAsync({
        object: field.object,
        field: field.field,
        options: reset
          ? null
          : options.map(({ value, label, color }) => ({
              value,
              label,
              ...(color ? { color } : {}),
            })),
      });
      setDraft(null);
      toast.success(`${field.label} options saved`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <div className="grid gap-2" data-testid={`field-options-${field.field}`}>
      <p className="text-sm font-medium">
        {field.objectLabel} {field.label.toLowerCase()} options
      </p>
      {options.map((option, index) => (
        <div key={option.value} className="flex items-center gap-1">
          <Input
            aria-label={`${option.value} label`}
            className="w-56"
            disabled={!canEdit}
            value={option.label}
            onChange={(e) =>
              setDraft(
                options.map((o) =>
                  o.value === option.value ? { ...o, label: e.target.value } : o,
                ),
              )
            }
          />
          {canEdit && (
            <>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Move ${option.label} up`}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUpIcon />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Move ${option.label} down`}
                disabled={index === options.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDownIcon />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Remove ${option.label}`}
                disabled={option.fixed}
                title={option.fixed ? "The extension relies on this option" : undefined}
                onClick={() => setDraft(options.filter((o) => o.value !== option.value))}
              >
                <Trash2Icon />
              </Button>
            </>
          )}
        </div>
      ))}
      {canEdit && (
        <>
          <div className="flex items-center gap-1">
            <Input
              aria-label={`New ${field.label.toLowerCase()} option`}
              className="w-56"
              placeholder="New option"
              value={added}
              onChange={(e) => setAdded(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
            />
            <Button type="button" size="icon" variant="ghost" aria-label="Add option" onClick={add}>
              <PlusIcon />
            </Button>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!draft || save.isPending}
              onClick={() => void submit(false)}
            >
              Save options
            </Button>
            {field.edited && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={save.isPending}
                onClick={() => void submit(true)}
              >
                Reset to defaults
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** The editable select fields of an extension, if it has any. */
export function FieldOptionsEditor({
  extension,
  canEdit,
}: {
  extension: string;
  canEdit: boolean;
}) {
  const query = useOp("fieldOptions.list", {});
  const fields = (query.data?.items ?? []).filter((f) => f.extension === extension);
  if (!fields.length) return null;
  return (
    <div className="grid gap-4 rounded-md border p-3">
      {fields.map((field) => (
        <FieldOptions key={`${field.object}.${field.field}`} field={field} canEdit={canEdit} />
      ))}
    </div>
  );
}
