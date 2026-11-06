// "Assign by rules" in a list's bulk actions (ADR 0246): re-runs the assignment rules on the
// selected records with assignment.apply, 200 per call.
import { Button } from "@relationship-os/ui/components/button";
import { useQueryClient } from "@tanstack/react-query";
import { UserCheckIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { callOp } from "#/lib/operations";
import { errorMessage, invalidateAfterWrite } from "#/lib/query";

const APPLY_BATCH = 200;

export function AssignByRules({
  object,
  ids,
  onDone,
}: {
  object: string;
  ids: string[];
  onDone: () => void;
}) {
  const client = useQueryClient();
  const [pending, setPending] = useState(false);

  async function run() {
    setPending(true);
    try {
      let changed = 0;
      for (let i = 0; i < ids.length; i += APPLY_BATCH) {
        const result = await callOp("assignment.apply", {
          object,
          ids: ids.slice(i, i + APPLY_BATCH),
        });
        changed += result.items.filter((item) => item.changed).length;
      }
      await invalidateAfterWrite(client, "record.", ["person.", "organisation."]);
      toast.success(changed === 1 ? "1 record reassigned" : `${changed} records reassigned`);
      onDone();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <Button variant="outline" size="sm" disabled={pending} onClick={() => void run()}>
      <UserCheckIcon />
      Assign by rules
    </Button>
  );
}
