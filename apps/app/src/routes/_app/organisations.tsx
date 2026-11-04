import { createFileRoute } from "@tanstack/react-router";
import { Building2Icon } from "lucide-react";
import { ComingSoon } from "#/components/empty-state";

// TODO(stage-1-wire): organisation list (DataTable over organisation.list) and record page.
export const Route = createFileRoute("/_app/organisations")({
  component: () => (
    <ComingSoon
      title="Organisations"
      icon={Building2Icon}
      description="Organisation lists and records arrive with the organisation operations."
    />
  ),
});
