// Settings → Integrations, admins only: the org's internal domains for sync (sync.getSettings /
// sync.setSettings) and which outbound action kinds may auto-apply under Balanced
// (outbound.kinds / outbound.setAutoApprove). Turning auto-approval on loosens the approval
// policy, so it asks first.
import type { CoreOutput } from "@crm/core";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@crm/ui/components/alert-dialog";
import { Badge } from "@crm/ui/components/badge";
import { Button } from "@crm/ui/components/button";
import { Label } from "@crm/ui/components/label";
import { Skeleton } from "@crm/ui/components/skeleton";
import { Switch } from "@crm/ui/components/switch";
import { Textarea } from "@crm/ui/components/textarea";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { EmptyState, ErrorState } from "#/components/empty-state";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

/** "a.com, b.com\nc.com" → ["a.com", "b.com", "c.com"] (lower-cased, de-duplicated). */
export function parseDomains(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,;]+/)
        .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
        .filter(Boolean),
    ),
  ];
}

export function InternalDomains() {
  const settings = useOp("sync.getSettings", {});
  const save = useOpMutation("sync.setSettings", { invalidates: ["sync."] });
  const [text, setText] = useState("");
  const id = useId();
  const configured = settings.data?.internalDomains;

  useEffect(() => {
    if (configured) setText(configured.join(", "));
  }, [configured]);

  if (settings.isPending) return <Skeleton className="h-28" />;
  if (settings.isError) {
    return <ErrorState title="Could not load sync settings" error={settings.error} />;
  }
  const domains = parseDomains(text);
  const dirty = domains.join(",") !== settings.data.internalDomains.join(",");

  async function submit() {
    try {
      await save.mutateAsync({ internalDomains: domains });
      toast.success("Internal domains saved");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <div className="grid gap-2 rounded-xl border p-4">
      <Label htmlFor={id}>Internal domains</Label>
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        Addresses at these domains are colleagues: they are never matched to people, suggested as
        contacts or counted as external. Leave empty to use the domains of the CRM users' own
        addresses
        {settings.data.effectiveInternalDomains.length > 0 &&
          ` (now ${settings.data.effectiveInternalDomains.join(", ")})`}
        .
      </p>
      <Textarea
        id={id}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="example.com, example.org"
        aria-describedby={`${id}-help`}
        className="min-h-16"
      />
      <div>
        <Button size="sm" disabled={!dirty || save.isPending} onClick={() => void submit()}>
          {save.isPending ? "Saving…" : "Save domains"}
        </Button>
      </div>
    </div>
  );
}

type Kind = CoreOutput<"outbound.kinds">["items"][number];

export function OutboundKinds() {
  const kinds = useOp("outbound.kinds", {});
  if (kinds.isPending) return <Skeleton className="h-28" />;
  if (kinds.isError) {
    return <ErrorState title="Could not load outbound action kinds" error={kinds.error} />;
  }
  if (!kinds.data.items.length) {
    return (
      <EmptyState
        title="No outbound action kinds yet"
        description="Kinds appear once a gatekeeper has submitted an action of that kind."
      />
    );
  }
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className="w-full text-sm" aria-label="Outbound action kinds">
        <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Kind
            </th>
            <th scope="col" className="hidden px-3 py-2 font-medium sm:table-cell">
              Integration
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Auto-approve
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {kinds.data.items.map((kind) => (
            <KindRow key={kind.tag} kind={kind} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KindRow({ kind }: { kind: Kind }) {
  const [confirming, setConfirming] = useState(false);
  const set = useOpMutation("outbound.setAutoApprove");

  async function apply(enabled: boolean) {
    try {
      await set.mutateAsync({ tag: kind.tag, enabled });
      setConfirming(false);
      toast.success(
        enabled ? `${kind.label} now applies without review` : `${kind.label} needs review again`,
      );
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <tr data-testid="outbound-kind" data-tag={kind.tag}>
      <td className="px-3 py-2">
        <div className="grid gap-0.5">
          <span className="font-medium">{kind.label}</span>
          <code className="text-xs text-muted-foreground">{kind.tag}</code>
        </div>
      </td>
      <td className="hidden px-3 py-2 text-muted-foreground sm:table-cell">{kind.vendor}</td>
      <td className="px-3 py-2 text-right">
        {kind.autoApprovable ? (
          <Switch
            checked={kind.autoApprove}
            disabled={set.isPending}
            aria-label={`Auto-approve ${kind.label}`}
            onCheckedChange={(checked) => {
              if (checked) setConfirming(true);
              else void apply(false);
            }}
          />
        ) : (
          <Badge variant="outline" className="rounded-sm px-1.5 font-normal">
            Always reviewed
          </Badge>
        )}
        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Let {kind.label} apply without review?</AlertDialogTitle>
              <AlertDialogDescription>
                This loosens the approval policy: under Balanced, agents' and automations'{" "}
                {kind.label.toLowerCase()} actions are carried out at once instead of waiting in
                Approvals. The gatekeeper marks this kind as safe to auto-approve. You can turn it
                off again at any time; the change is audited.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(event) => {
                  event.preventDefault();
                  void apply(true);
                }}
                disabled={set.isPending}
              >
                Auto-approve
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </td>
    </tr>
  );
}
