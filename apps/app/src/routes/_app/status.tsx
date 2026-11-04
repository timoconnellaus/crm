// System status: the /api/health report and the hello-world Workflow (stage 0 smoke test).

import { Badge } from "@crm/ui/components/badge";
import { Button } from "@crm/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@crm/ui/components/card";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { PageLayout } from "#/components/layout/page-layout";
import {
  getHelloWorkflowStatus,
  getSystemHealth,
  startHelloWorkflow,
} from "../../server/system.ts";

export const Route = createFileRoute("/_app/status")({
  loader: () => getSystemHealth(),
  component: StatusPage,
});

function Ok({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Badge variant={ok ? "default" : "destructive"} data-testid={`status-${label}`} data-ok={ok}>
      {ok ? "OK" : "Failing"}
    </Badge>
  );
}

function StatusPage() {
  const health = Route.useLoaderData();
  const router = useRouter();
  const [workflow, setWorkflow] = useState<string>("not started");

  async function runWorkflow() {
    setWorkflow("starting");
    const { id } = await startHelloWorkflow({ data: { name: "smoke test" } });
    for (let i = 0; i < 60; i++) {
      const status = await getHelloWorkflowStatus({ data: { id } });
      setWorkflow(status.status);
      if (status.status === "complete" || status.status === "errored") {
        if (status.output) setWorkflow(`complete: ${status.output.greeting}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  return (
    <PageLayout
      title="System status"
      width="md"
      actions={
        <Button variant="outline" size="sm" onClick={() => router.invalidate()}>
          Refresh
        </Button>
      }
    >
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Health <Ok ok={health.status === "ok"} label="overall" />
          </CardTitle>
          <CardDescription>
            Version {health.version} · commit {health.commit.slice(0, 12)} · identity{" "}
            {health.identityProvider}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <div className="flex items-center justify-between">
            <span>
              Database migrations
              {"latest" in health.database && (
                <span className="text-muted-foreground">
                  {" "}
                  · {health.database.latest ?? "none"} · schema v
                  {health.database.schemaVersion ?? "?"}
                </span>
              )}
            </span>
            <Ok ok={health.database.ok} label="database" />
          </div>
          <div className="flex items-center justify-between">
            <span>
              Runner ping
              {health.runner.ok && (
                <span className="text-muted-foreground"> · {health.runner.latencyMs} ms</span>
              )}
            </span>
            <Ok ok={health.runner.ok} label="runner" />
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Hello Workflow</CardTitle>
          <CardDescription>Runs crm-runner's hello-world Workflow.</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-4 text-sm">
          <span data-testid="workflow-status">{workflow}</span>
          <Button onClick={runWorkflow}>Run workflow</Button>
        </CardContent>
      </Card>
    </PageLayout>
  );
}
