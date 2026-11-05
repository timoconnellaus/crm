// Settings → Notifications → Delivery (stage 6b, ADR 0172), human admins only: the org
// connections notification email and Slack go out through, when unread "Approvals waiting"
// notices escalate and on which channels, and the hour of the daily digest. Each send is an
// outbound action, so under Balanced it waits in Approvals until the internal kinds are set to
// auto-approve on Settings → Integrations: the page says so.
import type { CoreOutput } from "@crm/core";
import { CHANNEL_RESOURCE_PATTERNS, CHANNEL_VENDORS } from "@crm/core/client";
import { Button } from "@crm/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@crm/ui/components/card";
import { Checkbox } from "@crm/ui/components/checkbox";
import { Input } from "@crm/ui/components/input";
import { Label } from "@crm/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@crm/ui/components/select";
import { Skeleton } from "@crm/ui/components/skeleton";
import { createFileRoute, Link } from "@tanstack/react-router";
import { InfoIcon, LockIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ErrorState } from "#/components/empty-state";
import { PageLayout, SaveBar } from "#/components/layout/page-layout";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

export const Route = createFileRoute("/_app/settings/notification-delivery")({
  component: NotificationDeliveryPage,
});

type Settings = CoreOutput<"notification.deliverySettings">;
type Channel = "email" | "slack";
type Connection = CoreOutput<"connection.list">["items"][number];

const NONE = "__none__";
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const CHANNEL_LABELS: Record<Channel, string> = { email: "Email", slack: "Slack" };

function NotificationDeliveryPage() {
  const { isAdmin } = Route.useRouteContext();
  return isAdmin ? (
    <DeliverySettingsForm />
  ) : (
    <PageLayout
      title="Notification delivery"
      width="md"
      back={{ to: "/settings/notifications", label: "Notifications" }}
    >
      <p
        className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm"
        role="note"
      >
        <LockIcon className="size-4" aria-hidden />
        Only admins can see and change how notifications are delivered.
      </p>
    </PageLayout>
  );
}

/** Org connections that can carry a channel: an allowed vendor with a sender / workspace bound. */
function candidates(connections: Connection[] | undefined, channel: Channel): Connection[] {
  return (connections ?? []).filter(
    (c) =>
      c.scope === "org" &&
      CHANNEL_VENDORS[channel].includes(c.vendor) &&
      c.resources.some((r) => CHANNEL_RESOURCE_PATTERNS[channel].includes(r.pattern)),
  );
}

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

function DeliverySettingsForm() {
  const settings = useOp("notification.deliverySettings", {});
  const connections = useOp("connection.list", { scope: "org", includeDisconnected: false });
  const save = useOpMutation("notification.updateDeliverySettings", {
    invalidates: ["notification."],
  });
  const [draft, setDraft] = useState<Partial<Settings>>({});
  const [minutesText, setMinutesText] = useState<string | null>(null);

  const current = settings.data;
  const value = <K extends keyof Settings>(key: K): Settings[K] | undefined =>
    (draft[key] as Settings[K] | undefined) ?? current?.[key];
  const minutes = minutesText === null ? value("escalationMinutes") : Number(minutesText);
  const minutesValid =
    minutes !== undefined && Number.isInteger(minutes) && (minutes === 0 || minutes >= 5);
  const changes: Partial<Settings> = { ...draft };
  if (minutesText !== null && minutesValid) changes.escalationMinutes = minutes;
  const dirty =
    current !== undefined &&
    (Object.entries(changes) as [keyof Settings, unknown][]).some(
      ([k, v]) => JSON.stringify(v) !== JSON.stringify(current[k]),
    );

  function reset() {
    setDraft({});
    setMinutesText(null);
  }

  async function onSave() {
    if (!minutesValid) return;
    const { problems: _problems, ...input } = changes as Settings;
    try {
      await save.mutateAsync(input);
      toast.success("Notification delivery saved");
      reset();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const escalationChannels = value("escalationChannels") ?? [];

  return (
    <PageLayout
      title="Notification delivery"
      width="md"
      back={{ to: "/settings/notifications", label: "Notifications" }}
      description="How notifications leave the CRM: the org connections email and Slack go out through, escalation of unread approvals and the daily digest."
      footer={
        <SaveBar dirty={dirty || save.isPending}>
          <Button variant="ghost" onClick={reset}>
            Cancel
          </Button>
          <Button
            onClick={() => void onSave()}
            disabled={!dirty || !minutesValid || save.isPending}
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </SaveBar>
      }
    >
      {settings.isPending || connections.isPending ? (
        <Skeleton className="h-72" />
      ) : settings.isError ? (
        <ErrorState
          title="Could not load the delivery settings"
          error={settings.error}
          onRetry={() => void settings.refetch()}
        />
      ) : (
        <div className="grid gap-6">
          <p
            className="flex items-start gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm"
            role="note"
            data-testid="auto-approve-hint"
          >
            <InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              Every email or Slack message is an outbound action. Under Balanced each one waits in
              Approvals until you let internal email and Slack DMs apply without review under{" "}
              <Link to="/settings/integrations" hash="outbound-kinds" className="underline">
                Outbound action auto-approval
              </Link>
              .
            </span>
          </p>
          {settings.data.problems.length > 0 && (
            <ul
              className="grid gap-1 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm"
              role="alert"
              data-testid="delivery-problems"
            >
              {settings.data.problems.map((problem) => (
                <li key={problem} className="flex items-start gap-2">
                  <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
                  {problem}
                </li>
              ))}
            </ul>
          )}
          <Card>
            <CardHeader>
              <CardTitle>Channels</CardTitle>
              <CardDescription>
                Pick the org connection each channel goes out through. Email needs an Email sending
                connection with a sender address; Slack needs a Slack connection with posting. Set
                them up under{" "}
                <Link to="/settings/integrations" className="underline">
                  Integrations
                </Link>
                .
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {(["email", "slack"] as const).map((channel) => {
                const options = candidates(connections.data?.items, channel);
                const selected = value(channel) ?? null;
                const known = options.some((o) => o.id === selected);
                return (
                  <div key={channel} className="grid gap-1.5">
                    <Label htmlFor={`delivery-${channel}`}>
                      {CHANNEL_LABELS[channel]} connection
                    </Label>
                    <Select
                      value={selected ?? NONE}
                      onValueChange={(v) =>
                        setDraft((d) => ({ ...d, [channel]: v === NONE ? null : v }))
                      }
                    >
                      <SelectTrigger id={`delivery-${channel}`} className="w-full sm:w-96">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>Off</SelectItem>
                        {selected && !known && (
                          <SelectItem value={selected}>{selected} (unavailable)</SelectItem>
                        )}
                        {options.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.title}
                            {c.accountLabel ? ` · ${c.accountLabel}` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {!options.length && (
                      <p className="text-xs text-muted-foreground">
                        No org connection can send {channel === "email" ? "email" : "to Slack"} yet.
                      </p>
                    )}
                  </div>
                );
              })}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Escalation</CardTitle>
              <CardDescription>
                An "Approvals waiting" notice still unread after this many minutes also goes out on
                the channels below, unless it already did by preference. 0 turns escalation off.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="delivery-escalation">Minutes</Label>
                <Input
                  id="delivery-escalation"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1}
                  className="w-full sm:w-40"
                  value={minutesText ?? String(current?.escalationMinutes ?? 0)}
                  onChange={(event) => setMinutesText(event.target.value)}
                  aria-invalid={!minutesValid || undefined}
                />
                {!minutesValid && (
                  <p className="text-xs text-destructive">0 (off) or at least 5 minutes.</p>
                )}
              </div>
              <fieldset className="grid gap-2">
                <legend className="mb-1 text-sm font-medium">Escalate by</legend>
                {(["email", "slack"] as const).map((channel) => (
                  <div key={channel} className="flex items-center gap-2">
                    <Checkbox
                      id={`escalate-${channel}`}
                      checked={escalationChannels.includes(channel)}
                      onCheckedChange={(v) =>
                        setDraft((d) => ({
                          ...d,
                          escalationChannels:
                            v === true
                              ? [...new Set([...escalationChannels, channel])]
                              : escalationChannels.filter((c) => c !== channel),
                        }))
                      }
                    />
                    <Label htmlFor={`escalate-${channel}`} className="font-normal">
                      {channel === "email" ? "Email" : "Slack DM"}
                    </Label>
                  </div>
                ))}
              </fieldset>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Daily digest</CardTitle>
              <CardDescription>
                The hour the digest goes out to people who asked for it, in the automation timezone
                (
                <Link to="/settings/automations" className="underline">
                  Settings → Automations
                </Link>
                ).
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-1.5">
              <Label htmlFor="delivery-digest-hour">Hour</Label>
              <Select
                value={String(value("digestHour") ?? 8)}
                onValueChange={(v) => setDraft((d) => ({ ...d, digestHour: Number(v) }))}
              >
                <SelectTrigger id="delivery-digest-hour" className="w-full sm:w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {HOURS.map((hour) => (
                    <SelectItem key={hour} value={String(hour)}>
                      {hourLabel(hour)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>
        </div>
      )}
    </PageLayout>
  );
}
