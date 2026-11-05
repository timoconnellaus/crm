// Run-as on the automation page and the approval screen (ADR 0170): each connection an automation
// declares, with what it is bound to and who allowed it when (the consent), the last revocation
// and its reason, a Revoke action (automation.unbindConnection, confirmed), and for an unbound
// slot a picker of the connections the person may bind (their own personal ones; org ones for
// admins) with the consent spelled out before they allow it (automation.bindConnection).
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@relationship-os/ui/components/select";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { Link, useRouteContext } from "@tanstack/react-router";
import { PlugIcon, ShieldCheckIcon, UnplugIcon } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { formatDateTime, formatRelative } from "#/lib/format";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";
import {
  bindableConnections,
  type ConnectionSlot,
  connectionLabel,
  consentText,
  gatekeeperTitle,
  runsAs,
} from "./connections-model.ts";

interface AutomationRef {
  id: string;
  label: string;
}

/** Every declared connection of an automation, bound or not. */
export function ConnectionSlots({
  automation,
  slots,
}: {
  automation: AutomationRef;
  slots: readonly ConnectionSlot[];
}) {
  if (!slots.length) return null;
  return (
    <ul className="grid gap-2" aria-label="Connections" data-testid="automation-connections">
      {slots.map((slot) => (
        <li
          key={slot.slot}
          className="grid min-w-0 gap-1.5 rounded-lg border p-2.5 text-sm"
          data-testid="connection-slot"
          data-slot={slot.slot}
          data-bound={slot.binding ? "true" : "false"}
        >
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <code className="rounded bg-muted px-1 font-mono text-xs">{slot.slot}</code>
            <Badge variant="outline" className="font-normal">
              {gatekeeperTitle(slot.gatekeeper)}
            </Badge>
          </div>
          <p className="text-muted-foreground">{slot.purpose}</p>
          {slot.binding ? (
            <BoundSlot automation={automation} slot={slot} binding={slot.binding} />
          ) : (
            <>
              {slot.revoked && <RevokedNote revoked={slot.revoked} />}
              <SlotBinder automation={automation} slot={slot} />
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

function BoundSlot({
  automation,
  slot,
  binding,
}: {
  automation: AutomationRef;
  slot: ConnectionSlot;
  binding: NonNullable<ConnectionSlot["binding"]>;
}) {
  const { user, isAdmin } = useRouteContext({ from: "/_app" });
  const canRevoke = isAdmin || binding.boundBy === user.id || binding.ownerUserId === user.id;
  return (
    <div className="grid gap-1" data-testid="connection-binding">
      <div className="flex min-w-0 items-start gap-1.5">
        <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-green-700 dark:text-green-400" />
        <span className="min-w-0 break-words">
          Uses <b className="font-medium">{binding.connectionTitle}</b> as{" "}
          {runsAs(binding, user.id)}
          {binding.status !== "active" && (
            <span className="text-amber-800 dark:text-amber-300"> ({binding.status})</span>
          )}
        </span>
      </div>
      <div className="text-xs text-muted-foreground" data-testid="connection-consent">
        Allowed by {binding.boundBy === user.id ? "you" : (binding.boundByName ?? "someone")}{" "}
        <time dateTime={binding.boundAt} title={formatDateTime(binding.boundAt)}>
          {formatRelative(binding.boundAt)}
        </time>
      </div>
      {canRevoke && <RevokeButton automation={automation} slot={slot} binding={binding} />}
    </div>
  );
}

function RevokedNote({ revoked }: { revoked: NonNullable<ConnectionSlot["revoked"]> }) {
  return (
    <p
      className="rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:bg-amber-500/10 dark:text-amber-300"
      data-testid="connection-revoked"
    >
      Revoked{revoked.connectionTitle ? ` (${revoked.connectionTitle})` : ""}{" "}
      <time dateTime={revoked.revokedAt} title={formatDateTime(revoked.revokedAt)}>
        {formatRelative(revoked.revokedAt)}
      </time>
      {revoked.reason ? `: ${revoked.reason}` : ""}
    </p>
  );
}

function RevokeButton({
  automation,
  slot,
  binding,
}: {
  automation: AutomationRef;
  slot: ConnectionSlot;
  binding: NonNullable<ConnectionSlot["binding"]>;
}) {
  const [open, setOpen] = useState(false);
  const unbind = useOpMutation("automation.unbindConnection");
  async function run() {
    try {
      await unbind.mutateAsync({ id: automation.id, slot: slot.slot });
      toast.success(`Revoked ${binding.connectionTitle} for ${automation.label}`);
      setOpen(false);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() => setOpen(true)}
        aria-label={`Revoke ${slot.slot}`}
      >
        <UnplugIcon />
        Revoke
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {binding.connectionTitle}?</AlertDialogTitle>
            <AlertDialogDescription>
              “{automation.label}” stops using it and pauses until someone allows another connection
              for “{slot.slot}”. The admins are told. Runs already finished are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void run();
              }}
              disabled={unbind.isPending}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {unbind.isPending ? "Revoking…" : "Revoke"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** The picker for an unbound slot and the explicit consent. */
export function SlotBinder({
  automation,
  slot,
}: {
  automation: AutomationRef;
  slot: ConnectionSlot;
}) {
  const { user, isAdmin } = useRouteContext({ from: "/_app" });
  const id = useId();
  const list = useOp("connection.list", { scope: "usable" }, { staleTime: 15_000 });
  const bind = useOpMutation("automation.bindConnection");
  const options = bindableConnections(list.data?.items ?? [], slot.gatekeeper, {
    userId: user.id,
    isAdmin,
  });
  const [chosen, setChosen] = useState<string | null>(null);
  const selected = options.find((c) => c.id === chosen) ?? options[0] ?? null;

  if (list.isPending) return <Skeleton className="h-9" />;
  if (list.error) {
    return <p className="text-xs text-destructive">{errorMessage(list.error)}</p>;
  }
  if (!selected) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="no-bindable-connection">
        You have no {gatekeeperTitle(slot.gatekeeper)} connection to allow
        {isAdmin ? "" : " (an admin can bind an org connection)"}.{" "}
        <Link to="/settings/integrations" className="text-foreground underline">
          Connect one in Settings → Integrations
        </Link>
        , then come back here.
      </p>
    );
  }

  async function allow() {
    if (!selected) return;
    try {
      await bind.mutateAsync({ id: automation.id, slot: slot.slot, connectionId: selected.id });
      toast.success(`Allowed ${automation.label} to use ${selected.title}`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <div className="grid min-w-0 gap-1.5" data-testid="connection-binder">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        Connection for {slot.slot}
      </label>
      <Select value={selected.id} onValueChange={setChosen} disabled={bind.isPending}>
        <SelectTrigger id={id} className="w-full min-w-0">
          <SelectValue className="min-w-0">
            <span className="truncate">{connectionLabel(selected)}</span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {connectionLabel(c)}
              {c.scope === "org" ? " (org)" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="break-words" data-testid="consent-text">
        {consentText(automation.label, selected, user.id)}?
      </p>
      <p className="text-xs text-muted-foreground">
        Its steps then act through this connection as its owner. Outbound actions still wait for
        approval. You can revoke this at any time.
      </p>
      <Button
        size="sm"
        className="w-full sm:w-fit"
        onClick={() => void allow()}
        disabled={bind.isPending}
      >
        <PlugIcon />
        {bind.isPending ? "Allowing…" : "Allow"}
      </Button>
    </div>
  );
}
