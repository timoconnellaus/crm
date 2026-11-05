// Settings → Policy adjudicator (ADR 0031, ADR 0204): the mode (off / shadow / active), the
// confidence threshold, the written policy it judges by, a warning when the reviewer runs on the
// same model as the assistant, and how often its verdicts agree with people's decisions.
// Admins only; every change is an audited, human-only operation.

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
import { RadioGroup, RadioGroupItem } from "@relationship-os/ui/components/radio-group";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@relationship-os/ui/components/table";
import { Tabs, TabsList, TabsTrigger } from "@relationship-os/ui/components/tabs";
import { Textarea } from "@relationship-os/ui/components/textarea";
import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangleIcon, LockIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PageLayout } from "#/components/layout/page-layout";
import { formatDateTime } from "#/lib/format";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

export const Route = createFileRoute("/_app/settings/adjudicator")({
  component: AdjudicatorPage,
});

type Mode = "off" | "shadow" | "active";

const MODE_COPY: Record<Mode, { title: string; description: string }> = {
  off: {
    title: "Off",
    description: "Every change the approval policy sends to review waits for a person.",
  },
  shadow: {
    title: "Shadow",
    description:
      "The adjudicator judges each change and shows its verdict to approvers, but never acts. Use it to measure how often it agrees with you.",
  },
  active: {
    title: "Active",
    description:
      "Changes it approves at or above the confidence threshold apply without a person. Denials, escalations, low-confidence verdicts and anything the deployment floor or extension installs route to review still wait for a person.",
  },
};

function AdjudicatorPage() {
  const { isAdmin } = Route.useRouteContext();
  return (
    <PageLayout
      title="Policy adjudicator"
      width="lg"
      back={{ to: "/settings", label: "Settings" }}
      description="An AI reviewer that judges changes waiting for approval against your written policy. Its verdicts are shown to approvers only, never to the agent that asked."
    >
      {isAdmin ? (
        <AdminView />
      ) : (
        <p
          className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm"
          role="note"
        >
          <LockIcon className="size-4" aria-hidden />
          Only admins can see and change the policy adjudicator.
        </p>
      )}
    </PageLayout>
  );
}

function AdminView() {
  const settings = useOp("adjudicator.get", {});
  const update = useOpMutation("adjudicator.update");
  const setPolicy = useOpMutation("adjudicator.setPolicy");
  const [policyText, setPolicyText] = useState("");
  const [threshold, setThreshold] = useState("");

  useEffect(() => {
    if (!settings.data) return;
    setPolicyText(settings.data.policy?.text ?? "");
    setThreshold(String(settings.data.threshold));
  }, [settings.data]);

  if (settings.isPending) return <Skeleton className="h-64 rounded-xl" />;
  if (settings.isError) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {errorMessage(settings.error)}
      </p>
    );
  }
  const data = settings.data;
  const policyChanged = policyText.trim() !== (data.policy?.text ?? "").trim();
  const thresholdValue = Number(threshold);
  const thresholdValid = Number.isFinite(thresholdValue) && thresholdValue >= 0.5 && thresholdValue <= 1;
  const thresholdChanged = thresholdValid && thresholdValue !== data.threshold;

  async function changeMode(mode: Mode) {
    try {
      const out = await update.mutateAsync({ mode });
      toast.success(`Policy adjudicator: ${MODE_COPY[out.mode].title}`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function saveThreshold() {
    try {
      await update.mutateAsync({ threshold: thresholdValue });
      toast.success("Threshold saved");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function savePolicy() {
    try {
      const out = await setPolicy.mutateAsync({ text: policyText });
      toast.success(`Written policy saved (version ${out.policy?.version ?? "?"})`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <div className="grid gap-6">
      {data.sameModelAsAssistant && data.models && (
        <div
          className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
          role="alert"
          data-testid="independence-warning"
        >
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            The reviewer runs on the same model as the assistant ({data.models.review.provider}{" "}
            {data.models.review.model}). A reviewer is more independent on a different model, so
            it is less likely to share the assistant's blind spots. Change the review role in
            Settings → AI.
          </span>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Mode</CardTitle>
          <CardDescription>
            Turning it on starts in shadow mode. Switch to active once its agreement rate below
            satisfies you.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <RadioGroup
            value={data.mode}
            onValueChange={(value) => void changeMode(value as Mode)}
            disabled={update.isPending}
            aria-label="Adjudicator mode"
            className="gap-2"
          >
            {(["off", "shadow", "active"] as const).map((mode) => {
              const locked =
                (mode === "active" && data.mode === "off") || (mode !== "off" && !data.policy);
              return (
                <Label
                  key={mode}
                  htmlFor={`mode-${mode}`}
                  className="flex cursor-pointer items-start gap-3 rounded-md border p-3 font-normal has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent/50 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
                >
                  <RadioGroupItem
                    id={`mode-${mode}`}
                    value={mode}
                    disabled={locked}
                    className="mt-0.5"
                  />
                  <span className="grid gap-1">
                    <span className="flex items-center gap-2 font-medium">
                      {MODE_COPY[mode].title}
                      {mode === data.mode && <Badge variant="secondary">Current</Badge>}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {MODE_COPY[mode].description}
                      {mode === "active" && data.mode === "off" && " Start in shadow mode first."}
                      {mode !== "off" && !data.policy && " Write the policy below first."}
                    </span>
                  </span>
                </Label>
              );
            })}
          </RadioGroup>
          <div className="grid gap-1.5 sm:max-w-xs">
            <Label htmlFor="threshold">Confidence threshold</Label>
            <div className="flex gap-2">
              <Input
                id="threshold"
                type="number"
                inputMode="decimal"
                min={0.5}
                max={1}
                step={0.05}
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                aria-invalid={!thresholdValid}
              />
              <Button
                variant="outline"
                onClick={() => void saveThreshold()}
                disabled={!thresholdChanged || update.isPending}
              >
                Save
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              From 0.5 to 1. Verdicts less confident than this go to a person.
            </p>
          </div>
          {data.models && (
            <p className="text-xs text-muted-foreground">
              Reviewer model: {data.models.review.provider} {data.models.review.model}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Written policy</CardTitle>
          <CardDescription>
            Plain-language rules the adjudicator judges each change against: what may be
            approved, what must be denied, and what needs a person. Each save is a new version;
            every verdict records the version it used.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Textarea
            aria-label="Written policy"
            value={policyText}
            onChange={(e) => setPolicyText(e.target.value)}
            rows={14}
            maxLength={20_000}
            placeholder={
              "## Approve\n- Creating a person or organisation when the reason says where the details came from.\n\n## Deny\n- Deleting more than 5 records at once.\n\n## Ask a person\n- Anything else."
            }
            className="font-mono text-sm"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {data.policy
                ? `Version ${data.policy.version}, saved ${formatDateTime(data.policy.createdAt)}${data.policy.createdByName ? ` by ${data.policy.createdByName}` : ""}`
                : "No policy yet."}
            </p>
            <Button
              onClick={() => void savePolicy()}
              disabled={!policyChanged || !policyText.trim() || setPolicy.isPending}
            >
              {setPolicy.isPending ? "Saving…" : "Save policy"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <AgreementCard />
    </div>
  );
}

const pct = (n: number | null) => (n === null ? "–" : `${Math.round(n * 100)}%`);

function AgreementCard() {
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const agreement = useOp(
    "adjudicator.agreement",
    { days, bucket: days === 7 ? "day" : "week" },
    { staleTime: 0 },
  );
  return (
    <Card data-testid="agreement">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1.5">
          <CardTitle>Agreement with approvers</CardTitle>
          <CardDescription>
            How the adjudicator's verdicts compare with what people decided on the same changes.
            Agreement counts approve and deny verdicts; escalations hand the change to a person
            and count as neither.
          </CardDescription>
        </div>
        <Tabs value={String(days)} onValueChange={(v) => setDays(Number(v) as 7 | 30 | 90)}>
          <TabsList>
            <TabsTrigger value="7">7 days</TabsTrigger>
            <TabsTrigger value="30">30 days</TabsTrigger>
            <TabsTrigger value="90">90 days</TabsTrigger>
          </TabsList>
        </Tabs>
      </CardHeader>
      <CardContent className="grid gap-5">
        {agreement.isPending ? (
          <Skeleton className="h-32" />
        ) : agreement.isError ? (
          <p className="text-sm text-destructive" role="alert">
            {errorMessage(agreement.error)}
          </p>
        ) : agreement.data.count === 0 ? (
          <p className="text-sm text-muted-foreground">
            No verdicts in this period. Switch the adjudicator to shadow mode to start collecting
            them.
          </p>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Agreement" value={pct(agreement.data.agreement)} />
              <Stat label="Approve precision" value={pct(agreement.data.approvePrecision)} />
              <Stat label="Escalation rate" value={pct(agreement.data.escalationRate)} />
              <Stat
                label="Verdicts"
                value={`${agreement.data.count}`}
                hint={`${agreement.data.decided} decided by people · ${agreement.data.autoApproved} auto-approved`}
              />
            </dl>
            <div className="overflow-x-auto">
              <Table aria-label="Verdict against decision">
                <TableHeader>
                  <TableRow>
                    <TableHead>Verdict</TableHead>
                    <TableHead className="text-right">People approved</TableHead>
                    <TableHead className="text-right">People rejected</TableHead>
                    <TableHead className="text-right">Not decided by a person</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(["approve", "deny", "escalate"] as const).map((verdict) => (
                    <TableRow key={verdict}>
                      <TableCell className="capitalize">{verdict}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {agreement.data.confusion[verdict].approved}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {agreement.data.confusion[verdict].rejected}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {agreement.data.confusion[verdict].undecided}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="overflow-x-auto">
              <Table aria-label="Agreement by period">
                <TableHeader>
                  <TableRow>
                    <TableHead>{days === 7 ? "Day" : "Week of"}</TableHead>
                    <TableHead className="text-right">Verdicts</TableHead>
                    <TableHead className="text-right">Decided</TableHead>
                    <TableHead className="text-right">Agreement</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {agreement.data.periods.map((p) => (
                    <TableRow key={p.period}>
                      <TableCell>{p.period}</TableCell>
                      <TableCell className="text-right tabular-nums">{p.count}</TableCell>
                      <TableCell className="text-right tabular-nums">{p.decided}</TableCell>
                      <TableCell className="text-right tabular-nums">{pct(p.agreement)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="grid gap-0.5 rounded-md border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums">{value}</dd>
      {hint && <dd className="text-xs text-muted-foreground">{hint}</dd>}
    </div>
  );
}
