// Duplicates (stage 16, ADR 0247): likely duplicates found by the scan, by plain rules with a
// stated reason and no score. Review them side by side, merge one at a time through the merge
// dialog or several at once (duplicate.mergeMany), or say they are not duplicates.
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@relationship-os/ui/components/alert-dialog";
import { Button } from "@relationship-os/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@relationship-os/ui/components/select";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@relationship-os/ui/components/tabs";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CopyIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  type BulkProgress,
  type BulkResult,
  type MergeGroup,
  runBulkMerge,
} from "#/components/duplicates/bulk";
import { type DuplicateGroup, DuplicateGroupCard } from "#/components/duplicates/duplicate-group";
import { EmptyState, ErrorState } from "#/components/empty-state";
import { PageCount, PageLayout } from "#/components/layout/page-layout";
import { MergeDialog } from "#/components/merge/merge-dialog";
import { errorMessage, invalidateAfterWrite, useOp, useOpMutation } from "#/lib/query";

type DuplicateObject = "person" | "organisation";
type Rule =
  | "same_name_organisation"
  | "same_name_email_domain"
  | "same_phone"
  | "same_name_only"
  | "same_domain"
  | "same_name";

export const Route = createFileRoute("/_app/duplicates")({
  validateSearch: (search: Record<string, unknown>): { tab?: "organisations" } =>
    search.tab === "organisations" ? { tab: "organisations" } : {},
  component: DuplicatesPage,
});

const RULES: Record<DuplicateObject, { value: Rule; label: string }[]> = {
  person: [
    { value: "same_name_organisation", label: "Same name and organisation" },
    { value: "same_name_email_domain", label: "Same name and email domain" },
    { value: "same_phone", label: "Same phone number" },
    { value: "same_name_only", label: "Same name only" },
  ],
  organisation: [
    { value: "same_domain", label: "Same domain" },
    { value: "same_name", label: "Same name" },
  ],
};

const WRITES = ["duplicate.", "person.", "organisation.", "affiliation.", "task."];

function DuplicatesPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const object: DuplicateObject = search.tab === "organisations" ? "organisation" : "person";
  const count = useOp("duplicate.count", {});
  return (
    <PageLayout
      title="Duplicates"
      count={
        <PageCount value={count.data?.[object]} isPending={count.isPending} noun="open pairs" />
      }
      width="lg"
      description="Records that look like the same person or organisation, and why. Nothing merges until you say so."
      tabs={
        <Tabs
          value={object}
          onValueChange={(next) =>
            navigate({ search: next === "organisation" ? { tab: "organisations" } : {} })
          }
        >
          <TabsList>
            <TabsTrigger value="person">People</TabsTrigger>
            <TabsTrigger value="organisation">Organisations</TabsTrigger>
          </TabsList>
        </Tabs>
      }
    >
      <Review key={object} object={object} />
    </PageLayout>
  );
}

function Review({ object }: { object: DuplicateObject }) {
  const client = useQueryClient();
  const [rule, setRule] = useState<Rule | "all">("all");
  const list = useOp("duplicate.list", {
    object,
    limit: 100,
    ...(rule === "all" ? {} : { rule }),
  });
  const dismiss = useOpMutation("duplicate.dismiss", { invalidates: WRITES });
  const [choices, setChoices] = useState<Map<string, boolean>>(new Map());
  const [survivors, setSurvivors] = useState<Map<string, string>>(new Map());
  const [merging, setMerging] = useState<string[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [progress, setProgress] = useState<BulkProgress | null>(null);
  const [outcome, setOutcome] = useState<(BulkResult & { titles: Map<string, string> }) | null>(
    null,
  );

  const groups = list.data?.groups ?? [];
  const isSelected = (g: DuplicateGroup) => choices.get(g.id) ?? g.preselected;
  const survivorOf = (g: DuplicateGroup) => {
    const chosen = survivors.get(g.id);
    return chosen && g.members.some((m) => m.id === chosen) ? chosen : g.survivorId;
  };
  const likely = groups.filter((g) => g.kind === "likely");
  const nameOnly = groups.filter((g) => g.kind === "nameOnly");
  const selected = groups.filter(isSelected);
  const mergeCount = selected.reduce((n, g) => n + g.members.length - 1, 0);
  const busy = progress !== null;
  const noun = (n: number) =>
    object === "person"
      ? n === 1
        ? "duplicate person"
        : "duplicate people"
      : n === 1
        ? "duplicate organisation"
        : "duplicate organisations";

  async function onDismiss(ids: string[]) {
    try {
      await dismiss.mutateAsync({ object, ids });
      toast.success("Marked as not duplicates. They won't be suggested again.");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function onBulkMerge() {
    setConfirming(false);
    setOutcome(null);
    const titles = new Map(groups.flatMap((g) => g.members.map((m) => [m.id, m.title] as const)));
    const batch: MergeGroup[] = selected.map((g) => {
      const survivorId = survivorOf(g);
      return {
        survivorId,
        mergedIds: g.members.map((m) => m.id).filter((id) => id !== survivorId),
      };
    });
    const result = await runBulkMerge(object, batch, setProgress);
    setProgress(null);
    setChoices(new Map());
    setOutcome({ ...result, titles });
    await invalidateAfterWrite(client, "duplicate.mergeMany", WRITES);
    if (result.merged) toast.success(`Merged ${result.merged} ${noun(result.merged)}`);
  }

  const card = (group: DuplicateGroup) => (
    <li key={group.id}>
      <DuplicateGroupCard
        object={object}
        group={group}
        selected={isSelected(group)}
        survivorId={survivorOf(group)}
        busy={busy || dismiss.isPending}
        onSelect={(next) => setChoices((m) => new Map(m).set(group.id, next))}
        onSurvivor={(id) => setSurvivors((m) => new Map(m).set(group.id, id))}
        onMerge={() => {
          const survivorId = survivorOf(group);
          const other = group.members.find((m) => m.id !== survivorId);
          if (other) setMerging([survivorId, other.id]);
        }}
        onDismiss={(ids) => void onDismiss(ids)}
      />
    </li>
  );

  return (
    <div className="grid min-w-0 gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={rule} onValueChange={(next) => setRule(next as Rule | "all")}>
          <SelectTrigger className="w-64 max-w-full" aria-label="Filter by rule">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All rules</SelectItem>
            {RULES[object].map((r) => (
              <SelectItem key={r.value} value={r.value}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex-1" />
        {progress ? (
          <p role="status" className="text-sm text-muted-foreground">
            Merging {progress.done} of {progress.total}…
          </p>
        ) : (
          <Button disabled={!mergeCount} onClick={() => setConfirming(true)}>
            {mergeCount ? `Merge ${mergeCount} selected` : "Merge selected"}
          </Button>
        )}
      </div>

      {outcome && <BulkOutcome outcome={outcome} onClose={() => setOutcome(null)} />}

      {list.isPending ? (
        <Skeleton className="h-48 rounded-xl" />
      ) : list.isError ? (
        <ErrorState
          title="Could not load duplicates"
          error={list.error}
          onRetry={() => void list.refetch()}
        />
      ) : groups.length === 0 ? (
        <EmptyState
          icon={CopyIcon}
          title="No possible duplicates"
          description="A scan runs every night and after each import. Anything that looks like a duplicate shows up here."
        />
      ) : (
        <>
          {likely.length > 0 && (
            <ul className="grid gap-3" aria-label="Likely duplicates">
              {likely.map(card)}
            </ul>
          )}
          {nameOnly.length > 0 && (
            <section className="grid min-w-0 gap-3" aria-labelledby="name-only">
              <div>
                <h2 id="name-only" className="text-lg font-semibold">
                  Same name only
                </h2>
                <p className="text-sm text-muted-foreground">
                  These share a name and nothing else, so they aren't selected for you.
                </p>
              </div>
              <ul className="grid gap-3" aria-label="Same name only">
                {nameOnly.map(card)}
              </ul>
            </section>
          )}
          {list.data.total > groups.length && (
            <p className="text-sm text-muted-foreground">
              Showing {groups.length} of {list.data.total} groups. Merge or dismiss these to see the
              rest.
            </p>
          )}
          {list.data.truncated && (
            <p className="text-sm text-muted-foreground">
              There are more pairs than this page reads. Filter by rule to see the rest.
            </p>
          )}
        </>
      )}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Merge {mergeCount} {noun(mergeCount)}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Each one is folded into the record you chose to keep. Its values fill only what the
              kept record leaves empty. Merged records stay in Trash for 30 days.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onBulkMerge()}>Merge</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <MergeDialog
        object={object}
        open={merging !== null}
        onOpenChange={(next) => {
          if (!next) setMerging(null);
        }}
        ids={merging ?? []}
        stayOnPage
      />
    </div>
  );
}

function BulkOutcome({
  outcome,
  onClose,
}: {
  outcome: BulkResult & { titles: Map<string, string> };
  onClose: () => void;
}) {
  const { merged, queued, failed, titles } = outcome;
  return (
    <section
      className="grid gap-2 rounded-xl border p-3 text-sm"
      aria-label="Bulk merge result"
      data-testid="bulk-merge-result"
    >
      <p>
        {merged} merged
        {queued > 0 && `, ${queued} waiting for review`}
        {failed.length > 0 && `, ${failed.length} could not be merged`}.
      </p>
      {queued > 0 && (
        <p>
          <Link to="/approvals" className="underline underline-offset-4">
            Open Approvals
          </Link>
        </p>
      )}
      {failed.length > 0 && (
        <ul className="grid gap-1">
          {failed.map((f) => (
            <li key={f.id}>
              <span className="font-medium">{titles.get(f.id) ?? f.id}</span>: {f.message}
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    </section>
  );
}
