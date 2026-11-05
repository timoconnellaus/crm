// The pieces of a pending action a reviewer reads: risk and status badges, record links, and the
// human-readable diff (added, removed and changed fields; bulk groups with a "show list" expander).
import { Badge } from "@relationship-os/ui/components/badge";
import { cn } from "@relationship-os/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  type DiffLine,
  isProvisional,
  noun,
  objectOfPrefix,
  type PreviewGroup,
  shortId,
} from "./describe.ts";

const RISK_STYLE: Record<string, string> = {
  "bulk-write": "bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300",
  destructive: "bg-red-100 text-red-900 dark:bg-red-500/15 dark:text-red-300",
  schema: "bg-red-100 text-red-900 dark:bg-red-500/15 dark:text-red-300",
  extension: "bg-red-100 text-red-900 dark:bg-red-500/15 dark:text-red-300",
  outbound: "bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300",
};

export function RiskBadge({ risk }: { risk: string }) {
  const style = RISK_STYLE[risk];
  return (
    <Badge
      variant={style ? "secondary" : "outline"}
      className={cn("rounded-sm px-1.5 font-normal", style)}
      data-testid="risk-badge"
    >
      {risk}
    </Badge>
  );
}

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300",
  applied: "bg-green-100 text-green-900 dark:bg-green-500/15 dark:text-green-300",
  failed: "bg-red-100 text-red-900 dark:bg-red-500/15 dark:text-red-300",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  applied: "Applied",
  failed: "Failed",
  skipped: "Skipped",
  rejected: "Rejected",
  expired: "Expired",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant="secondary"
      className={cn("rounded-sm px-1.5", STATUS_STYLE[status])}
      data-testid="status-badge"
    >
      {STATUS_LABEL[status] ?? status}
    </Badge>
  );
}

/** A record's name (or short id) linking to its page; provisional records are not links yet. */
export function RecordLink({
  object,
  id,
  names,
}: {
  object: string;
  id: string;
  names: Map<string, string>;
}) {
  const kind = object || objectOfPrefix(id.split("_")[0] ?? "");
  const name = names.get(id);
  const label = name ?? shortId(id);
  if (isProvisional(id)) {
    return (
      <span className="font-medium" title={id}>
        {name ? `${name} (new)` : label}
      </span>
    );
  }
  const className = "font-medium underline-offset-2 hover:underline";
  if (kind === "person") {
    return (
      <Link to="/people/$id" params={{ id }} className={className} title={id}>
        {label}
      </Link>
    );
  }
  if (kind === "organisation") {
    return (
      <Link to="/organisations/$id" params={{ id }} className={className} title={id}>
        {label}
      </Link>
    );
  }
  return (
    <span className="font-medium" title={id}>
      {label}
    </span>
  );
}

function Line({ line }: { line: DiffLine }) {
  const label = line.label ? `${line.label}: ` : "";
  if (line.kind === "add") {
    return (
      <div className="text-green-700 dark:text-green-400">
        + {label}
        {line.text}
      </div>
    );
  }
  if (line.kind === "remove") {
    return (
      <div className="text-red-700 dark:text-red-400">
        − {label}
        {line.text}
      </div>
    );
  }
  if (line.kind === "change") {
    return (
      <div>
        <span className="text-muted-foreground">{label}</span>
        {line.before !== undefined && (
          <>
            <del className="text-red-700 decoration-red-700/50 dark:text-red-400">
              {line.before}
            </del>{" "}
          </>
        )}
        → <ins className="text-green-700 no-underline dark:text-green-400">{line.text}</ins>
      </div>
    );
  }
  return <div className="text-muted-foreground">{line.text}</div>;
}

/** The diff of one pending action, grouped by records that change the same way. */
export function ChangePreview({
  groups,
  names,
}: {
  groups: PreviewGroup[];
  names: Map<string, string>;
}) {
  if (!groups.length) return null;
  return (
    <div className="grid gap-2" data-testid="change-preview">
      {groups.map((group) => (
        <PreviewGroupView
          key={`${group.object}:${group.action}:${group.ids[0]}`}
          group={group}
          names={names}
          labelled={groups.length > 1 || group.ids.length === 1}
        />
      ))}
    </div>
  );
}

function PreviewGroupView({
  group,
  names,
  labelled,
}: {
  group: PreviewGroup;
  names: Map<string, string>;
  labelled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const many = group.ids.length > 1;
  const first = group.ids[0] ?? "";
  return (
    <div className="grid gap-1 rounded-md bg-muted/60 px-2.5 py-1.5 font-mono text-xs leading-relaxed">
      {labelled && (
        <div className="font-sans text-xs text-muted-foreground">
          {many ? (
            `${group.ids.length} ${noun(group.object, group.ids.length)}`
          ) : (
            <>
              <span className="capitalize">{noun(group.object)}</span>{" "}
              <RecordLink object={group.object} id={first} names={names} />
            </>
          )}
        </div>
      )}
      {group.lines.map((line) => (
        <Line key={`${line.kind}:${line.label}:${line.text}`} line={line} />
      ))}
      {many && (
        <div className="font-sans text-xs text-muted-foreground">
          on {group.ids.length} records ·{" "}
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "hide list" : "show list"}
          </button>
          {open && (
            <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1" data-testid="record-list">
              {group.ids.map((id) => (
                <li key={id}>
                  <RecordLink object={group.object} id={id} names={names} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
