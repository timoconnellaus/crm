// Gallery view (ADR 0027, ADR 0056): a responsive grid of cards showing chosen fields and an
// image (a URL field) or initials. Rows of cards are virtualised in the page's scrolling body
// (VirtualFeed) and the next page loads as the end comes near.
import type { Filter, Sort } from "@crm/core/client";
import { Skeleton } from "@crm/ui/components/skeleton";
import { useInfiniteQuery } from "@tanstack/react-query";
import { LayoutGridIcon } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { EmptyState, ErrorState } from "#/components/empty-state";
import { VirtualFeed } from "#/components/layout/infinite";
import type { ObjectInfo } from "#/lib/schema";
import { fetchRecords, RecordCard, type ViewRecord, viewKey } from "./records.tsx";

export interface GallerySpec {
  imageField?: string | undefined;
  cardFields: string[];
  filter?: Filter | undefined;
  sort?: Sort | undefined;
}

const CARD_MIN = 240;

function imageOf(record: ViewRecord, field: string | undefined): string | true {
  const value = field ? record.values[field] : null;
  return typeof value === "string" && /^https?:\/\//.test(value) ? value : true;
}

export function GalleryView({ info, spec }: { info: ObjectInfo; spec: GallerySpec }) {
  const fields = [...(spec.imageField ? [spec.imageField] : []), ...spec.cardFields];
  const query = useInfiniteQuery({
    queryKey: viewKey(info.name, "gallery", spec.filter ?? null, spec.sort ?? null, fields),
    queryFn: ({ pageParam }) =>
      fetchRecords(info.name, {
        filter: spec.filter,
        sort: spec.sort,
        limit: 60,
        fields,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

  const ref = useRef<HTMLDivElement>(null);
  const [perRow, setPerRow] = useState(1);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setPerRow(Math.max(1, Math.floor(element.clientWidth / CARD_MIN)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const rows = useMemo(() => {
    const records = query.data?.pages.flatMap((p) => p.items) ?? [];
    const out: ViewRecord[][] = [];
    for (let i = 0; i < records.length; i += perRow) out.push(records.slice(i, i + perRow));
    return out;
  }, [query.data, perRow]);

  return (
    <div ref={ref} className="px-4 pt-4 pb-6 sm:px-6" data-testid="gallery">
      {query.isPending ? (
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: `repeat(${perRow}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: perRow * 2 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: placeholders.
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : query.isError ? (
        <ErrorState
          title="Could not load the gallery"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      ) : !rows.length ? (
        <EmptyState
          icon={LayoutGridIcon}
          title="Nothing to show here"
        />
      ) : (
        <VirtualFeed
          items={rows}
          getKey={(row) => row[0]?.id ?? ""}
          estimateSize={140}
          label={`${info.plural ?? info.label} gallery`}
          as="ul"
          source={query}
          prefetch={4}
          renderItem={(row) => (
            <div
              className="grid gap-3 pb-3"
              style={{ gridTemplateColumns: `repeat(${perRow}, minmax(0, 1fr))` }}
            >
              {row.map((record) => (
                <RecordCard
                  key={record.id}
                  info={info}
                  record={record}
                  fields={spec.cardFields}
                  image={imageOf(record, spec.imageField)}
                  data-testid="gallery-card"
                  className="min-h-28"
                />
              ))}
            </div>
          )}
        />
      )}
    </div>
  );
}
