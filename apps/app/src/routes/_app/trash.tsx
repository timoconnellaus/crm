import { createFileRoute } from "@tanstack/react-router";
import { Trash2Icon } from "lucide-react";
import { ComingSoon } from "#/components/empty-state";

// TODO(stage-1-wire): Trash list (trash.list) with restore (<object>.restore) per row.
export const Route = createFileRoute("/_app/trash")({
  component: () => (
    <ComingSoon
      title="Trash"
      icon={Trash2Icon}
      description="Deleted records stay restorable for 30 days. The Trash list arrives with the trash operations; until then, restore a person from their record page."
    />
  ),
});
