// Extension tools shown as buttons on a record page (ADR 0246, `recordAction`): Convert to deal
// and Disqualify on a lead. A button may ask for a confirmation or one choice first. When the tool
// answers with `open: { object, id }`, the app goes to that record.
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@relationship-os/ui/components/alert-dialog";
import { Button } from "@relationship-os/ui/components/button";
import { Label } from "@relationship-os/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@relationship-os/ui/components/select";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { OperationCallError } from "#/lib/operations";
import { errorMessage, invalidateAfterWrite, useOp } from "#/lib/query";
import { recordHref } from "#/lib/schema";
import { callOperation } from "#/server/call-operation";

type RecordViews = Awaited<
  ReturnType<typeof import("#/lib/operations").callOp<"view.recordViews">>
>;
type RecordAction = RecordViews["actions"][number];

function ActionButton({ action, id }: { action: RecordAction; id: string }) {
  const client = useQueryClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<string | undefined>();
  const [running, setRunning] = useState(false);
  const asks = Boolean(action.confirm || action.ask);

  async function run() {
    setRunning(true);
    try {
      const input = {
        [action.idInput]: id,
        ...(action.ask && choice ? { [action.ask.input]: choice } : {}),
      };
      const result = await callOperation({ data: { name: action.operation, input } });
      if (!result.ok) throw new OperationCallError(result.error);
      await invalidateAfterWrite(client, "record.", ["view."]);
      setOpen(false);
      toast.success(`${action.label}: done`);
      const next = (result.data as { open?: { object: string; id: string } | null } | null)?.open;
      if (next) void router.navigate({ href: recordHref(next.object, next.id) });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <Button
        variant="outline"
        disabled={running}
        onClick={() => (asks ? setOpen(true) : void run())}
      >
        {action.label}
      </Button>
      {asks && (
        <AlertDialog open={open} onOpenChange={setOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{action.label}</AlertDialogTitle>
              {action.confirm && <AlertDialogDescription>{action.confirm}</AlertDialogDescription>}
            </AlertDialogHeader>
            {action.ask && (
              <div className="grid gap-1.5">
                <Label htmlFor={`action-${action.id}`}>{action.ask.label}</Label>
                <Select value={choice ?? ""} onValueChange={setChoice}>
                  <SelectTrigger id={`action-${action.id}`} className="w-full">
                    <SelectValue placeholder="Choose…" />
                  </SelectTrigger>
                  <SelectContent>
                    {action.ask.options.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={running || Boolean(action.ask && !choice)}
                onClick={(event) => {
                  event.preventDefault();
                  void run();
                }}
              >
                {action.label}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}

/** One button per record action of the object, minus those its `hideWhen` hides right now. */
export function RecordActionButtons({
  object,
  id,
  values,
}: {
  object: string;
  id: string;
  values: Record<string, unknown>;
}) {
  const views = useOp("view.recordViews", { object }, { staleTime: 60_000 });
  const actions = (views.data?.actions ?? []).filter(
    (a) => !a.hideWhen?.values.includes(String(values[a.hideWhen.field])),
  );
  return (
    <>
      {actions.map((action) => (
        <ActionButton key={action.id} action={action} id={id} />
      ))}
    </>
  );
}
