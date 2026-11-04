// A person's organisations: current affiliations (primary first) and past ones (job history).
import { Badge } from "@crm/ui/components/badge";
import { Button } from "@crm/ui/components/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@crm/ui/components/card";
import { Skeleton } from "@crm/ui/components/skeleton";
import { Building2Icon, PlusIcon } from "lucide-react";
import { formatDate } from "#/lib/format";
import type { AffiliationItem } from "./adapters.ts";

export interface AffiliationsCardProps {
  affiliations: AffiliationItem[];
  isPending?: boolean;
  /** False while affiliation.list is not available (only the primary one is known). */
  wired?: boolean;
  /** Opens "add affiliation"; null disables it (affiliation.create not available yet). */
  onAdd?: (() => void) | null;
}

function period(a: AffiliationItem): string {
  const from = a.startedOn ? formatDate(a.startedOn) : null;
  const to = a.endedOn ? formatDate(a.endedOn) : a.current ? "now" : null;
  return from || to ? `${from ?? "?"} – ${to ?? "?"}` : "";
}

function Row({ affiliation }: { affiliation: AffiliationItem }) {
  const dates = period(affiliation);
  return (
    <li className="flex items-start gap-2 text-sm">
      <Building2Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="grid min-w-0 flex-1">
        <span className="flex items-center gap-2 truncate font-medium">
          {affiliation.organisationName ?? affiliation.organisationId}
          {affiliation.primary && <Badge variant="secondary">Primary</Badge>}
        </span>
        {(affiliation.title || affiliation.role) && (
          <span className="truncate text-muted-foreground">
            {[affiliation.title, affiliation.role].filter(Boolean).join(" · ")}
          </span>
        )}
        {dates && <span className="text-xs text-muted-foreground">{dates}</span>}
      </div>
    </li>
  );
}

export function AffiliationsCard({
  affiliations,
  isPending,
  wired = true,
  onAdd,
}: AffiliationsCardProps) {
  const current = affiliations
    .filter((a) => a.current)
    .sort((a, b) => Number(b.primary) - Number(a.primary));
  const past = affiliations.filter((a) => !a.current);
  return (
    <Card className="gap-3 py-4" data-testid="affiliations-card">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Organisations</CardTitle>
        <CardAction>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Add organisation"
            disabled={!onAdd}
            onClick={() => onAdd?.()}
          >
            <PlusIcon />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-3 px-4">
        {isPending ? (
          <Skeleton className="h-10" />
        ) : (
          <>
            {current.length ? (
              <ul className="grid gap-3" aria-label="Current organisations">
                {current.map((a) => (
                  <Row key={a.id} affiliation={a} />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No current organisation.</p>
            )}
            {past.length > 0 && (
              <div className="grid gap-2">
                <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Past
                </h3>
                <ul className="grid gap-3" aria-label="Past organisations">
                  {past.map((a) => (
                    <Row key={a.id} affiliation={a} />
                  ))}
                </ul>
              </div>
            )}
            {!wired && (
              <p className="text-xs text-muted-foreground">
                Job history and adding organisations are coming soon.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
