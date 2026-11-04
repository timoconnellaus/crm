// A record page's "Enrich now" (ZoomInfo, stage 6a): a menu item for the page's actions menu,
// shown only while an active ZoomInfo connection is usable, and the confirm dialog it opens
// (rendered outside the menu). Enriching spends ZoomInfo credits, so it always asks first; a
// person's click applies it, and empty fields on the record are filled from the result.
//
//   const enrich = useEnrichAction("person", person.id);
//   <DropdownMenuContent>{enrich.item}…</DropdownMenuContent>
//   {enrich.dialog}
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@crm/ui/components/alert-dialog";
import { DropdownMenuItem } from "@crm/ui/components/dropdown-menu";
import { SparklesIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

export function useEnrichAction(
  object: "person" | "organisation",
  id: string,
): { item: ReactNode; dialog: ReactNode } {
  const [open, setOpen] = useState(false);
  const connections = useOp(
    "connection.list",
    { scope: "usable", includeDisconnected: false },
    { staleTime: 60_000 },
  );
  const enrich = useOpMutation("enrichment.enrichNow", {
    invalidates: ["person.", "organisation.", "approval."],
  });
  const available =
    connections.data?.items.some((c) => c.vendor === "zoominfo" && c.status === "active") ?? false;
  if (!available) return { item: null, dialog: null };

  async function run() {
    try {
      const out = await enrich.mutateAsync({ object, id });
      setOpen(false);
      if (out.status === "applied") toast.success(out.message);
      else if (out.status === "pending") toast.info(out.message);
      else toast.warning(out.message);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const noun = object === "person" ? "person" : "organisation";
  return {
    item: (
      <DropdownMenuItem onSelect={() => setOpen(true)}>
        <SparklesIcon />
        Enrich now
      </DropdownMenuItem>
    ),
    dialog: (
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enrich this {noun} from ZoomInfo?</AlertDialogTitle>
            <AlertDialogDescription>
              Uses ZoomInfo credits. Empty fields are filled from the result; values already on the
              record are never overwritten.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void run();
              }}
              disabled={enrich.isPending}
            >
              {enrich.isPending ? "Enriching…" : "Enrich now"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    ),
  };
}
