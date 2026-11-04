import { createFileRoute } from "@tanstack/react-router";
import { ActivityIcon } from "lucide-react";
import { ComingSoon } from "#/components/empty-state";

// TODO(stage-1-wire): the activity feed across records (activity.list) with the Timeline component.
export const Route = createFileRoute("/_app/activity")({
  component: () => (
    <ComingSoon
      title="Activity"
      icon={ActivityIcon}
      description="The activity feed across all records arrives with the activity operations."
    />
  ),
});
