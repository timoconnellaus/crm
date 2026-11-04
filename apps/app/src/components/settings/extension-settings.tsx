// An extension's typed settings (ADR 0058), as declared in its manifest: a form of text, number,
// switch and select inputs, saved with extensionSettings.update (admins only).
import { Button } from "@crm/ui/components/button";
import { Checkbox } from "@crm/ui/components/checkbox";
import { Input } from "@crm/ui/components/input";
import { Label } from "@crm/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@crm/ui/components/select";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

type Value = string | number | boolean | null;

export function ExtensionSettingsForm({
  extension,
  canEdit,
}: {
  extension: string;
  canEdit: boolean;
}) {
  const query = useOp("extensionSettings.list", { extension });
  const save = useOpMutation("extensionSettings.update", { invalidates: ["extensionSettings."] });
  const [draft, setDraft] = useState<Record<string, Value>>({});
  const item = query.data?.items[0];
  if (!item || !Object.keys(item.settings).length) return null;
  const value = (name: string) => (name in draft ? draft[name] : item.values[name]) ?? null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await save.mutateAsync({ extension, values: draft });
      setDraft({});
      toast.success("Settings saved");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <form
      onSubmit={submit}
      className="grid gap-3 rounded-md border p-3"
      data-testid={`extension-settings-${extension}`}
    >
      <p className="text-sm font-medium">Settings</p>
      {Object.entries(item.settings).map(([name, setting]) => {
        const id = `setting-${extension}-${name}`;
        const v = value(name);
        return (
          <div key={name} className="grid gap-1">
            {setting.type === "boolean" ? (
              <Label className="flex items-center gap-2 font-normal">
                <Checkbox
                  id={id}
                  disabled={!canEdit}
                  checked={v === true}
                  onCheckedChange={(c) => setDraft((d) => ({ ...d, [name]: c === true }))}
                />
                {setting.label}
              </Label>
            ) : (
              <>
                <Label htmlFor={id}>{setting.label}</Label>
                {setting.type === "select" ? (
                  <Select
                    disabled={!canEdit}
                    value={typeof v === "string" ? v : undefined}
                    onValueChange={(next) => setDraft((d) => ({ ...d, [name]: next }))}
                  >
                    <SelectTrigger id={id} size="sm" className="w-56">
                      <SelectValue placeholder="Choose…" />
                    </SelectTrigger>
                    <SelectContent>
                      {(setting.options ?? []).map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id={id}
                    className="w-56"
                    disabled={!canEdit}
                    type={setting.type === "number" ? "number" : "text"}
                    min={setting.min ?? undefined}
                    max={setting.max ?? undefined}
                    value={v === null || v === undefined ? "" : String(v)}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        [name]:
                          e.target.value === ""
                            ? null
                            : setting.type === "number"
                              ? Number(e.target.value)
                              : e.target.value,
                      }))
                    }
                  />
                )}
              </>
            )}
            {setting.description && (
              <p className="text-xs text-muted-foreground">{setting.description}</p>
            )}
          </div>
        );
      })}
      {canEdit && (
        <Button
          type="submit"
          size="sm"
          className="justify-self-start"
          disabled={!Object.keys(draft).length || save.isPending}
        >
          Save settings
        </Button>
      )}
    </form>
  );
}
