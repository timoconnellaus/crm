// Shown on the automation pages while the admin kill switch is engaged: no automation runs.
import { Button } from "@crm/ui/components/button";
import { Link } from "@tanstack/react-router";
import { OctagonXIcon } from "lucide-react";

export function KillSwitchBanner({ isAdmin }: { isAdmin: boolean }) {
  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm"
      role="status"
      data-testid="kill-switch-banner"
    >
      <OctagonXIcon className="size-4 shrink-0 text-destructive" aria-hidden />
      <span className="min-w-0 flex-1">
        The kill switch is on: every automation is paused and running ones have stopped.
      </span>
      {isAdmin && (
        <Button asChild size="sm" variant="outline">
          <Link to="/settings/automations">Kill switch settings</Link>
        </Button>
      )}
    </div>
  );
}
