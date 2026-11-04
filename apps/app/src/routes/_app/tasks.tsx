import { createFileRoute } from "@tanstack/react-router";
import { CheckSquareIcon } from "lucide-react";
import { ComingSoon } from "#/components/empty-state";

// TODO(stage-1-wire): "My tasks" grouped by due date (task.list) and quick-add (task.create).
export const Route = createFileRoute("/_app/tasks")({
  component: () => (
    <ComingSoon
      title="Tasks"
      icon={CheckSquareIcon}
      description="My tasks, grouped by due date, arrive with the task operations."
    />
  ),
});
