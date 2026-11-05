// Empty and error states: an icon, a title, a line of text and an optional action. Every list and
// panel uses these, so "nothing here" and "could not load" look the same everywhere.
import { Button } from "@relationship-os/ui/components/button";
import { cn } from "@relationship-os/ui/lib/utils";
import { CircleAlertIcon, type LucideIcon, RotateCwIcon } from "lucide-react";
import type { ReactNode } from "react";
import { errorMessage } from "#/lib/query";

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-12 text-center",
        className,
      )}
      data-testid="empty-state"
    >
      {Icon && (
        <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-muted">
          <Icon className="size-5 text-muted-foreground" aria-hidden />
        </div>
      )}
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export interface ErrorStateProps {
  title: string;
  error: unknown;
  /** Shows a "Try again" button. */
  onRetry?: () => void;
  className?: string;
}

/** A load failure: what failed, the error, and "Try again". Announced to screen readers. */
export function ErrorState({ title, error, onRetry, className }: ErrorStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-6 py-10 text-center",
        className,
      )}
      role="alert"
      data-testid="error-state"
    >
      <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-destructive/10">
        <CircleAlertIcon className="size-5 text-destructive" aria-hidden />
      </div>
      <p className="font-medium">{title}</p>
      <p className="max-w-sm text-sm text-muted-foreground">{errorMessage(error)}</p>
      {onRetry && (
        <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
          <RotateCwIcon />
          Try again
        </Button>
      )}
    </div>
  );
}
