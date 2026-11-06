// Settings → Duplicates (admins; stage 16, ADR 0247): when the scan last ran, Scan now (a full
// scan, one bounded call at a time), and how many people may share a phone number before it stops
// counting as a match.
import { Button } from "@relationship-os/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@relationship-os/ui/components/card";
import { Input } from "@relationship-os/ui/components/input";
import { Label } from "@relationship-os/ui/components/label";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { LockIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { PageLayout } from "#/components/layout/page-layout";
import { formatDateTime } from "#/lib/format";
import { callOp } from "#/lib/operations";
import { errorMessage, invalidateOps, useOp, useOpMutation } from "#/lib/query";

export const Route = createFileRoute("/_app/settings/duplicates")({
  component: DuplicateSettingsPage,
});

/** Calls until the scan reports done; the runner carries on if the page is closed. */
const MAX_SCAN_CALLS = 200;

function DuplicateSettingsPage() {
  const { isAdmin } = Route.useRouteContext();
  return (
    <PageLayout
      title="Duplicates"
      width="md"
      back={{ to: "/settings", label: "Settings" }}
      description="The scan that looks for duplicates, and what counts as a match."
    >
      {isAdmin ? (
        <>
          <ScanCard />
          <PhoneCard />
        </>
      ) : (
        <p
          className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm"
          role="note"
        >
          <LockIcon className="size-4" aria-hidden />
          Only admins can change duplicate settings.
        </p>
      )}
    </PageLayout>
  );
}

function ScanCard() {
  const client = useQueryClient();
  const settings = useOp("duplicate.settings", {});
  const [running, setRunning] = useState(false);
  const status = settings.data?.status;

  async function scanNow() {
    setRunning(true);
    try {
      let result = await callOp("duplicate.scan", { mode: "full" });
      // The first call may be the name-key backfill, which leaves the full scan still to start.
      for (let i = 0; i < MAX_SCAN_CALLS && !result.done; i++) {
        const mode = result.ran.includes("backfill") ? "full" : "continue";
        result = await callOp("duplicate.scan", { mode });
      }
      await invalidateOps(client, "duplicate.");
      toast.success(result.done ? "Scan finished" : "Scan still running in the background");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Scan</CardTitle>
        <CardDescription>
          Records changed since the last scan are checked every night and after each import. Scan
          now checks every record.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {status ? (
          <dl className="grid gap-1 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Last full scan</dt>
              <dd data-testid="last-full-scan">
                {status.lastFullAt ? formatDateTime(status.lastFullAt) : "Not yet"}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Last nightly scan</dt>
              <dd>
                {status.lastIncrementalAt ? formatDateTime(status.lastIncrementalAt) : "Not yet"}
              </dd>
            </div>
          </dl>
        ) : (
          <Skeleton className="h-10" />
        )}
        <div>
          <Button onClick={() => void scanNow()} disabled={running}>
            {running ? "Scanning…" : "Scan now"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function PhoneCard() {
  const settings = useOp("duplicate.settings", {});
  const update = useOpMutation("duplicate.updateSettings");
  const limit = settings.data?.settings.phoneShareLimit;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = Number(new FormData(event.currentTarget).get("phoneShareLimit"));
    try {
      await update.mutateAsync({ phoneShareLimit: value });
      toast.success("Saved. The next scan uses it.");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Shared phone numbers</CardTitle>
        <CardDescription>
          A number held by more people than this is not used for matching, so a shared office line
          doesn't flood your suggestions.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {limit === undefined ? (
          <Skeleton className="h-10" />
        ) : (
          <form onSubmit={onSubmit} className="flex items-end gap-2" key={limit}>
            <div className="grid gap-2">
              <Label htmlFor="phone-share-limit">People per number</Label>
              <Input
                id="phone-share-limit"
                name="phoneShareLimit"
                type="number"
                min={1}
                max={50}
                required
                defaultValue={limit}
                className="w-28"
              />
            </div>
            <Button type="submit" variant="outline" disabled={update.isPending}>
              {update.isPending ? "Saving…" : "Save"}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
