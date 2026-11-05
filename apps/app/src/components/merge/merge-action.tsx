// A record page's "Merge with…" action: a menu item for the page's actions menu, and the dialog
// it opens (rendered outside the menu, so it stays open when the menu closes).
//
//   const merge = useMergeAction("person", person.id);
//   <DropdownMenuContent>{merge.item}…</DropdownMenuContent>
//   {merge.dialog}
import { DropdownMenuItem } from "@relationship-os/ui/components/dropdown-menu";
import { MergeIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { MergeDialog } from "./merge-dialog.tsx";
import type { MergeObject } from "./merge-model.ts";

export function useMergeAction(
  object: MergeObject,
  id: string,
): { item: ReactNode; dialog: ReactNode } {
  const [open, setOpen] = useState(false);
  const ids = useMemo(() => [id], [id]);
  return {
    item: (
      <DropdownMenuItem onSelect={() => setOpen(true)}>
        <MergeIcon />
        Merge with…
      </DropdownMenuItem>
    ),
    dialog: <MergeDialog object={object} open={open} onOpenChange={setOpen} ids={ids} />,
  };
}
