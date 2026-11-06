// Duplicate warnings on the create forms (stage 16, ADR 0247): duplicate.check runs as fields
// are filled, and the form shows what an existing record has in common, with "Open". Nothing
// blocks except the existing uniqueness (an email or a domain that belongs to someone else); the
// form's button reads "Create anyway" while a warning shows.
import type { CoreInput, CoreOutput } from "@relationship-os/core";
import { keepPreviousData } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CircleAlertIcon, CopyIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useOp } from "#/lib/query";

type CheckInput = CoreInput<"duplicate.check">;
export type DuplicateCheck = CoreOutput<"duplicate.check">;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

function hasValues(input: CheckInput): boolean {
  return Object.values(input.values).some((v) =>
    Array.isArray(v) ? v.some((x) => String(x).trim()) : typeof v === "string" && v.trim() !== "",
  );
}

/** duplicate.check for the form's current values, debounced; empty until something is typed. */
export function useDuplicateCheck(input: CheckInput, enabled = true) {
  const key = JSON.stringify(input);
  const debounced = useDebounced(key, 300);
  const parsed = JSON.parse(debounced) as CheckInput;
  const query = useOp("duplicate.check", parsed, {
    enabled: enabled && hasValues(parsed),
    placeholderData: keepPreviousData,
    staleTime: 5_000,
  });
  const empty: DuplicateCheck = { conflicts: [], warnings: [] };
  return enabled && hasValues(parsed) ? (query.data ?? empty) : empty;
}

export function DuplicateWarnings({
  object,
  check,
  onOpen,
}: {
  object: "person" | "organisation";
  check: DuplicateCheck;
  /** Called when "Open" is followed (e.g. to close the dialog). */
  onOpen?: () => void;
}) {
  if (!check.conflicts.length && !check.warnings.length) return null;
  const to = object === "person" ? ("/people/$id" as const) : ("/organisations/$id" as const);
  return (
    <div className="grid gap-2" aria-live="polite">
      {check.conflicts.map((c) => (
        <div
          key={`c-${c.id}`}
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm"
        >
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          <p className="flex-1">{c.reasons.join(". ")}.</p>
          <Link
            to={to}
            params={{ id: c.id }}
            onClick={onOpen}
            className="font-medium underline-offset-4 hover:underline"
          >
            Open
          </Link>
        </div>
      ))}
      {check.warnings.length > 0 && (
        <section
          aria-label="Possible duplicates"
          className="grid gap-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-sm"
        >
          <p className="flex items-center gap-2 font-medium">
            <CopyIcon className="size-4 shrink-0 text-amber-600" />
            {check.warnings.length === 1 ? "This may already exist" : "These may already exist"}
          </p>
          <ul className="grid gap-1">
            {check.warnings.map((w) => (
              <li key={`w-${w.id}`} className="flex items-start gap-2">
                <span className="flex-1">
                  <span className="font-medium">{w.title}</span>
                  <span className="text-muted-foreground"> · {w.reasons.join(". ")}</span>
                </span>
                <Link
                  to={to}
                  params={{ id: w.id }}
                  onClick={onOpen}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  Open
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
