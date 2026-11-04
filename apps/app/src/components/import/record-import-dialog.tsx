// CSV import for extension objects (deals, …): pick a file, check the column → field mapping and
// the rows with problems (import.records.preview), then import in chunks of 100
// (import.records.commit), each record created like record.create so stage rules apply.
import { Button } from "@crm/ui/components/button";
import { Checkbox } from "@crm/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@crm/ui/components/dialog";
import { Input } from "@crm/ui/components/input";
import { Label } from "@crm/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@crm/ui/components/select";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { callOp } from "#/lib/operations";
import { errorMessage, invalidateAfterWrite } from "#/lib/query";
import type { ObjectInfo } from "#/lib/schema";

type Preview = Awaited<ReturnType<typeof callOp<"import.records.preview">>>;

const IGNORE = "__ignore__";

export function RecordImportDialog({
  object,
  open,
  onOpenChange,
}: {
  object: ObjectInfo;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const client = useQueryClient();
  const [csv, setCsv] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [skipInvalid, setSkipInvalid] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const plural = (object.plural ?? object.label).toLowerCase();

  function reset() {
    setCsv(null);
    setPreview(null);
    setMapping({});
    setProgress(null);
  }

  async function runPreview(text: string, map?: Record<string, string | null>) {
    setBusy(true);
    try {
      const result = await callOp("import.records.preview", {
        object: object.name,
        csv: text,
        ...(map ? { mapping: map } : {}),
      });
      setPreview(result);
      setMapping(result.mapping);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    const text = await file.text();
    setCsv(text);
    await runPreview(text);
  }

  async function onImport() {
    if (!csv || !preview) return;
    setBusy(true);
    let created = 0;
    let skipped = 0;
    try {
      let start: number | null = 0;
      while (start !== null) {
        setProgress(`Imported ${created} of ${preview.total}…`);
        const result: Awaited<ReturnType<typeof callOp<"import.records.commit">>> = await callOp(
          "import.records.commit",
          { object: object.name, csv, mapping, start, count: 100, skipInvalid },
        );
        created += result.created.length;
        skipped += result.skipped.length;
        start = result.next;
      }
      await invalidateAfterWrite(client, "import.records.commit", ["record."]);
      toast.success(
        `Imported ${created} ${plural}${skipped ? `, skipped ${skipped} with problems` : ""}`,
      );
      reset();
      onOpenChange(false);
    } catch (error) {
      toast.error(`${created ? `Imported ${created}, then: ` : ""}${errorMessage(error)}`);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const problems = preview?.rows.filter((r) => r.errors.length) ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import {plural}</DialogTitle>
          <DialogDescription>
            A CSV with a header row. Columns match fields by name or label; relation columns can
            hold names (an organisation's name, a pipeline's name) or ids.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="record-import-file">CSV file</Label>
          <Input
            id="record-import-file"
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
        </div>
        {preview && (
          <div className="grid gap-4" data-testid="record-import-preview">
            <div className="grid gap-2">
              <h3 className="text-sm font-medium">Columns</h3>
              {preview.headers.map((header) => (
                <div key={header} className="grid grid-cols-2 items-center gap-2 text-sm">
                  <span className="truncate">{header}</span>
                  <Select
                    value={mapping[header] ?? IGNORE}
                    onValueChange={(value) => {
                      const next = { ...mapping, [header]: value === IGNORE ? null : value };
                      setMapping(next);
                      if (csv) void runPreview(csv, next);
                    }}
                  >
                    <SelectTrigger aria-label={`Field for ${header}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={IGNORE}>Don't import</SelectItem>
                      {preview.fields.map((field) => (
                        <SelectItem key={field.name} value={field.name}>
                          {field.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
            <p className="text-sm">
              {preview.total} row{preview.total === 1 ? "" : "s"}
              {preview.invalid ? `, ${preview.invalid} with problems` : ", no problems found"}.
              Stage rules are checked as each record is created.
            </p>
            {problems.length > 0 && (
              <ul className="grid gap-1 text-sm text-destructive">
                {problems.slice(0, 10).map((row) => (
                  <li key={row.row}>
                    Row {row.row}: {row.errors.join("; ")}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-center gap-2">
              <Checkbox
                id="record-import-skip"
                checked={skipInvalid}
                onCheckedChange={(v) => setSkipInvalid(v === true)}
              />
              <Label htmlFor="record-import-skip">Skip rows with problems</Label>
            </div>
          </div>
        )}
        <DialogFooter>
          {progress && <span className="mr-auto text-sm text-muted-foreground">{progress}</span>}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void onImport()} disabled={!preview || busy || !preview.total}>
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
