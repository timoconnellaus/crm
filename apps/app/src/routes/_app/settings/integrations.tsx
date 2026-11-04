// Settings → Integrations (stage 6a, ADRs 0050–0052): my connections and the org's, each with
// its status, sharing level, resources and sync; the integrations this deployment offers, with
// Connect (and, for admins, enable switches); and for admins the internal domains sync excludes
// and which outbound action kinds may auto-apply.
import { Checkbox } from "@crm/ui/components/checkbox";
import { Label } from "@crm/ui/components/label";
import { Skeleton } from "@crm/ui/components/skeleton";
import { createFileRoute } from "@tanstack/react-router";
import { Building2Icon, PlugZapIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { EmptyState, ErrorState } from "#/components/empty-state";
import { InternalDomains, OutboundKinds } from "#/components/integrations/admin-settings";
import { AvailableIntegrations, type CatalogueItem } from "#/components/integrations/catalogue";
import { type Connection, ConnectionCard } from "#/components/integrations/connection-card";
import { useConnectFlow } from "#/components/integrations/use-connect";
import { PageLayout } from "#/components/layout/page-layout";
import { useOp } from "#/lib/query";

export const Route = createFileRoute("/_app/settings/integrations")({
  component: IntegrationsPage,
});

function IntegrationsPage() {
  const { isAdmin, user } = Route.useRouteContext();
  const [includeDisconnected, setIncludeDisconnected] = useState(false);
  const flow = useConnectFlow();
  const catalogue = useOp("integration.catalogue", {});
  const mine = useOp("connection.list", { scope: "mine", includeDisconnected });
  const org = useOp("connection.list", { scope: "org", includeDisconnected });
  const all = useOp("connection.list", { scope: "all", includeDisconnected }, { enabled: isAdmin });
  const syncsOf = (vendor: string): CatalogueItem["syncs"] =>
    catalogue.data?.items.find((i) => i.vendor === vendor)?.syncs ?? [];
  const others =
    all.data?.items.filter((c) => c.scope === "personal" && c.ownerUserId !== user.id) ?? [];

  const list = (
    query: typeof mine,
    items: Connection[] | undefined,
    label: string,
    empty: ReactNode,
    showOwner: boolean,
  ) => {
    if (query.isPending) return <Skeleton className="h-32" />;
    if (query.isError) {
      return (
        <ErrorState
          title="Could not load connections"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      );
    }
    if (!items?.length) return empty;
    return (
      <ul className="grid gap-3" aria-label={label}>
        {items.map((connection) => (
          <li key={connection.id}>
            <ConnectionCard
              connection={connection}
              syncs={syncsOf(connection.vendor)}
              showOwner={showOwner}
              onReconnect={flow.reconnect}
              reconnecting={flow.busy === connection.id}
            />
          </li>
        ))}
      </ul>
    );
  };

  return (
    <PageLayout
      title="Integrations"
      width="lg"
      back={{ to: "/settings", label: "Settings" }}
      description="Connect your mailbox, calendar and other services. Agents reach them only through the resources you add, outbound actions wait in Approvals, and you choose what syncs to the CRM."
      actions={
        <div className="flex items-center gap-2">
          <Checkbox
            id="include-disconnected"
            checked={includeDisconnected}
            onCheckedChange={(v) => setIncludeDisconnected(v === true)}
          />
          <Label htmlFor="include-disconnected" className="text-sm font-normal">
            Show disconnected
          </Label>
        </div>
      }
    >
      <Section id="my-connections" title="My connections">
        {list(
          mine,
          mine.data?.items,
          "My connections",
          <EmptyState
            icon={PlugZapIcon}
            title="No connections yet"
            description="Connect an integration below to sync your mail and meetings or let your agents use it."
          />,
          false,
        )}
      </Section>
      <Section
        id="org-connections"
        title="Org connections"
        description="Shared by everyone, set up by admins: a shared inbox, the company Slack, ZoomInfo."
      >
        {list(
          org,
          org.data?.items,
          "Org connections",
          <EmptyState
            icon={Building2Icon}
            title="No org connections"
            description={
              isAdmin
                ? "Use “Connect for the org” below to share an integration with everyone."
                : "Admins can connect integrations for everyone."
            }
          />,
          true,
        )}
      </Section>
      {isAdmin && others.length > 0 && (
        <Section
          id="others-connections"
          title="Other people's connections"
          description="Personal connections of other users. Only their owners can change them."
        >
          {list(all, others, "Other people's connections", null, true)}
        </Section>
      )}
      <Section id="available-integrations" title="Available integrations">
        <AvailableIntegrations isAdmin={isAdmin} onConnect={flow.connect} busy={flow.busy} />
      </Section>
      {isAdmin && (
        <>
          <Section
            id="sync-settings"
            title="Sync settings"
            description="Applies to every mailbox and calendar that syncs."
          >
            <InternalDomains />
          </Section>
          <Section
            id="outbound-kinds"
            title="Outbound action auto-approval"
            description="Under Balanced, every outbound action waits for review, except kinds the gatekeeper marks safe and you turn on here."
          >
            <OutboundKinds />
          </Section>
        </>
      )}
    </PageLayout>
  );
}

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="grid min-w-0 gap-3" aria-labelledby={id}>
      <div className="grid gap-0.5">
        <h2 id={id} className="text-lg font-semibold">
          {title}
        </h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}
