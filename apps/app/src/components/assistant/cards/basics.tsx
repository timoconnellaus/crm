// Layout, primitives and record components of the catalogue.
import type { RendererProps } from "@relationship-os/agent-a2ui/react";
import { Separator } from "@relationship-os/ui/components/separator";
import { cn } from "@relationship-os/ui/lib/utils";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { type ComponentProps, useMemo, useState } from "react";
import { recordHref } from "#/lib/schema";
import { Markdown } from "../../markdown.tsx";
import { isAllowedHref } from "./host.tsx";
import {
  ActionButton,
  ActionFooter,
  Body,
  CardLink,
  Chip,
  Chips,
  Facts,
  Frame,
  Header,
  Initials,
  LinkButton,
  Pill,
  Row,
  Rows,
  RowText,
} from "./parts.tsx";

export function CardComponent({ props, children }: RendererProps<"card">) {
  return (
    <Frame type="card" tone={props.tone}>
      {(props.title || props.subtitle || props.badge) && (
        <Header
          title={props.title}
          subtitle={props.subtitle}
          aside={props.badge && <Pill tone={props.badge.tone}>{props.badge.text}</Pill>}
        />
      )}
      {props.children.length > 0 && <Body>{children}</Body>}
      <ActionFooter actions={props.actions} />
    </Frame>
  );
}

export function StackComponent({ children }: RendererProps<"stack">) {
  return (
    <div className="grid min-w-0 gap-2" data-a2ui="stack">
      {children}
    </div>
  );
}

/** Links a card's Markdown may hold: allowed ones only. No images: they would load from anywhere. */
const cardMarkdown: ComponentProps<typeof Markdown>["components"] = {
  a: ({ href, children }) =>
    href && isAllowedHref(href) ? <CardLink href={href}>{children}</CardLink> : children,
};

export function TextComponent({ props }: RendererProps<"text">) {
  return (
    <div data-a2ui="text" className={cn("min-w-0", props.muted && "text-muted-foreground")}>
      <Markdown components={cardMarkdown} noImages>
        {props.text}
      </Markdown>
    </div>
  );
}

export function HeadingComponent({ props }: RendererProps<"heading">) {
  return (
    <h3 className="text-sm font-medium" data-a2ui="heading">
      {props.text}
    </h3>
  );
}

export function DividerComponent() {
  return <Separator data-a2ui="divider" />;
}

export function KeyValueComponent({ props }: RendererProps<"keyValue">) {
  return (
    <div data-a2ui="keyValue" className="min-w-0">
      <Facts items={props.items} />
    </div>
  );
}

export function BadgeComponent({ props }: RendererProps<"badge">) {
  return (
    <span data-a2ui="badge" className="inline-flex max-w-full">
      <Pill tone={props.tone}>{props.text}</Pill>
    </span>
  );
}

export function RecordChipComponent({ props }: RendererProps<"recordChip">) {
  return (
    <span data-a2ui="recordChip" className="inline-flex max-w-full">
      <Chip record={props.record} />
    </span>
  );
}

export function ListComponent({ props }: RendererProps<"list">) {
  const Tag = props.ordered ? "ol" : "ul";
  return (
    <Tag
      data-a2ui="list"
      className={cn("grid min-w-0 gap-1 pl-5", props.ordered ? "list-decimal" : "list-disc")}
    >
      {props.items.map((item) => (
        <li key={item.text} className="break-words">
          {item.record ? (
            <CardLink
              href={recordHref(item.record.object, item.record.id)}
              className="underline underline-offset-2"
            >
              {item.text}
            </CardLink>
          ) : (
            item.text
          )}
          {item.secondary && <span className="text-muted-foreground"> · {item.secondary}</span>}
        </li>
      ))}
    </Tag>
  );
}

type Cell = string | number | null | undefined;

function compareCells(a: Cell, b: Cell): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true });
}

export function TableComponent({ props }: RendererProps<"table">) {
  const [sort, setSort] = useState<{ key: string; down: boolean } | null>(null);
  const rows = useMemo(() => {
    if (!sort) return props.rows;
    const sign = sort.down ? -1 : 1;
    return [...props.rows].sort((a, b) => sign * compareCells(a[sort.key], b[sort.key]));
  }, [props.rows, sort]);
  return (
    <Frame type="table">
      {/* A wide table scrolls inside the card, never the page. */}
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b text-left">
              {props.columns.map((column) => {
                const active = sort?.key === column.key;
                const Arrow = active && sort.down ? ArrowDownIcon : ArrowUpIcon;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={active ? (sort.down ? "descending" : "ascending") : "none"}
                    className={cn(
                      "px-3 py-2 font-medium whitespace-nowrap",
                      column.align === "end" && "text-right",
                    )}
                  >
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 hover:text-foreground"
                      onClick={() =>
                        setSort({ key: column.key, down: active ? !sort.down : false })
                      }
                    >
                      {column.label}
                      {active && <Arrow className="size-3" aria-hidden />}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: table rows have no ids.
              <tr key={i}>
                {props.columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn(
                      "px-3 py-1.5 whitespace-nowrap",
                      column.align === "end" && "text-right tabular-nums",
                    )}
                  >
                    {row[column.key] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {props.viewAll && (
        <footer className="border-t px-3 py-2">
          <LinkButton href={props.viewAll.href} label={props.viewAll.label} />
        </footer>
      )}
    </Frame>
  );
}

export function ActionsComponent({ props }: RendererProps<"actions">) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2" data-a2ui="actions">
      {props.actions.map((action, i) => (
        <ActionButton key={action.label} action={action} index={i} />
      ))}
    </div>
  );
}

export function LinkComponent({ props }: RendererProps<"link">) {
  return (
    <span data-a2ui="link" className="min-w-0 break-words">
      <CardLink href={props.href} className="underline underline-offset-2">
        {props.label}
      </CardLink>
    </span>
  );
}

export function ImageComponent({ props }: RendererProps<"image">) {
  return (
    <img
      data-a2ui="image"
      src={props.src}
      alt={props.alt}
      width={props.width}
      className="h-auto max-w-full rounded-md"
    />
  );
}

export function ProgressComponent({ props }: RendererProps<"progress">) {
  const percent = Math.min(100, Math.round((props.value / props.max) * 100));
  return (
    <Frame type="progress">
      <Header
        title={props.label}
        aside={props.status === "running" ? `${percent}%` : props.status}
      />
      <Body>
        <div
          role="progressbar"
          aria-label={props.label}
          aria-valuemin={0}
          aria-valuemax={props.max}
          aria-valuenow={Math.min(props.value, props.max)}
          className="h-1.5 overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn(
              "h-full rounded-full",
              props.status === "failed" ? "bg-destructive" : "bg-primary",
            )}
            style={{ width: `${percent}%` }}
          />
        </div>
        {props.detail && <p className="text-xs text-muted-foreground">{props.detail}</p>}
      </Body>
    </Frame>
  );
}

export function EmptyStateComponent({ props }: RendererProps<"emptyState">) {
  return (
    <Frame type="emptyState" className="grid justify-items-center gap-1 px-3 py-5 text-center">
      <p className="font-medium">{props.title}</p>
      {props.text && <p className="text-xs text-muted-foreground">{props.text}</p>}
      {props.action && (
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          <ActionButton action={props.action} />
        </div>
      )}
    </Frame>
  );
}

export function RecordCardComponent({ props }: RendererProps<"recordCard">) {
  const { record } = props;
  return (
    <Frame type="recordCard">
      <Header
        lead={<Initials name={record.label} square={record.object !== "person"} />}
        title={
          <CardLink href={recordHref(record.object, record.id)} className="hover:underline">
            {record.label}
          </CardLink>
        }
        subtitle={record.subtitle}
      />
      {props.facts.length > 0 && (
        <Body>
          <Facts items={props.facts} />
        </Body>
      )}
      <ActionFooter actions={props.actions} />
    </Frame>
  );
}

export function RecordListComponent({ props }: RendererProps<"recordList">) {
  return (
    <Frame type="recordList">
      <Header title={props.title} aside={props.total ?? props.rows.length} />
      <Rows label={props.title}>
        {props.rows.map((row) => (
          <Row key={row.record.id}>
            <RowText
              title={
                <CardLink
                  href={recordHref(row.record.object, row.record.id)}
                  className="hover:underline"
                >
                  {row.record.label}
                </CardLink>
              }
              sub={row.values.filter(Boolean).join(" · ")}
            />
          </Row>
        ))}
      </Rows>
      <ActionFooter actions={props.bulkActions}>
        {props.viewAll && <LinkButton href={props.viewAll} label="View all" />}
      </ActionFooter>
    </Frame>
  );
}

export function RecordDiffComponent({ props }: RendererProps<"recordDiff">) {
  return (
    <Frame type="recordDiff">
      <Header title={props.title} subtitle={props.record?.label} />
      <Body>
        <ul className="grid gap-1 rounded-md bg-muted/50 p-2 text-[13px]">
          {props.changes.map((change) => (
            <li key={change.field} className="min-w-0 break-words">
              <span className="text-muted-foreground">{change.field}</span>{" "}
              {change.before !== null && <del className="text-destructive">{change.before}</del>}
              {change.before !== null && change.after !== null && " → "}
              {change.after !== null && (
                <ins className="text-success no-underline">{change.after}</ins>
              )}
            </li>
          ))}
        </ul>
      </Body>
      <ActionFooter actions={props.actions} />
    </Frame>
  );
}

export function SearchResultsComponent({ props }: RendererProps<"searchResults">) {
  return (
    <Frame type="searchResults">
      <Header title={`Results for "${props.query}"`} />
      {props.groups.map((group) => (
        <div key={group.label}>
          <p className="border-t bg-muted/40 px-3 py-1 text-xs font-medium text-muted-foreground">
            {group.label}
          </p>
          <ul className="divide-y">
            {group.hits.map((hit) => (
              <Row key={hit.record.id}>
                <RowText
                  title={
                    <CardLink
                      href={recordHref(hit.record.object, hit.record.id)}
                      className="hover:underline"
                    >
                      {hit.record.label}
                    </CardLink>
                  }
                  sub={hit.snippet}
                />
                {hit.matchedBy && (
                  <span className="shrink-0 text-xs text-muted-foreground">by {hit.matchedBy}</span>
                )}
              </Row>
            ))}
          </ul>
        </div>
      ))}
      <ActionFooter actions={props.refine ? [props.refine] : undefined} />
    </Frame>
  );
}

export function RelatedRecordsComponent({ props }: RendererProps<"relatedRecords">) {
  return (
    <Frame type="relatedRecords">
      <Header title={props.title} />
      <Body className="gap-3">
        {props.groups.map((group) => (
          <div key={group.label} className="grid min-w-0 gap-1">
            <p className="text-xs text-muted-foreground">{group.label}</p>
            {group.records.length ? (
              <Chips records={group.records} />
            ) : (
              <p className="text-xs text-muted-foreground">None</p>
            )}
          </div>
        ))}
      </Body>
    </Frame>
  );
}
