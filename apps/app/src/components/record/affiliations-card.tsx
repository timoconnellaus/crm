// Affiliations of a record: current ones (primary first) and past ones (job history). On a
// person it lists their organisations; on an organisation, its people.
import { Badge } from "@relationship-os/ui/components/badge";
import { Button } from "@relationship-os/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@relationship-os/ui/components/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@relationship-os/ui/components/dropdown-menu";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { BriefcaseIcon, Building2Icon, EllipsisIcon, PlusIcon, UserIcon } from "lucide-react";
import { formatDate } from "#/lib/format";
import { errorMessage } from "#/lib/query";
import type { AffiliationItem, RecordObject } from "./adapters.ts";
import { RecordLink } from "./timeline.tsx";

export interface AffiliationsCardProps {
  /** Whose affiliations: a person's organisations or an organisation's people. */
  object?: RecordObject;
  affiliations: AffiliationItem[];
  isPending?: boolean;
  error?: Error | null;
  /** Opens "add affiliation"; null hides it (read-only record). */
  onAdd?: (() => void) | null;
  /** Opens "Change job" (people only); null hides it. */
  onChangeJob?: (() => void) | null;
  /** Ends a current affiliation; null hides the row action. */
  onEnd?: ((affiliation: AffiliationItem) => void) | null;
}

function period(a: AffiliationItem): string {
  const from = a.startedOn ? formatDate(`${a.startedOn}T00:00:00`) : null;
  const to = a.endedOn ? formatDate(`${a.endedOn}T00:00:00`) : a.current ? "now" : null;
  return from || to ? `${from ?? "?"} – ${to ?? "?"}` : "";
}

function Row({
  affiliation,
  object,
  onEnd,
}: {
  affiliation: AffiliationItem;
  object: RecordObject;
  onEnd?: ((affiliation: AffiliationItem) => void) | null;
}) {
  const dates = period(affiliation);
  const other =
    object === "person"
      ? {
          object: "organisation",
          id: affiliation.organisationId,
          name: affiliation.organisationName,
        }
      : { object: "person", id: affiliation.personId, name: affiliation.personName };
  const Icon = object === "person" ? Building2Icon : UserIcon;
  return (
    <li className="flex items-start gap-2 text-sm">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="grid min-w-0 flex-1">
        <span className="flex items-center gap-2 truncate font-medium">
          <RecordLink object={other.object} id={other.id}>
            {other.name ?? other.id}
          </RecordLink>
          {affiliation.primary && <Badge variant="secondary">Primary</Badge>}
        </span>
        {(affiliation.title || affiliation.role) && (
          <span className="truncate text-muted-foreground">
            {[affiliation.title, affiliation.role].filter(Boolean).join(" · ")}
          </span>
        )}
        {dates && <span className="text-xs text-muted-foreground">{dates}</span>}
      </div>
      {onEnd && affiliation.current && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Actions for ${other.name ?? "affiliation"}`}
            >
              <EllipsisIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onEnd(affiliation)}>End affiliation</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  );
}

export function AffiliationsCard({
  object = "person",
  affiliations,
  isPending,
  error,
  onAdd,
  onChangeJob,
  onEnd,
}: AffiliationsCardProps) {
  const current = affiliations
    .filter((a) => a.current)
    .sort((a, b) => Number(b.primary) - Number(a.primary));
  const past = affiliations.filter((a) => !a.current);
  const noun = object === "person" ? "organisation" : "person";
  return (
    <Card className="gap-3 py-4" data-testid="affiliations-card">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">
          {object === "person" ? "Organisations" : "People"}
        </CardTitle>
        <CardAction className="flex gap-1">
          {onChangeJob && (
            <Button variant="ghost" size="xs" onClick={() => onChangeJob()}>
              <BriefcaseIcon />
              Change job
            </Button>
          )}
          {onAdd && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Add ${noun}`}
              onClick={() => onAdd()}
            >
              <PlusIcon />
            </Button>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-3 px-4">
        {isPending ? (
          <Skeleton className="h-10" />
        ) : error ? (
          <p className="text-sm text-destructive">{errorMessage(error)}</p>
        ) : (
          <>
            {current.length ? (
              <ul className="grid gap-3" aria-label={`Current ${noun}s`}>
                {current.map((a) => (
                  <Row key={a.id} affiliation={a} object={object} onEnd={onEnd} />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                {object === "person" ? "No current organisation." : "No current people."}
              </p>
            )}
            {past.length > 0 && (
              <div className="grid gap-2">
                <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Past
                </h3>
                <ul className="grid gap-3" aria-label={`Past ${noun}s`}>
                  {past.map((a) => (
                    <Row key={a.id} affiliation={a} object={object} />
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
