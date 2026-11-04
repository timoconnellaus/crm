// An organisation's people (its affiliations): the People tab lists current and past people with
// their titles and dates; the side card shows the first few current ones. The child-organisations
// card lists organisations whose parent this one is.
import { Avatar, AvatarFallback } from "@crm/ui/components/avatar";
import { Badge } from "@crm/ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@crm/ui/components/card";
import { Skeleton } from "@crm/ui/components/skeleton";
import { Link } from "@tanstack/react-router";
import { Building2Icon, UsersIcon } from "lucide-react";
import { formatDate, initials } from "#/lib/format";
import { EmptyState } from "../empty-state.tsx";
import type { ChildOrganisation, OrganisationAffiliation } from "./record-adapters.ts";

function dates(a: OrganisationAffiliation): string {
  const start = a.startedOn ? formatDate(a.startedOn) : null;
  const end = a.endedOn ? formatDate(a.endedOn) : null;
  if (!start && !end) return "";
  return `${start ?? "?"} – ${end ?? (a.current ? "now" : "?")}`;
}

function PersonRow({ affiliation: a }: { affiliation: OrganisationAffiliation }) {
  const name = a.personName ?? a.personId;
  return (
    <li className="flex items-center gap-3 py-2">
      <Avatar className="size-8">
        <AvatarFallback className="text-xs">{initials(name)}</AvatarFallback>
      </Avatar>
      <div className="grid min-w-0 flex-1">
        <Link
          to="/people/$id"
          params={{ id: a.personId }}
          className="truncate font-medium hover:underline"
        >
          {name}
        </Link>
        <span className="truncate text-sm text-muted-foreground">
          {[a.title, a.role].filter(Boolean).join(" · ") || "No title"}
        </span>
      </div>
      <span className="hidden text-xs text-muted-foreground sm:inline">{dates(a)}</span>
    </li>
  );
}

export function OrganisationPeopleList({
  affiliations,
  isPending,
}: {
  affiliations: OrganisationAffiliation[];
  isPending: boolean;
}) {
  if (isPending) {
    return (
      <div className="grid gap-2" aria-busy="true">
        <Skeleton className="h-12" />
        <Skeleton className="h-12" />
      </div>
    );
  }
  if (!affiliations.length) {
    return (
      <EmptyState
        icon={UsersIcon}
        title="No people yet"
        description="People appear here when they are affiliated with this organisation, for example by a job change or an import."
      />
    );
  }
  const current = affiliations.filter((a) => a.current);
  const past = affiliations.filter((a) => !a.current);
  return (
    <div className="grid gap-4" data-testid="organisation-people">
      <section aria-labelledby="org-people-current">
        <h2 id="org-people-current" className="text-sm font-medium">
          Current <span className="text-muted-foreground">({current.length})</span>
        </h2>
        {current.length ? (
          <ul className="divide-y">
            {current.map((a) => (
              <PersonRow key={a.id} affiliation={a} />
            ))}
          </ul>
        ) : (
          <p className="py-2 text-sm text-muted-foreground">Nobody currently.</p>
        )}
      </section>
      {past.length > 0 && (
        <section aria-labelledby="org-people-past">
          <h2 id="org-people-past" className="text-sm font-medium">
            Past <span className="text-muted-foreground">({past.length})</span>
          </h2>
          <ul className="divide-y">
            {past.map((a) => (
              <PersonRow key={a.id} affiliation={a} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

const CARD_LIMIT = 5;

export function OrganisationPeopleCard({
  affiliations,
  isPending,
  onShowAll,
}: {
  affiliations: OrganisationAffiliation[];
  isPending: boolean;
  onShowAll: () => void;
}) {
  const current = affiliations.filter((a) => a.current);
  return (
    <Card className="gap-2 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">People</CardTitle>
      </CardHeader>
      <CardContent className="px-4">
        {isPending ? (
          <Skeleton className="h-10" />
        ) : current.length ? (
          <>
            <ul className="divide-y">
              {current.slice(0, CARD_LIMIT).map((a) => (
                <PersonRow key={a.id} affiliation={a} />
              ))}
            </ul>
            {affiliations.length > CARD_LIMIT && (
              <button
                type="button"
                className="mt-1 text-sm text-muted-foreground hover:text-foreground hover:underline"
                onClick={onShowAll}
              >
                Show all {affiliations.length}
              </button>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No current people.</p>
        )}
      </CardContent>
    </Card>
  );
}

export function OrganisationFamilyCard({
  parent,
  childOrganisations: children,
  isPending,
}: {
  parent: { id: string; name: string } | null;
  childOrganisations: ChildOrganisation[];
  isPending: boolean;
}) {
  if (!parent && !isPending && !children.length) return null;
  return (
    <Card className="gap-2 py-4" data-testid="organisation-family">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Related organisations</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 px-4 text-sm">
        {parent && (
          <div className="grid gap-1">
            <span className="text-xs text-muted-foreground">Parent</span>
            <Link
              to="/organisations/$id"
              params={{ id: parent.id }}
              className="inline-flex items-center gap-2 hover:underline"
            >
              <Building2Icon className="size-4 text-muted-foreground" aria-hidden />
              {parent.name}
            </Link>
          </div>
        )}
        {isPending ? (
          <Skeleton className="h-6" />
        ) : (
          children.length > 0 && (
            <div className="grid gap-1">
              <span className="text-xs text-muted-foreground">
                Child organisations <Badge variant="secondary">{children.length}</Badge>
              </span>
              <ul className="grid gap-1" aria-label="Child organisations">
                {children.map((child) => (
                  <li key={child.id} className="flex items-center gap-2">
                    <Building2Icon className="size-4 text-muted-foreground" aria-hidden />
                    <Link
                      to="/organisations/$id"
                      params={{ id: child.id }}
                      className="truncate hover:underline"
                    >
                      {child.name}
                    </Link>
                    {child.primaryDomain && (
                      <span className="truncate text-xs text-muted-foreground">
                        {child.primaryDomain}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )
        )}
      </CardContent>
    </Card>
  );
}
