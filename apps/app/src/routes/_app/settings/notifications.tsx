// Settings → Notifications (stage 6b, ADR 0172): your own preferences. For each notification type,
// whether it also reaches you by email or Slack DM (in-app is always on), and the daily email
// digest. A change saves at once. Channels an admin has not set up yet are shown but disabled.
// Admins also get links to the org's delivery settings and Slack channel routes.
import type { CoreOutput } from "@crm/core";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@crm/ui/components/card";
import { Checkbox } from "@crm/ui/components/checkbox";
import { Label } from "@crm/ui/components/label";
import { Skeleton } from "@crm/ui/components/skeleton";
import { Switch } from "@crm/ui/components/switch";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronRightIcon, HashIcon, SendIcon } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { ErrorState } from "#/components/empty-state";
import { PageLayout } from "#/components/layout/page-layout";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

export const Route = createFileRoute("/_app/settings/notifications")({
  component: NotificationSettingsPage,
});

type Preferences = CoreOutput<"notification.preferences">;
type TypeRow = Preferences["types"][number];
type Channel = TypeRow["channels"][number];

const CHANNELS: { id: Channel; label: string }[] = [
  { id: "email", label: "Email" },
  { id: "slack", label: "Slack DM" },
];

const CATEGORY_LABELS: Record<string, string> = {
  approvals: "Approvals",
  automations: "Automations",
  system: "Messages",
};

function NotificationSettingsPage() {
  const { isAdmin } = Route.useRouteContext();
  const prefs = useOp("notification.preferences", {});

  return (
    <PageLayout
      title="Notifications"
      width="md"
      back={{ to: "/settings", label: "Settings" }}
      description="Every notification shows in the app. Choose which also reach you by email or Slack, and whether you get a daily digest."
    >
      <div className="grid gap-6">
        {prefs.isPending ? (
          <Skeleton className="h-72" />
        ) : prefs.isError ? (
          <ErrorState
            title="Could not load your notification preferences"
            error={prefs.error}
            onRetry={() => void prefs.refetch()}
          />
        ) : (
          <>
            <PreferencesCard prefs={prefs.data} isAdmin={isAdmin} />
            <DigestCard prefs={prefs.data} />
          </>
        )}
        {isAdmin && <AdminLinks />}
      </div>
    </PageLayout>
  );
}

function PreferencesCard({ prefs, isAdmin }: { prefs: Preferences; isAdmin: boolean }) {
  const save = useOpMutation("notification.setPreferences");
  const unavailable = CHANNELS.filter((c) => !prefs.available[c.id]);

  async function toggle(row: TypeRow, channel: Channel, on: boolean) {
    const channels = on
      ? [...new Set([...row.channels, channel])]
      : row.channels.filter((c) => c !== channel);
    try {
      await save.mutateAsync({ channels: { [row.type]: channels } });
      toast.success(
        `${row.label}: ${channels.length ? `in-app and ${channels.map(channelLabel).join(" and ")}` : "in-app only"}`,
      );
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const categories = [...new Set(prefs.types.map((t) => t.category))];
  return (
    <Card data-testid="notification-preferences">
      <CardHeader>
        <CardTitle>Where notifications reach you</CardTitle>
        <CardDescription>
          In-app is always on. Email and Slack messages go out through the org's connections.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {unavailable.length > 0 && (
          <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
            {unavailable.map((c) => c.label).join(" and ")} {unavailable.length > 1 ? "are" : "is"}{" "}
            not set up yet
            {isAdmin ? (
              <>
                {" "}
                (
                <Link to="/settings/notification-delivery" className="underline">
                  set up delivery
                </Link>
                )
              </>
            ) : (
              ": an admin turns it on"
            )}
            . Your choices are kept and take effect then.
          </p>
        )}
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Notification
                </th>
                <th
                  scope="col"
                  className="hidden w-20 px-2 py-2 text-center font-medium sm:table-cell"
                >
                  In-app
                </th>
                {CHANNELS.map((c) => (
                  <th key={c.id} scope="col" className="w-20 px-2 py-2 text-center font-medium">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            {categories.map((category) => (
              <tbody key={category} className="border-t">
                <tr>
                  <th
                    scope="rowgroup"
                    colSpan={4}
                    className="bg-muted/20 px-3 pt-2 pb-1 text-left text-xs font-medium tracking-wide text-muted-foreground uppercase"
                  >
                    {CATEGORY_LABELS[category] ?? category}
                  </th>
                </tr>
                {prefs.types
                  .filter((t) => t.category === category)
                  .map((row) => (
                    <tr key={row.type} data-testid="notification-type" data-type={row.type}>
                      <th scope="row" className="px-3 py-2 text-left font-normal">
                        {row.label}
                      </th>
                      <td className="hidden px-2 py-2 text-center sm:table-cell">
                        <Checkbox checked disabled aria-label={`${row.label} in-app (always on)`} />
                      </td>
                      {CHANNELS.map((c) => (
                        <td key={c.id} className="px-2 py-2 text-center">
                          <Checkbox
                            checked={row.channels.includes(c.id)}
                            disabled={save.isPending}
                            aria-label={`${row.label} by ${c.label}`}
                            onCheckedChange={(v) => void toggle(row, c.id, v === true)}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
              </tbody>
            ))}
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function channelLabel(channel: Channel): string {
  return CHANNELS.find((c) => c.id === channel)?.label.toLowerCase() ?? channel;
}

function DigestCard({ prefs }: { prefs: Preferences }) {
  const save = useOpMutation("notification.setPreferences");
  async function set(digest: boolean) {
    try {
      await save.mutateAsync({ digest });
      toast.success(digest ? "Daily digest on" : "Daily digest off");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Daily digest</CardTitle>
        <CardDescription>
          One email a day with your unread notifications and the approvals waiting for you.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex items-center gap-3">
        <Switch
          id="notification-digest"
          checked={prefs.digest}
          disabled={save.isPending}
          onCheckedChange={(v) => void set(v)}
        />
        <Label htmlFor="notification-digest" className="font-normal">
          Email me a daily digest
        </Label>
        {!prefs.available.email && (
          <span className="text-xs text-muted-foreground">(email is not set up yet)</span>
        )}
      </CardContent>
    </Card>
  );
}

function AdminLinks() {
  return (
    <section aria-labelledby="notification-admin" className="grid gap-3">
      <h2 id="notification-admin" className="text-sm font-medium text-muted-foreground">
        For the org (admins)
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <AdminLink
          to="/settings/notification-delivery"
          icon={<SendIcon className="size-5" />}
          title="Delivery"
          description="The org connections email and Slack go out through, escalation of unread approvals and the digest hour."
        />
        <AdminLink
          to="/settings/notification-routes"
          icon={<HashIcon className="size-5" />}
          title="Slack channel routes"
          description="Post record events to Slack channels, e.g. deals won → #sales."
        />
      </div>
    </section>
  );
}

function AdminLink({
  to,
  icon,
  title,
  description,
}: {
  to: "/settings/notification-delivery" | "/settings/notification-routes";
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Link
      to={to}
      className="rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <Card className="h-full transition-colors hover:bg-accent/50">
        <CardHeader className="flex flex-row items-start gap-3">
          <div className="mt-0.5 text-muted-foreground">{icon}</div>
          <div className="grid flex-1 gap-1">
            <CardTitle className="text-base">{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          <ChevronRightIcon className="size-4 text-muted-foreground" aria-hidden />
        </CardHeader>
      </Card>
    </Link>
  );
}
