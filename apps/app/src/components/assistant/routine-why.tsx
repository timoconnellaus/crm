// The hover info dot beside a delivered message's time, and the inline why panel it opens (ADR 0343,
// the mockup's "Why you got this"): what you asked, when, the trigger, the checks that passed and
// the Jev check. Plain facts, no scores. The panel takes the person to the rest: pause, change.
import type { RoutineWhy } from "@relationship-os/core/client";
import { Button } from "@relationship-os/ui/components/button";
import { cn } from "@relationship-os/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { CheckIcon, InfoIcon, PauseIcon } from "lucide-react";
import { toast } from "sonner";
import { errorMessage, useOpMutation } from "#/lib/query";

export function WhyDot({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={cn(
        "rounded p-0.5 opacity-0 group-hover/msg:opacity-100 hover:text-foreground focus-visible:opacity-100 [@media(hover:none)]:opacity-100",
        open && "opacity-100",
      )}
      aria-label="Why did I get this?"
      aria-expanded={open}
      data-testid="routine-why-dot"
      onClick={onToggle}
    >
      <InfoIcon className="size-3.5" />
    </button>
  );
}

function day(at: string): string {
  return new Date(at).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

function Checks({ checks }: { checks: RoutineWhy["checks"] }) {
  return (
    <ul className="grid gap-0.5">
      {checks.map((check) => (
        <li key={check.text} className="flex min-w-0 items-start gap-1">
          <span className="min-w-0 break-words">{check.text}</span>
          <CheckIcon className="mt-0.5 size-3 shrink-0 text-emerald-600" aria-label="Passed" />
        </li>
      ))}
    </ul>
  );
}

export function WhyPanel({ why }: { why: RoutineWhy }) {
  const pause = useOpMutation("routine.pause", { invalidates: ["routine."] });
  return (
    <div
      className="mt-1.5 grid gap-2 rounded-md border bg-muted/40 p-2.5 text-xs leading-4"
      data-testid="routine-why"
    >
      <div className="font-medium">{why.test ? "A test you asked for" : "Why you got this"}</div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {why.asked ? (
          <>
            <dt className="text-muted-foreground">You asked</dt>
            <dd className="min-w-0 break-words">
              <span className="italic">"{why.asked}"</span>
              {why.askedAt && <span className="text-muted-foreground"> · {day(why.askedAt)}</span>}
            </dd>
          </>
        ) : (
          <>
            <dt className="text-muted-foreground">You asked</dt>
            <dd className="min-w-0 break-words">You turned on {why.name}</dd>
          </>
        )}
        <dt className="text-muted-foreground">When</dt>
        <dd className="min-w-0 break-words">{why.when}</dd>
        {why.about && (
          <>
            <dt className="text-muted-foreground">About</dt>
            <dd className="min-w-0 break-words">{why.about}</dd>
          </>
        )}
        {why.checks.length > 0 && (
          <>
            <dt className="text-muted-foreground">Checked first</dt>
            <dd className="min-w-0">
              <Checks checks={why.checks} />
            </dd>
          </>
        )}
        {why.jev.length > 0 && (
          <>
            <dt className="text-muted-foreground">Jev check</dt>
            <dd className="min-w-0">
              <Checks checks={why.jev} />
            </dd>
          </>
        )}
      </dl>
      <div className="flex flex-wrap gap-1">
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            pause.mutate(
              { id: why.routineId, resume: false },
              {
                onSuccess: () => toast.success(`Paused ${why.name}`),
                onError: (error) => toast.error(errorMessage(error)),
              },
            )
          }
        >
          <PauseIcon />
          Pause
        </Button>
        <Button size="xs" variant="ghost" asChild>
          <Link to="/settings/assistant-routines">Change it</Link>
        </Button>
      </div>
    </div>
  );
}
