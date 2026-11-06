// One plugin (ADR 0347): what it adds, what is new, what it asks to reach, and Install or your copy.
import { Badge } from "@relationship-os/ui/components/badge";
import { Button } from "@relationship-os/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@relationship-os/ui/components/card";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useOptionalAssistant } from "#/components/assistant/assistant-provider";
import { ErrorState } from "#/components/empty-state";
import { PageLayout } from "#/components/layout/page-layout";
import { InstallDialog } from "#/components/plugins/install-dialog";
import { useOp } from "#/lib/query";

type Source = "first_party" | "workspace" | "marketplace";
const SOURCES: readonly string[] = ["first_party", "workspace", "marketplace"];

export const Route = createFileRoute("/_app/plugins/$id")({
  validateSearch: (search: Record<string, unknown>): { source?: Source } =>
    SOURCES.includes(search.source as string) ? { source: search.source as Source } : {},
  component: PluginPage,
});

const SOURCE_WORDS: Record<Source, string> = {
  first_party: "Built-in",
  workspace: "Your workspace",
  marketplace: "Reviewed",
};

function PluginPage() {
  const { id } = Route.useParams();
  const { source } = Route.useSearch();
  const plugin = useOp("plugin.get", { plugin: id, ...(source ? { source } : {}) });
  const assistant = useOptionalAssistant();
  const [installing, setInstalling] = useState(false);
  const manifest = plugin.data?.manifest;
  const kinds = new Map<string, NonNullable<typeof manifest>["items"]>();
  for (const item of manifest?.items ?? []) {
    kinds.set(item.kind, [...(kinds.get(item.kind) ?? []), item]);
  }
  return (
    <PageLayout
      title={manifest?.name ?? "Plugin"}
      back={{ to: "/plugins", label: "Plugins" }}
      description={
        manifest && `${manifest.publisher} · version ${manifest.version}`
      }
      titleAddon={
        plugin.data && <Badge variant="outline">{SOURCE_WORDS[plugin.data.source]}</Badge>
      }
      actions={
        manifest && (
          <div className="flex gap-2">
            {assistant && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => assistant.ask({ prompt: `What would ${manifest.name} do for me?` })}
              >
                Ask about it
              </Button>
            )}
            {!plugin.data?.installed && (
              <Button size="sm" onClick={() => setInstalling(true)}>
                Install
              </Button>
            )}
          </div>
        )
      }
    >
      {plugin.isPending && <Skeleton className="h-48 w-full" />}
      {plugin.isError && <ErrorState error={plugin.error} />}
      {manifest && (
        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <div className="grid content-start gap-4">
            <p className="text-sm">{manifest.description}</p>
            <Card>
              <CardHeader>
                <CardTitle>What it adds</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 text-sm">
                {[...kinds].map(([kind, items]) => (
                  <section key={kind} className="grid gap-1">
                    <h3 className="text-xs font-medium text-muted-foreground">
                      {kind}s · {items.length}
                    </h3>
                    {items.map((item) => (
                      <div key={item.label}>
                        <div>{item.label}</div>
                        {item.description && (
                          <div className="text-xs text-muted-foreground">{item.description}</div>
                        )}
                      </div>
                    ))}
                  </section>
                ))}
              </CardContent>
            </Card>
            {manifest.whatsNew.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>What's new in {manifest.version}</CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="list-disc pl-4 text-sm">
                    {manifest.whatsNew.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
          </div>
          <div className="grid content-start gap-4">
            {manifest.connections.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Connections</CardTitle>
                </CardHeader>
                <CardContent className="text-sm">{manifest.connections.join(", ")}</CardContent>
              </Card>
            )}
            {manifest.access.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Access it asks for</CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="list-disc pl-4 text-sm">
                    {manifest.access.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}
      {installing && manifest && plugin.data && (
        <InstallDialog
          plugin={manifest.id}
          name={manifest.name}
          source={plugin.data.source}
          onClose={() => setInstalling(false)}
        />
      )}
    </PageLayout>
  );
}
