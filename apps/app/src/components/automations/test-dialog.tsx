// "Test on a record…": pick a record of the trigger's object, then run test mode
// (automation.test) against it. Nothing is written; the report shows in the Test mode card.
// Schedule triggers have no record: the test runs straight away.
import type { AutomationTestReport } from "@crm/core";
import { Button } from "@crm/ui/components/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@crm/ui/components/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@crm/ui/components/dialog";
import { useQuery } from "@tanstack/react-query";
import { FlaskConicalIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useStageMutation } from "#/lib/automation-ops";
import { callOp } from "#/lib/operations";
import { errorMessage } from "#/lib/query";
import { useObjectInfo } from "#/lib/schema";
import type { AutomationDetailData } from "./hooks.ts";
import { asTestReport } from "./model.ts";

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** Records of any object whose title contains `query` (record.list). */
function useRecordSearch(object: string, titleField: string | null, query: string) {
  const q = useDebounced(query.trim(), 200);
  return useQuery({
    queryKey: ["op", "record.list", "automation-test-picker", object, q],
    queryFn: async () => {
      const page = await callOp("record.list", {
        object,
        limit: 10,
        fields: titleField ? [titleField] : [],
        ...(q && titleField ? { filter: { field: titleField, op: "contains", value: q } } : {}),
      });
      return page.items.map((r) => ({ id: r.id, title: r.title ?? r.id }));
    },
    enabled: Boolean(object),
    staleTime: 5_000,
  });
}

export function TestButton({
  detail,
  onReport,
}: {
  detail: AutomationDetailData;
  onReport: (report: AutomationTestReport) => void;
}) {
  const [open, setOpen] = useState(false);
  const test = useStageMutation("automation.test", { invalidates: ["automation."] });

  async function run(record?: { object: string; id: string }) {
    try {
      const result = await test.mutateAsync({ id: detail.id, ...(record ? { record } : {}) });
      const report = asTestReport(result.report);
      if (!report) throw new Error("The test returned no report");
      onReport(report);
      setOpen(false);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        data-name="test mode"
        disabled={test.isPending}
        onClick={() => (detail.triggerObject ? setOpen(true) : void run())}
      >
        <FlaskConicalIcon />
        {test.isPending && !open ? "Testing…" : "Test on a record…"}
      </Button>
      {detail.triggerObject && (
        <PickRecordDialog
          object={detail.triggerObject}
          open={open}
          onOpenChange={setOpen}
          pending={test.isPending}
          onPick={(id) => void run({ object: detail.triggerObject ?? "", id })}
        />
      )}
    </>
  );
}

function PickRecordDialog({
  object,
  open,
  onOpenChange,
  pending,
  onPick,
}: {
  object: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  onPick: (id: string) => void;
}) {
  const { object: info } = useObjectInfo(object);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<{ id: string; title: string } | null>(null);
  const results = useRecordSearch(object, info?.titleField ?? null, query);
  const noun = (info?.label ?? "record").toLowerCase();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setPicked(null);
          setQuery("");
        }
      }}
    >
      <DialogContent className="sm:max-w-md" data-testid="test-dialog">
        <DialogHeader>
          <DialogTitle>Test on a {noun}</DialogTitle>
          <DialogDescription>
            A dry run against real data: it shows what the automation would do and which approvals
            it would need. Nothing is written and nobody is notified.
          </DialogDescription>
        </DialogHeader>
        <Command shouldFilter={false} className="rounded-md border">
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={`Search ${(info?.plural ?? `${noun}s`).toLowerCase()}…`}
            aria-label={`Search for a ${noun}`}
            autoFocus
          />
          <CommandList className="max-h-60">
            {results.isFetching && !results.data?.length ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">Searching…</div>
            ) : (
              <CommandEmpty>No matches.</CommandEmpty>
            )}
            {(results.data ?? []).map((hit) => (
              <CommandItem
                key={hit.id}
                value={hit.id}
                onSelect={() => setPicked(hit)}
                data-checked={picked?.id === hit.id || undefined}
                className="data-[checked]:bg-accent"
              >
                <span className="truncate">{hit.title}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!picked || pending} onClick={() => picked && onPick(picked.id)}>
            {pending ? "Testing…" : picked ? `Test on “${picked.title}”` : "Pick a record"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
