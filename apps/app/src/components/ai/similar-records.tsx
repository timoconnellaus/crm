// "Similar records" on person, organisation and deal pages (ADR 0155): record.similar's nearest
// neighbours by meaning, linked like search hits. Says so when the record is not embedded yet
// (it is indexed a moment after each write) or semantic search is not configured.
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@crm/ui/components/card";
import { Skeleton } from "@crm/ui/components/skeleton";
import { useNavigate } from "@tanstack/react-router";
import {
  BoxIcon,
  Building2Icon,
  CheckSquareIcon,
  type LucideIcon,
  MessageSquareTextIcon,
  SparklesIcon,
  UserIcon,
} from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { errorMessage, useOp } from "#/lib/query";
import { hrefFor } from "#/lib/search-adapter";

const ICON: Record<string, LucideIcon> = {
  person: UserIcon,
  organisation: Building2Icon,
  activity: MessageSquareTextIcon,
  task: CheckSquareIcon,
};

/** A link to a search hit's page, navigating in-app on a plain click. */
export function HitLink({
  hit,
  children,
}: {
  hit: { object: string; id: string };
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const href = hrefFor(hit);
  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    void navigate({ href });
  }
  return (
    <a
      href={href}
      onClick={onClick}
      className="min-w-0 truncate underline-offset-2 hover:underline"
    >
      {children}
    </a>
  );
}

export function SimilarRecordsCard({ object, id }: { object: string; id: string }) {
  const similar = useOp(
    "record.similar",
    { object, id, limit: 5 },
    {
      staleTime: 30_000,
      // Embeddings are written just after each save: look again shortly while not indexed.
      refetchInterval: (query) => (query.state.data?.status === "not_indexed" ? 5_000 : false),
    },
  );
  const data = similar.data;
  return (
    <Card className="gap-3 py-4" data-testid="similar-records" data-status={data?.status}>
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Similar records</CardTitle>
        <CardAction>
          <SparklesIcon className="size-4 text-muted-foreground" aria-hidden />
        </CardAction>
      </CardHeader>
      <CardContent className="px-4 text-sm">
        {similar.isPending ? (
          <Skeleton className="h-12 w-full" />
        ) : similar.isError || !data ? (
          <p className="text-destructive" role="alert">
            {errorMessage(similar.error)}
          </p>
        ) : data.status === "unavailable" ? (
          <p className="text-muted-foreground">
            Semantic search is not configured, so similar records can't be found.
          </p>
        ) : data.status === "not_indexed" ? (
          <p className="text-muted-foreground">Not indexed yet. Check back in a moment.</p>
        ) : data.hits.length === 0 ? (
          <p className="text-muted-foreground">Nothing similar yet.</p>
        ) : (
          <ul className="grid gap-2" aria-label="Similar records">
            {data.hits.map((hit) => {
              const Icon = ICON[hit.object] ?? BoxIcon;
              return (
                <li key={`${hit.object}:${hit.id}`} className="flex min-w-0 items-start gap-2">
                  <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="grid min-w-0">
                    <HitLink hit={hit}>{hit.title}</HitLink>
                    {hit.subtitle && (
                      <span className="truncate text-xs text-muted-foreground">{hit.subtitle}</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
