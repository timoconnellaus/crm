// Settings → Integrations' "Available integrations": the gatekeepers this release ships
// (integration.catalogue). Members connect enabled ones; admins enable them per deployment
// (integration.setVendor) and set web search's mode (off / optional per user / on for everyone).
import type { CoreOutput } from "@relationship-os/core";
import { Badge } from "@relationship-os/ui/components/badge";
import { Button } from "@relationship-os/ui/components/button";
import { Label } from "@relationship-os/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@relationship-os/ui/components/select";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { Switch } from "@relationship-os/ui/components/switch";
import { Building2Icon, PlugIcon } from "lucide-react";
import { useId } from "react";
import { toast } from "sonner";
import { ErrorState } from "#/components/empty-state";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";
import type { ConnectRequest } from "./use-connect.ts";

export type CatalogueItem = CoreOutput<"integration.catalogue">["items"][number];
type Mode = NonNullable<CatalogueItem["mode"]>;

const MODES: { value: Mode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "optional", label: "Optional (each person turns it on)" },
  { value: "on", label: "On for everyone" },
];

export function AvailableIntegrations({
  isAdmin,
  onConnect,
  busy,
}: {
  isAdmin: boolean;
  onConnect: (request: ConnectRequest) => void;
  busy: string | null;
}) {
  const catalogue = useOp("integration.catalogue", {});
  if (catalogue.isPending) return <Skeleton className="h-40" />;
  if (catalogue.isError) {
    return (
      <ErrorState
        title="Could not load integrations"
        error={catalogue.error}
        onRetry={() => void catalogue.refetch()}
      />
    );
  }
  return (
    <ul className="grid gap-3 md:grid-cols-2" aria-label="Available integrations">
      {catalogue.data.items.map((item) => (
        <CatalogueCard
          key={item.vendor}
          item={item}
          isAdmin={isAdmin}
          onConnect={onConnect}
          busy={busy}
        />
      ))}
    </ul>
  );
}

function CatalogueCard({
  item,
  isAdmin,
  onConnect,
  busy,
}: {
  item: CatalogueItem;
  isAdmin: boolean;
  onConnect: (request: ConnectRequest) => void;
  busy: string | null;
}) {
  const headingId = useId();
  const setVendor = useOpMutation("integration.setVendor");
  const usable = item.enabled && item.available;
  const oauth = item.connect === "oauth";

  async function toggle(enabled: boolean, mode?: Mode) {
    try {
      await setVendor.mutateAsync({ vendor: item.vendor, enabled, ...(mode ? { mode } : {}) });
      toast.success(`${item.title} ${enabled ? "enabled" : "disabled"}`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  // Web search (a singleton) connects per its mode: personal when optional, one org connection
  // when on. Everything else offers the scopes it supports.
  const scopes: ("personal" | "org")[] = item.singleton
    ? item.mode === "on"
      ? ["org"]
      : item.mode === "optional"
        ? ["personal"]
        : []
    : [...item.scopes];
  const connectButtons = scopes
    .filter((scope) => scope === "personal" || isAdmin)
    .map((scope) => {
      const key = `${item.vendor}:${scope}`;
      const label =
        scope === "org" ? "Connect for the org" : item.singleton ? "Turn on for me" : "Connect";
      return (
        <Button
          key={scope}
          size="sm"
          variant={scope === "org" ? "outline" : "default"}
          disabled={busy === key}
          aria-label={`${label}: ${item.title}`}
          onClick={() => onConnect({ vendor: item.vendor, scope, title: item.title, oauth })}
        >
          {scope === "org" ? <Building2Icon /> : <PlugIcon />}
          {busy === key ? "Connecting…" : label}
        </Button>
      );
    });

  return (
    <li
      className="grid min-w-0 content-start gap-3 rounded-xl border p-4"
      aria-labelledby={headingId}
      data-testid="catalogue-item"
      data-vendor={item.vendor}
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="grid min-w-0 flex-1 gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 id={headingId} className="font-semibold">
              {item.title}
            </h3>
            {!item.available && (
              <Badge variant="outline" className="rounded-sm px-1.5 font-normal">
                Not deployed
              </Badge>
            )}
            {item.devOnly && (
              <Badge variant="outline" className="rounded-sm px-1.5 font-normal">
                Development only
              </Badge>
            )}
            {item.syncs.length > 0 && (
              <Badge variant="secondary" className="rounded-sm px-1.5 font-normal">
                Syncs {item.syncs.map((k) => (k === "mail" ? "mail" : "calendar")).join(" and ")}
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">{item.description}</p>
        </div>
        {isAdmin && !item.singleton && (
          <Switch
            checked={item.enabled}
            onCheckedChange={(checked) => void toggle(checked)}
            disabled={setVendor.isPending}
            aria-label={`Enable ${item.title}`}
          />
        )}
      </div>
      {isAdmin && item.singleton && (
        <ModeSelect
          item={item}
          disabled={setVendor.isPending}
          onChange={(mode) => void toggle(mode !== "off", mode)}
        />
      )}
      {usable && connectButtons.length > 0 && (
        <div className="flex flex-wrap gap-2">{connectButtons}</div>
      )}
      {!item.enabled && (
        <p className="text-xs text-muted-foreground">
          {isAdmin ? "Turn it on to let people connect." : "Not enabled. Ask an admin."}
        </p>
      )}
      {item.enabled && !item.available && (
        <p className="text-xs text-muted-foreground">
          Enabled, but this deployment does not include its gatekeeper Worker.
        </p>
      )}
    </li>
  );
}

function ModeSelect({
  item,
  disabled,
  onChange,
}: {
  item: CatalogueItem;
  disabled: boolean;
  onChange: (mode: Mode) => void;
}) {
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>Mode</Label>
      <Select
        value={item.mode ?? "off"}
        onValueChange={(value) => onChange(value as Mode)}
        disabled={disabled}
      >
        <SelectTrigger id={id} className="w-full sm:w-72">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MODES.map((mode) => (
            <SelectItem key={mode.value} value={mode.value}>
              {mode.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
