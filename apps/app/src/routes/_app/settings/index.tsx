// Settings home: links to each settings section.
import { Card, CardDescription, CardHeader, CardTitle } from "@crm/ui/components/card";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronRightIcon, ScrollTextIcon, ShieldCheckIcon, UsersIcon } from "lucide-react";
import type { ReactNode } from "react";

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
  to?: "/settings/approval-policy";
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

function SettingsPage() {
  const { isAdmin } = Route.useRouteContext();
  return (
    <div className="mx-auto grid w-full grid-cols-1 max-w-3xl gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <div className="grid gap-3 sm:grid-cols-2">
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
        {/* TODO(stage-1-wire): users and roles (user.list, user.setRole), admin only. */}
        <Section
          icon={<UsersIcon className="size-5" />}
          title="Users and roles"
          description="Coming soon: invite people and set their roles."
        />
        {/* TODO(stage-1-wire): the Audit page (audit.list), admin only. */}
        <Section
          icon={<ScrollTextIcon className="size-5" />}
          title="Audit log"
          description="Coming soon: every change, who made it and how."
        />
      </div>
    </div>
  );
}
