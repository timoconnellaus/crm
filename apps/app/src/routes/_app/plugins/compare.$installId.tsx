// Compare (ADR 0347): their version, your copy and the merge, item by item, with the merged text
// editable. Apply merged, Keep mine, Take theirs. With ?resume it is the compare that "Resume
// updates" asks for first.
import type { CoreOutput } from "@relationship-os/core";
import { Button } from "@relationship-os/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@relationship-os/ui/components/card";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@relationship-os/ui/components/tabs";
import { Textarea } from "@relationship-os/ui/components/textarea";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ErrorState } from "#/components/empty-state";
import { PageLayout } from "#/components/layout/page-layout";
import { DiffLines } from "#/components/plugins/diff";
import { PLUGIN_INVALIDATES } from "#/components/plugins/install-dialog";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

export const Route = createFileRoute("/_app/plugins/compare/$installId")({
  validateSearch: (search: Record<string, unknown>): { resume?: boolean } =>
    search.resume === true ? { resume: true } : {},
  component: ComparePage,
});

type Proposal = CoreOutput<"plugin.mergeProposal">;
type View = "theirs" | "yours" | "merged";

function ComparePage() {
  const { installId } = Route.useParams();
  const { resume } = Route.useSearch();
  const navigate = useNavigate();
  const compare = useOp("plugin.compare", { id: installId });
  const propose = useOpMutation("plugin.mergeProposal", {});
  const apply = useOpMutation("plugin.applyMerge", PLUGIN_INVALIDATES);
  const reattach = useOpMutation("plugin.reattach", PLUGIN_INVALIDATES);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [view, setView] = useState<View>("merged");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const { mutateAsync } = propose;

  useEffect(() => {
    if (resume) return;
    mutateAsync({ id: installId })
      .then(setProposal)
      .catch((error: unknown) => toast.error(errorMessage(error)));
  }, [mutateAsync, installId, resume]);

  const done = (message: string) => {
    toast.success(message);
    navigate({ to: "/plugins", search: { tab: "installed" } });
  };
  const fail = (error: Error) => toast.error(errorMessage(error));
  const widening = proposal ? Object.values(proposal.widening).flat().length > 0 : false;

  function settle(action: "apply" | "theirs" | "keep") {
    if (!proposal) return;
    const items = proposal.merged.map((item) =>
      edits[item.key] === undefined
        ? item
        : { ...item, body: { ...item.body, instructions: edits[item.key] } },
    );
    apply.mutate(
      {
        id: installId,
        merge: proposal.merge,
        action,
        approveAccess: widening,
        ...(action === "apply" && Object.keys(edits).length ? { items } : {}),
      },
      { onSuccess: () => done(action === "keep" ? "Kept your copy" : "Updated"), onError: fail },
    );
  }

  const data = compare.data;
  const items = proposal?.items ?? data?.items ?? [];
  return (
    <PageLayout
      title={data ? `${data.name}: ${data.from} (yours) and ${data.to}` : "Compare"}
      back={{ to: "/plugins", label: "Plugins", search: { tab: "installed" } }}
      description={data && `${items.length} item${items.length === 1 ? "" : "s"} changed`}
      tabs={
        <Tabs value={view} onValueChange={(v) => setView(v as View)}>
          <TabsList>
            <TabsTrigger value="theirs">Their changes</TabsTrigger>
            <TabsTrigger value="yours">Your edits</TabsTrigger>
            <TabsTrigger value="merged">Merged</TabsTrigger>
          </TabsList>
        </Tabs>
      }
      actions={
        resume ? (
          <Button
            size="sm"
            disabled={!data}
            onClick={() =>
              reattach.mutate(
                { id: installId, compared: data?.to ?? "" },
                { onSuccess: () => done("Following updates again"), onError: fail },
              )
            }
          >
            Resume updates
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button size="sm" disabled={!proposal} onClick={() => settle("apply")}>
              Apply merged
            </Button>
            <Button size="sm" variant="outline" disabled={!proposal} onClick={() => settle("keep")}>
              Keep mine
            </Button>
            <Button size="sm" variant="ghost" disabled={!proposal} onClick={() => settle("theirs")}>
              Take theirs
            </Button>
          </div>
        )
      }
    >
      {compare.isPending && <Skeleton className="h-48 w-full" />}
      {compare.isError && <ErrorState error={compare.error} />}
      {widening && (
        <p className="mb-3 text-sm text-amber-700 dark:text-amber-300">
          This version asks for more access. Applying it agrees to that.
        </p>
      )}
      <div className="grid gap-3" data-testid="plugin-compare">
        {items.map((item) => {
          const merged = proposal?.merged.find((m) => m.key === item.key);
          const text = merged?.body.instructions;
          return (
            <Card key={item.key}>
              <CardHeader>
                <CardTitle>{item.label}</CardTitle>
              </CardHeader>
              <CardContent>
                {view === "merged" && typeof text === "string" ? (
                  <Textarea
                    aria-label={`Merged ${item.label}`}
                    rows={Math.min(14, text.split("\n").length + 1)}
                    value={edits[item.key] ?? text}
                    onChange={(e) => setEdits({ ...edits, [item.key]: e.target.value })}
                  />
                ) : (
                  <DiffLines lines={item[view]} />
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </PageLayout>
  );
}
