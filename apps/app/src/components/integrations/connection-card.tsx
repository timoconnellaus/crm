// One connection on Settings → Integrations (ADR 0050, 0052): its account and status, the
// sharing level for synced mail and meetings, the resources it may use (add through the picker,
// remove), sync controls when its gatekeeper syncs, outbound actions waiting on it, Reconnect when
// it expired, and Disconnect.
import type { CoreOutput } from "@relationship-os/core";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@relationship-os/ui/components/alert-dialog";
import { Badge } from "@relationship-os/ui/components/badge";
import { Button } from "@relationship-os/ui/components/button";
import { Input } from "@relationship-os/ui/components/input";
import { Label } from "@relationship-os/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@relationship-os/ui/components/select";
import { cn } from "@relationship-os/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import {
  CircleAlertIcon,
  InboxIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCwIcon,
  UnplugIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { formatDateTime, formatRelative } from "#/lib/format";
import { errorMessage, useOpMutation } from "#/lib/query";
import { AddResourceDialog } from "./add-resource-dialog.tsx";

export type Connection = CoreOutput<"connection.list">["items"][number];
type SharingLevel = Connection["sharingLevel"];

export const SHARING_LEVELS: { value: SharingLevel; label: string; help: string }[] = [
  {
    value: "full",
    label: "Full content",
    help: "Subject, participants, time and the message or event text.",
  },
  {
    value: "metadata",
    label: "Metadata only",
    help: "Subject, participants and time. No message or event text.",
  },
  { value: "none", label: "Don't sync", help: "Nothing from this connection reaches the CRM." },
];

const STATUS: Record<Connection["status"], { label: string; className: string }> = {
  connecting: {
    label: "Connecting",
    className: "bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300",
  },
  active: {
    label: "Active",
    className: "bg-green-100 text-green-900 dark:bg-green-500/15 dark:text-green-300",
  },
  expired: {
    label: "Expired",
    className: "bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300",
  },
  error: {
    label: "Error",
    className: "bg-red-100 text-red-900 dark:bg-red-500/15 dark:text-red-300",
  },
  disconnected: { label: "Disconnected", className: "" },
};

export function StatusBadge({ status }: { status: Connection["status"] }) {
  const style = STATUS[status];
  return (
    <Badge
      variant="secondary"
      className={cn("rounded-sm px-1.5 font-normal", style.className)}
      data-testid="connection-status"
    >
      {style.label}
    </Badge>
  );
}

interface KindStatus {
  backfilled?: boolean;
  lastRunAt?: string | null;
  lastError?: string | null;
  created?: number;
  restrictedSkipped?: number;
}

interface SyncView {
  mail: string | null;
  calendar: string | null;
  backfillDays: number;
  status: { mail: KindStatus | null; calendar: KindStatus | null };
}

/** The connection's sync JSON, read defensively (it is a free-form record in the schema). */
export function syncOf(connection: Connection): SyncView {
  const raw = connection.sync as Record<string, unknown>;
  const status = (raw.status ?? {}) as Record<string, unknown>;
  const kind = (value: unknown) =>
    value && typeof value === "object" ? (value as KindStatus) : null;
  return {
    mail: typeof raw.mail === "string" ? raw.mail : null,
    calendar: typeof raw.calendar === "string" ? raw.calendar : null,
    backfillDays: typeof raw.backfillDays === "number" ? raw.backfillDays : 90,
    status: { mail: kind(status.mail), calendar: kind(status.calendar) },
  };
}

export interface ConnectionCardProps {
  connection: Connection;
  /** What the vendor syncs (from the catalogue): sync controls show when non-empty. */
  syncs: readonly ("mail" | "calendar")[];
  /** Show the owner's name (org connections, or an admin's view of others'). */
  showOwner?: boolean;
  onReconnect: (connection: Connection) => void;
  reconnecting: boolean;
}

export function ConnectionCard({
  connection,
  syncs,
  showOwner,
  onReconnect,
  reconnecting,
}: ConnectionCardProps) {
  const headingId = useId();
  const manageable = connection.manageable;
  const active = connection.status === "active";
  return (
    <article
      className="grid min-w-0 gap-4 rounded-xl border p-4"
      aria-labelledby={headingId}
      data-testid="connection"
      data-connection={connection.id}
      data-status={connection.status}
    >
      <header className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2">
        <div className="grid min-w-0 flex-1 gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 id={headingId} className="min-w-0 truncate font-semibold">
              {connection.title}
            </h3>
            <StatusBadge status={connection.status} />
            {connection.pendingOutbound > 0 && (
              <Badge variant="outline" asChild className="rounded-sm px-1.5 font-normal">
                <Link to="/approvals" data-testid="pending-outbound">
                  <InboxIcon aria-hidden />
                  {connection.pendingOutbound} outbound action
                  {connection.pendingOutbound === 1 ? "" : "s"} waiting (simulated)
                </Link>
              </Badge>
            )}
          </div>
          <p className="text-xs break-words text-muted-foreground">
            {connection.vendorTitle}
            {connection.accountLabel ? ` · ${connection.accountLabel}` : ""}
            {connection.scope === "org" ? " · Org connection" : " · Personal"}
            {showOwner && connection.ownerName ? ` · ${connection.ownerName}` : ""}
            {connection.lastSyncAt && (
              <>
                {" "}
                · last synced{" "}
                <time
                  dateTime={connection.lastSyncAt}
                  title={formatDateTime(connection.lastSyncAt)}
                >
                  {formatRelative(connection.lastSyncAt)}
                </time>
              </>
            )}
          </p>
          {connection.error && connection.status !== "active" && (
            <p className="flex items-start gap-1.5 text-sm text-destructive" role="alert">
              <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="break-words">{connection.error}</span>
            </p>
          )}
        </div>
        {manageable && (
          <div className="flex flex-wrap gap-2">
            {(connection.status === "expired" || connection.status === "error") && (
              <Button
                size="sm"
                variant="outline"
                disabled={reconnecting}
                onClick={() => onReconnect(connection)}
              >
                <RotateCwIcon />
                {reconnecting ? "Reconnecting…" : "Reconnect"}
              </Button>
            )}
            {connection.status !== "disconnected" && <DisconnectButton connection={connection} />}
          </div>
        )}
      </header>
      {connection.status !== "disconnected" && (
        <>
          <SharingLevelField connection={connection} />
          <Resources connection={connection} canAdd={manageable && active} />
          {syncs.length > 0 && manageable && <SyncControls connection={connection} syncs={syncs} />}
        </>
      )}
    </article>
  );
}

function SharingLevelField({ connection }: { connection: Connection }) {
  const id = useId();
  const update = useOpMutation("connection.update");
  const current = SHARING_LEVELS.find((l) => l.value === connection.sharingLevel);

  async function change(value: string) {
    try {
      await update.mutateAsync({ id: connection.id, sharingLevel: value as SharingLevel });
      toast.success(
        `Sharing level: ${SHARING_LEVELS.find((l) => l.value === value)?.label ?? value}`,
      );
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>Sharing level</Label>
      <Select
        value={connection.sharingLevel}
        onValueChange={(value) => void change(value)}
        disabled={!connection.manageable || update.isPending}
      >
        <SelectTrigger id={id} className="w-full sm:w-64" aria-describedby={`${id}-help`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SHARING_LEVELS.map((level) => (
            <SelectItem key={level.value} value={level.value}>
              {level.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        {current?.help} Writing into the shared CRM is the point of disclosure: colleagues see what
        syncs at this level. A new level applies to what syncs from now on.
      </p>
    </div>
  );
}

function Resources({ connection, canAdd }: { connection: Connection; canAdd: boolean }) {
  const [adding, setAdding] = useState(false);
  const unbind = useOpMutation("connection.unbindResource");
  const headingId = useId();

  async function remove(key: string, title: string) {
    try {
      await unbind.mutateAsync({ id: connection.id, key });
      toast.success(`Removed ${title}`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <section className="grid gap-2" aria-labelledby={headingId}>
      <div className="flex flex-wrap items-center gap-2">
        <h4 id={headingId} className="text-sm font-medium">
          Resources
        </h4>
        <div className="flex-1" />
        {canAdd && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <PlusIcon />
            Add resource
          </Button>
        )}
      </div>
      {connection.resources.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No resources yet. Agents and sync can use only the resources added here.
        </p>
      ) : (
        <ul className="grid divide-y rounded-md border" aria-label="Resources">
          {connection.resources.map((resource) => (
            <li
              key={resource.key}
              className="flex min-w-0 items-center gap-3 px-3 py-2 text-sm"
              data-testid="connection-resource"
            >
              <div className="grid min-w-0 flex-1 gap-0.5">
                <span className="truncate font-medium">{resource.title}</span>
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  <code className="font-mono">{resource.bindingName}</code>
                  {resource.syncKind && (
                    <Badge variant="outline" className="rounded-sm px-1 font-normal">
                      {resource.syncKind === "mail" ? "Mailbox" : "Calendar"}
                    </Badge>
                  )}
                </span>
              </div>
              {connection.manageable && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${resource.title}`}
                  disabled={unbind.isPending}
                  onClick={() => void remove(resource.key, resource.title)}
                >
                  <XIcon />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canAdd && (
        <AddResourceDialog connection={connection} open={adding} onOpenChange={setAdding} />
      )}
    </section>
  );
}

const OFF = "__off__";

function SyncControls({
  connection,
  syncs,
}: {
  connection: Connection;
  syncs: readonly ("mail" | "calendar")[];
}) {
  const sync = syncOf(connection);
  const [mail, setMail] = useState(sync.mail ?? OFF);
  const [calendar, setCalendar] = useState(sync.calendar ?? OFF);
  const [days, setDays] = useState(String(sync.backfillDays));
  const setSync = useOpMutation("connection.setSync");
  const syncNow = useOpMutation("connection.syncNow", {
    invalidates: ["suggestedContact.", "jobChange."],
  });
  const base = useId();

  // Follow the server after a save or a refetch.
  useEffect(() => {
    setMail(sync.mail ?? OFF);
    setCalendar(sync.calendar ?? OFF);
    setDays(String(sync.backfillDays));
  }, [sync.mail, sync.calendar, sync.backfillDays]);

  const options = (kind: "mail" | "calendar") =>
    connection.resources.filter((r) => r.syncKind === kind);
  const dirty =
    mail !== (sync.mail ?? OFF) ||
    calendar !== (sync.calendar ?? OFF) ||
    days !== String(sync.backfillDays);
  const configured = sync.mail !== null || sync.calendar !== null;
  const parsedDays = Number.parseInt(days, 10);
  const daysValid = Number.isInteger(parsedDays) && parsedDays >= 0 && parsedDays <= 365;

  async function save() {
    try {
      await setSync.mutateAsync({
        id: connection.id,
        mail: mail === OFF ? null : mail,
        calendar: calendar === OFF ? null : calendar,
        backfillDays: daysValid ? parsedDays : 90,
      });
      toast.success("Sync settings saved");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function runNow() {
    try {
      await syncNow.mutateAsync({ id: connection.id });
      toast.success("Synced");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const picker = (kind: "mail" | "calendar", value: string, onChange: (v: string) => void) => {
    const id = `${base}-${kind}`;
    const choices = options(kind);
    const off = `Don't sync ${kind === "mail" ? "mail" : "meetings"}`;
    const label = value === OFF ? off : (choices.find((r) => r.key === value)?.title ?? value);
    return (
      <div className="grid min-w-0 content-start gap-1.5">
        <Label htmlFor={id}>{kind === "mail" ? "Mailbox" : "Calendar"} to sync</Label>
        <Select value={value} onValueChange={onChange} disabled={setSync.isPending}>
          <SelectTrigger id={id} className="w-full min-w-0">
            {/* Long resource titles truncate instead of widening the trigger. */}
            <SelectValue className="min-w-0">
              <span className="truncate">{label}</span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={OFF}>{off}</SelectItem>
            {choices.map((r) => (
              <SelectItem key={r.key} value={r.key}>
                {r.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {choices.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Add a {kind === "mail" ? "mailbox" : "calendar"} resource first.
          </p>
        )}
      </div>
    );
  };

  return (
    <section className="grid gap-3 rounded-md border p-3" aria-label="Sync">
      <div className="grid gap-0.5">
        <h4 className="text-sm font-medium">Sync</h4>
        <p className="text-xs text-muted-foreground">
          Email and meetings with people in the CRM land on their timelines, at this connection's
          sharing level.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {syncs.includes("mail") && picker("mail", mail, setMail)}
        {syncs.includes("calendar") && picker("calendar", calendar, setCalendar)}
        <div className="grid min-w-0 content-start gap-1.5">
          <Label htmlFor={`${base}-days`}>First sync reads back (days)</Label>
          <Input
            id={`${base}-days`}
            type="number"
            inputMode="numeric"
            min={0}
            max={365}
            value={days}
            onChange={(e) => setDays(e.target.value)}
            aria-invalid={daysValid ? undefined : true}
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={!dirty || !daysValid || setSync.isPending}
          onClick={() => void save()}
        >
          {setSync.isPending ? "Saving…" : "Save sync settings"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!configured || dirty || syncNow.isPending || connection.status !== "active"}
          onClick={() => void runNow()}
        >
          <RefreshCwIcon className={cn(syncNow.isPending && "animate-spin")} />
          {syncNow.isPending ? "Syncing…" : "Sync now"}
        </Button>
      </div>
      {(sync.status.mail || sync.status.calendar) && (
        <dl className="grid gap-x-3 gap-y-1 text-xs sm:grid-cols-[6rem_1fr]">
          {sync.status.mail && <KindLine label="Mail" status={sync.status.mail} />}
          {sync.status.calendar && <KindLine label="Calendar" status={sync.status.calendar} />}
        </dl>
      )}
    </section>
  );
}

function KindLine({ label, status }: { label: string; status: KindStatus }) {
  const parts: string[] = [];
  parts.push(status.backfilled ? "Caught up" : "Backfilling");
  if (status.lastRunAt) parts.push(`last run ${formatRelative(status.lastRunAt)}`);
  if (status.created) parts.push(`${status.created} added`);
  if (status.restrictedSkipped) {
    parts.push(
      `${status.restrictedSkipped} restricted read${status.restrictedSkipped === 1 ? "" : "s"} skipped`,
    );
  }
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="grid gap-0.5" data-testid={`sync-status-${label.toLowerCase()}`}>
        <span>{parts.join(" · ")}</span>
        {status.lastError && (
          <span className="text-destructive" role="alert">
            {status.lastError}
          </span>
        )}
      </dd>
    </>
  );
}

function DisconnectButton({ connection }: { connection: Connection }) {
  const [open, setOpen] = useState(false);
  const disconnect = useOpMutation("connection.disconnect");

  async function run() {
    try {
      await disconnect.mutateAsync({ id: connection.id });
      setOpen(false);
      toast.success(`Disconnected ${connection.title}`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        aria-label={`Disconnect ${connection.title}`}
      >
        <UnplugIcon />
        Disconnect
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {connection.title}?</AlertDialogTitle>
            <AlertDialogDescription>
              The account's access is revoked and its resources, hooks and sync stop. Activities
              already synced stay on timelines. Outbound actions still waiting on it fail if
              approved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void run();
              }}
              disabled={disconnect.isPending}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
