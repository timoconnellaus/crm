// "← Settings" link at the top of each settings page.
import { Link } from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";

export function BackToSettings() {
  return (
    <Link
      to="/settings"
      className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ChevronLeftIcon className="size-4" />
      Settings
    </Link>
  );
}
