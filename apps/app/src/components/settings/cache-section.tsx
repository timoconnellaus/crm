// Settings → AI's prompt cache and compaction card (ADR 0341): the cache lifetime in use per
// provider and model, read-only, the admin rails, and the review export for `pnpm ai:replay-cache`.
// Admins only; the rails change through the audited ai.updateCacheRails.
import type { CoreOutput } from "@relationship-os/core";
import { Badge } from "@relationship-os/ui/components/badge";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@relationship-os/ui/components/table";
import { DownloadIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { downloadText } from "#/components/list/export-csv";
import { callOp } from "#/lib/operations";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

const SOURCE_LABELS = {
  published: "Published",
  learned: "Learned",
  fallback: "Not known yet",
} as const;

function lifetime(seconds: number | null): string {
  if (seconds === null) return "Not known yet";
  if (seconds < 120) return `${Math.round(seconds)} seconds`;
  return `${Math.round(seconds / 60)} minutes`;
}

function percent(share: number | null): string {
  return share === null ? "" : `${Math.round(share * 100)}%`;
}

export function CacheSection() {
  const settings = useOp("ai.cacheSettings", {});
  const data = settings.data;
  return (
    <Card data-testid="ai-cache">
      <CardHeader>
        <CardTitle>Prompt cache and compaction</CardTitle>
        <CardDescription>
          How long each provider keeps a prompt cached, and when the assistant shortens its chat.
          Between the two limits below it compacts only when that costs less.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        {settings.isPending ? (
          <Skeleton className="h-32 w-full" />
        ) : settings.isError || !data ? (
          <p className="text-sm text-destructive" role="alert">
            {errorMessage(settings.error)}
          </p>
        ) : (
          <>
            <Estimates estimates={data.estimates} />
            <RailsForm key={JSON.stringify(data.rails)} rails={data.rails} />
            <ReportButtons />
          </>
        )}
      </CardContent>
    </Card>
  );
}

type Settings = CoreOutput<"ai.cacheSettings">;

function Estimates({ estimates }: { estimates: Settings["estimates"] }) {
  if (!estimates.length) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="ai-cache-empty">
        No cache lifetimes yet. They appear once the assistant has answered a few times.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <Table aria-label="Cache lifetime per model">
        <TableHeader>
          <TableRow>
            <TableHead>Model</TableHead>
            <TableHead>Lifetime</TableHead>
            <TableHead>Source</TableHead>
            <TableHead className="text-right">Confidence</TableHead>
            <TableHead className="text-right">Samples</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {estimates.map((e) => (
            <TableRow key={`${e.provider}/${e.model}`} data-testid="ai-cache-estimate">
              <TableCell>
                {e.provider} / {e.model}
              </TableCell>
              <TableCell>{lifetime(e.seconds)}</TableCell>
              <TableCell>
                <Badge variant="outline">{SOURCE_LABELS[e.source]}</Badge>
              </TableCell>
              <TableCell className="text-right tabular-nums">{percent(e.confidence)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {Math.round(e.sampleSize).toLocaleString()}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function RailsForm({ rails }: { rails: Settings["rails"] }) {
  const update = useOpMutation("ai.updateCacheRails", { invalidates: ["ai."] });
  const [minTokens, setMinTokens] = useState(String(rails.minTokens));
  const [share, setShare] = useState(String(Math.round(rails.maxShareOfWindow * 100)));
  const [minutes, setMinutes] = useState(String(rails.fallbackIdleMinutes));

  async function save(event: FormEvent) {
    event.preventDefault();
    try {
      await update.mutateAsync({
        minTokens: Number(minTokens),
        maxShareOfWindow: Number(share) / 100,
        fallbackIdleMinutes: Number(minutes),
      });
      toast.success("Compaction limits saved");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <form className="grid gap-3" onSubmit={save} aria-label="Compaction limits">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor="cache-min-tokens">Never compact below (tokens)</Label>
          <Input
            id="cache-min-tokens"
            inputMode="numeric"
            value={minTokens}
            onChange={(e) => setMinTokens(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="cache-max-share">Always compact before (% of window)</Label>
          <Input
            id="cache-max-share"
            inputMode="numeric"
            value={share}
            onChange={(e) => setShare(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="cache-fallback">Idle wait with no lifetime (minutes)</Label>
          <Input
            id="cache-fallback"
            inputMode="numeric"
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
        </div>
      </div>
      <div>
        <Button type="submit" variant="outline" size="sm" disabled={update.isPending}>
          Save limits
        </Button>
      </div>
    </form>
  );
}

function ReportButtons() {
  const [busy, setBusy] = useState(false);

  async function download(format: "json" | "csv") {
    setBusy(true);
    try {
      const out = await callOp("ai.cacheReport", { format });
      const day = new Date().toISOString().slice(0, 10);
      if (out.format === "csv") {
        downloadText(`ai-cache-report-${day}.csv`, out.csv, "text/csv");
      } else {
        const text = JSON.stringify(out.report, null, 2);
        downloadText(`ai-cache-report-${day}.json`, text, "application/json");
      }
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2">
      <p className="text-sm text-muted-foreground">
        The review data holds sizes, prices and times, never message content. It is kept 180 days.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => download("json")}>
          <DownloadIcon aria-hidden />
          Export JSON
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => download("csv")}>
          <DownloadIcon aria-hidden />
          Export CSV
        </Button>
      </div>
    </div>
  );
}
