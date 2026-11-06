// Settings home: links to each settings section.
import { Card, CardDescription, CardHeader, CardTitle } from "@relationship-os/ui/components/card";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  BellIcon,
  BookmarkIcon,
  ChevronRightIcon,
  CoinsIcon,
  CreditCardIcon,
  DatabaseIcon,
  DownloadCloudIcon,
  GavelIcon,
  LifeBuoyIcon,
  ListOrderedIcon,
  MicIcon,
  PlugIcon,
  PlugZapIcon,
  PuzzleIcon,
  ScrollTextIcon,
  ShieldCheckIcon,
  SparklesIcon,
  UsersIcon,
  WorkflowIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { PageLayout } from "#/components/layout/page-layout";
import { useExtensionObjects } from "#/lib/schema";

export const Route = createFileRoute("/_app/settings/")({ component: SettingsPage });

function Section({
  icon,
  title,
  description,
  to,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  to?:
    | "/settings/approval-policy"
    | "/settings/assistant-memory"
    | "/settings/adjudicator"
    | "/settings/users"
    | "/settings/audit"
    | "/settings/connected-apps"
    | "/settings/extensions"
    | "/settings/integrations"
    | "/settings/notifications"
    | "/settings/storage"
    | "/settings/updates"
    | "/settings/ai"
    | "/settings/voice"
    | "/settings/general"
    | "/settings/automations"
    | "/settings/plan"
    | "/settings/support-access";
}) {
  const body = (
    <Card className="h-full transition-colors hover:bg-accent/50">
      <CardHeader className="flex flex-row items-start gap-3">
        <div className="mt-0.5 text-muted-foreground">{icon}</div>
        <div className="grid flex-1 gap-1">
          <CardTitle className="text-base">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        {to && <ChevronRightIcon className="size-4 text-muted-foreground" aria-hidden />}
      </CardHeader>
    </Card>
  );
  return to ? (
    <Link
      to={to}
      className="rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {body}
    </Link>
  ) : (
    <div aria-disabled className="opacity-60">
      {body}
    </div>
  );
}

/** Set-up records of extensions (navigation `settings`, e.g. Deals' pipelines and stages). */
function ExtensionSettingsObjects() {
  const objects = useExtensionObjects().filter((o) => o.navigation === "settings");
  if (!objects.length) return null;
  return (
    <section aria-label="Extension set-up" className="grid gap-3">
      <h2 className="text-sm font-medium text-muted-foreground">Set-up</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {objects.map((object) => (
          <Link
            key={object.name}
            to="/x/$object"
            params={{ object: object.name }}
            className="rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            data-testid={`settings-object-${object.name}`}
          >
            <Card className="h-full transition-colors hover:bg-accent/50">
              <CardHeader className="flex flex-row items-start gap-3">
                <div className="mt-0.5 text-muted-foreground">
                  <ListOrderedIcon className="size-5" />
                </div>
                <div className="grid flex-1 gap-1">
                  <CardTitle className="text-base">{object.plural ?? object.label}</CardTitle>
                  <CardDescription>{object.description ?? object.extension}</CardDescription>
                </div>
                <ChevronRightIcon className="size-4 text-muted-foreground" aria-hidden />
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </section>
  );
}

function SettingsPage() {
  const { isAdmin } = Route.useRouteContext();
  return (
    <PageLayout title="Settings" width="md">
      <div className="grid gap-6">
        <div className="grid gap-3 sm:grid-cols-2">
          <Section
            icon={<CoinsIcon className="size-5" />}
            title="General"
            description="Organisation name, logo, timezone and base currency; setup and sample data."
            to="/settings/general"
          />
          <Section
            icon={<MicIcon className="size-5" />}
            title="Voice"
            description="How the assistant sounds and how you talk to it."
            to="/settings/voice"
          />
          <Section
            icon={<ShieldCheckIcon className="size-5" />}
            title="Approval policy"
            description={
              isAdmin
                ? "Choose how much AI and automations may do without review."
                : "See how much AI and automations may do without review."
            }
            to="/settings/approval-policy"
          />
          <Section
            icon={<UsersIcon className="size-5" />}
            title="Users and roles"
            description={
              isAdmin
                ? "See who can sign in and set their roles."
                : "See who can sign in and their roles."
            }
            to="/settings/users"
          />
          <Section
            icon={<PlugZapIcon className="size-5" />}
            title="Integrations"
            description={
              isAdmin
                ? "Connect mailboxes, calendars and other services, choose what syncs, and enable integrations."
                : "Connect your mailbox, calendar and other services, and choose what syncs."
            }
            to="/settings/integrations"
          />
          <Section
            icon={<BellIcon className="size-5" />}
            title="Notifications"
            description={
              isAdmin
                ? "Which notifications reach you by email or Slack, the daily digest, and how the org delivers them."
                : "Which notifications reach you by email or Slack, and the daily digest."
            }
            to="/settings/notifications"
          />
          <Section
            icon={<BookmarkIcon className="size-5" />}
            title="What your assistant remembers"
            description="See, edit and pause what your assistant remembers, and the team's shared lines."
            to="/settings/assistant-memory"
          />
          <Section
            icon={<PlugIcon className="size-5" />}
            title="Connected apps"
            description={
              isAdmin
                ? "AI apps connected over MCP, yours and everyone's, with revoke."
                : "AI apps you connected over MCP, with revoke."
            }
            to="/settings/connected-apps"
          />
          <Section
            icon={<PuzzleIcon className="size-5" />}
            title="Extensions"
            description="Installed extensions, their permissions, runs and versions."
            to="/settings/extensions"
          />
          <Section
            icon={<WorkflowIcon className="size-5" />}
            title="Automations"
            description="The kill switch, the schedule timezone and the debounce window."
            to="/settings/automations"
          />
          {isAdmin && (
            <Section
              icon={<ScrollTextIcon className="size-5" />}
              title="Audit log"
              description="Every change, who made it and how."
              to="/settings/audit"
            />
          )}
          {isAdmin && (
            <Section
              icon={<GavelIcon className="size-5" />}
              title="Policy adjudicator"
              description="An AI reviewer for changes waiting for approval: your written policy, shadow mode and its agreement rate."
              to="/settings/adjudicator"
            />
          )}
          {isAdmin && (
            <Section
              icon={<SparklesIcon className="size-5" />}
              title="AI"
              description="Which model each AI feature uses, provider keys, usage and semantic search."
              to="/settings/ai"
            />
          )}
          {isAdmin && (
            <Section
              icon={<DatabaseIcon className="size-5" />}
              title="Storage"
              description="Database size against its 10 GB limit, and how long history is kept."
              to="/settings/storage"
            />
          )}
          {isAdmin && (
            <Section
              icon={<DownloadCloudIcon className="size-5" />}
              title="Updates"
              description="The installed version, new releases and their changelogs, update and roll back."
              to="/settings/updates"
            />
          )}
          {isAdmin && (
            <Section
              icon={<CreditCardIcon className="size-5" />}
              title="Plan"
              description="Your plan's limits on users, records and AI, and how much you use."
              to="/settings/plan"
            />
          )}
          {isAdmin && (
            <Section
              icon={<LifeBuoyIcon className="size-5" />}
              title="Support access"
              description="Approve, deny or revoke our support team's time-limited access."
              to="/settings/support-access"
            />
          )}
        </div>
        <ExtensionSettingsObjects />
      </div>
    </PageLayout>
  );
}
