// Settings → AI's Judge section (stage 11 step 10, ADR 0230, ADR 0234): Jev's key status and
// route, a Test button that makes one live call, the key itself (a Workers secret, or on a hosted
// workspace a workspace secret set through the control plane), the policy adjudicator's reviewer,
// and each placement with its switch, what it sends, what happens when the judge cannot answer,
// and its spend from the judge's own count. Admins only; every change is an audited, human-only
// operation (judge.update, judge.setKey, adjudicator.update).
import type { CoreOutput } from "@relationship-os/core";
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
import { Badge } from "@relationship-os/ui/components/badge";
import { Button } from "@relationship-os/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@relationship-os/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@relationship-os/ui/components/dialog";
import { Input } from "@relationship-os/ui/components/input";
import { Label } from "@relationship-os/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@relationship-os/ui/components/select";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { Switch } from "@relationship-os/ui/components/switch";
import { Link } from "@tanstack/react-router";
import { AlertTriangleIcon, KeyRoundIcon, PlayIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

type JudgeView = CoreOutput<"judge.get">;
type Placement = JudgeView["placements"][number];
type TestResult = CoreOutput<"judge.test">;

const SOURCE_LABELS: Record<Placement["source"], string> = {
  shipped: "Default",
  deploy: "Deploy config",
  admin: "Set here",
  fixed: "Fixed",
};

const FAILURE_WORDS: Record<string, string> = {
  off: "the judge is off (no key)",
  "no-key": "no key is reachable",
  unreachable: "TypeSafe could not be reached",
  timeout: "no answer in time",
  "rate-limited": "rate-limited",
  "no-credit": "the TypeSafe account has no credit",
  "key-refused": "the key was refused",
  "server-error": "TypeSafe had a server error",
  "incomplete-answer": "the answer was incomplete",
  fault: "the request was refused as malformed",
};

/** Placements shown here: the ones a deployment asks (not the Test button or eval graders). */
const shown = (p: Placement) => p.switchable || p.id === "adjudicator.policy";

function usd(n: number): string {
  return n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: n > 0 && n < 0.01 ? 4 : 2,
  });
}

/** Where the key is and where calls go, in words (never the key). */
function routeWords(view: JudgeView): string {
  if (!view.on)
    return view.problem ?? "No TypeSafe key: every placement does what it did before the judge.";
  if (view.hosted) return "A secret on your workspace; calls go straight to TypeSafe.";
  if (view.keySource === "byok")
    return "Held by your AI Gateway (BYOK); calls go through the gateway.";
  return view.route === "gateway"
    ? "A Workers secret; calls go through your AI Gateway."
    : "A Workers secret; calls go straight to TypeSafe.";
}

export function JudgeSection() {
  const judge = useOp("judge.get", {});
  if (judge.isPending) return <Skeleton className="h-64 w-full" />;
  if (judge.isError || !judge.data) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {errorMessage(judge.error)}
      </p>
    );
  }
  const view = judge.data;
  return (
    <Card data-testid="ai-judge">
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          Judge (Jev)
        </CardTitle>
        <CardDescription>
          Jev, TypeSafe AI's decision model, checks AI work at named places: an automation against
          the person's request, a waiting change against your written policy. It answers narrow
          questions with probabilities; it never writes text or acts. Model {view.model}, $
          {view.pricePerMillionInputTokensUsd} per million input tokens.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        <KeyRow view={view} />
        <ReviewerRow view={view} />
        <PlacementList view={view} />
      </CardContent>
    </Card>
  );
}

// --- Key, route and the Test button --------------------------------------------------------------

function KeyRow({ view }: { view: JudgeView }) {
  const test = useOpMutation("judge.test");
  const [result, setResult] = useState<TestResult | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(false);
  const setKey = useOpMutation("judge.setKey", { invalidates: ["judge.", "adjudicator."] });

  async function runTest() {
    setResult(null);
    try {
      setResult(await test.mutateAsync({}));
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function remove() {
    try {
      await setKey.mutateAsync({ apiKey: null });
      toast.success("Removed the TypeSafe key");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setRemoving(false);
    }
  }

  return (
    <section className="grid gap-2" aria-labelledby="judge-key" data-testid="judge-key">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="grid gap-0.5">
          <h3 id="judge-key" className="flex flex-wrap items-center gap-2 text-sm font-medium">
            TypeSafe key
            {view.on ? (
              <Badge variant="secondary" className="font-normal" data-testid="judge-key-status">
                <KeyRoundIcon aria-hidden />
                {view.keySource === "byok" ? "Key in AI Gateway" : "Key set"}
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="font-normal text-muted-foreground"
                data-testid="judge-key-status"
              >
                No key
              </Badge>
            )}
            {view.on && (
              <Badge variant="outline" className="font-normal text-muted-foreground">
                {view.route === "gateway" ? "Via AI Gateway" : "Direct"}
              </Badge>
            )}
          </h3>
          <p className="text-xs text-muted-foreground" data-testid="judge-route">
            {routeWords(view)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {view.on && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void runTest()}
              disabled={test.isPending}
            >
              <PlayIcon aria-hidden />
              {test.isPending ? "Testing…" : "Test"}
            </Button>
          )}
          {view.keyStore.available && view.on && view.keySource === "secret" && (
            <Button variant="ghost" size="sm" onClick={() => setRemoving(true)}>
              Remove
            </Button>
          )}
          {view.keyStore.available && view.keySource !== "byok" && (
            <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
              {view.on ? "Replace key" : "Add key"}
            </Button>
          )}
        </div>
      </div>
      {result && (
        <p
          className={
            result.ok
              ? "text-sm text-emerald-700 dark:text-emerald-400"
              : "text-sm text-destructive"
          }
          role="status"
          data-testid="judge-test-result"
        >
          {result.ok
            ? `Answered in ${result.latencyMs} ms by ${result.model}.`
            : `Could not answer: ${FAILURE_WORDS[result.reason ?? ""] ?? result.reason}${result.detail ? ` (${result.detail})` : ""}.`}
        </p>
      )}
      {!view.on && !view.keyStore.available && (
        <p className="text-xs text-muted-foreground" role="note" data-testid="judge-key-howto">
          {view.hosted
            ? `Keys can't be stored right now: ${view.keyStore.missing.join(", ")}.`
            : "Set the TYPESAFE_API_KEY secret on ros-app and ros-runner (wrangler secret put TYPESAFE_API_KEY), or give Settings → AI Cloudflare API access to store it here."}
        </p>
      )}
      {adding && <JudgeKeyDialog hosted={view.hosted} onClose={() => setAdding(false)} />}
      <AlertDialog open={removing} onOpenChange={(open) => !open && setRemoving(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the TypeSafe key?</AlertDialogTitle>
            <AlertDialogDescription>
              The judge turns off: every placement does what it did before the judge, and the policy
              adjudicator reviews with the LLM unless it is set to Jev, in which case it hands every
              change to a person.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void remove()}>Remove key</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function JudgeKeyDialog({ hosted, onClose }: { hosted: boolean; onClose: () => void }) {
  const setKey = useOpMutation("judge.setKey", { invalidates: ["judge.", "adjudicator."] });
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await setKey.mutateAsync({ apiKey });
      setApiKey("");
      toast.success(
        hosted
          ? "TypeSafe key stored as a secret on your workspace"
          : "TypeSafe key stored as a Workers secret",
      );
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={(e) => void submit(e)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>TypeSafe API key</DialogTitle>
            <DialogDescription>
              {hosted
                ? "Stored as a secret on your workspace through the control plane. It is never stored in the database or shown again, and calls with it go straight to TypeSafe."
                : "Stored as the TYPESAFE_API_KEY secret on ros-app and ros-runner. It is never stored in the database or shown again."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="judge-api-key">API key</Label>
            <Input
              id="judge-api-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              required
              minLength={8}
            />
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={setKey.isPending || apiKey.trim().length < 8}>
              {setKey.isPending ? "Storing…" : "Store key"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- The adjudicator's reviewer ------------------------------------------------------------------

const DEFAULT_REVIEWER = "__default__";

function ReviewerRow({ view }: { view: JudgeView }) {
  const update = useOpMutation("adjudicator.update", { invalidates: ["judge."] });
  const value = view.adjudicatorReviewerSetting ?? DEFAULT_REVIEWER;
  const tooMany = view.policyRules !== null && view.policyRules > view.maxPolicyRules;

  async function choose(next: string) {
    try {
      const out = await update.mutateAsync({
        reviewer: next === DEFAULT_REVIEWER ? null : (next as "llm" | "jev"),
      });
      toast.success(
        `Policy adjudicator reviews with ${out.reviewer === "jev" ? "Jev" : "the LLM"}`,
      );
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <section className="grid gap-2" aria-labelledby="judge-reviewer" data-testid="judge-reviewer">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="grid gap-0.5">
          <h3 id="judge-reviewer" className="text-sm font-medium">
            Policy adjudicator's reviewer
          </h3>
          <p className="text-xs text-muted-foreground">
            Reviews with{" "}
            <span className="font-medium text-foreground" data-testid="judge-reviewer-current">
              {view.adjudicatorReviewer === "jev" ? "Jev" : "the LLM (review role)"}
            </span>
            . Jev reads your written policy as numbered rules, one per line, and never the agent's
            reason; if it cannot answer, the change waits for a person.{" "}
            <Link to="/settings/adjudicator" className="underline underline-offset-2">
              See the rules
            </Link>
          </p>
        </div>
        <Select value={value} onValueChange={(v) => void choose(v)} disabled={update.isPending}>
          <SelectTrigger className="w-64" aria-label="Reviewer">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_REVIEWER}>Default (Jev while there is a key)</SelectItem>
            <SelectItem value="jev" disabled={!view.on}>
              Jev
            </SelectItem>
            <SelectItem value="llm">LLM (review role)</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {tooMany && view.adjudicatorReviewer === "jev" && (
        <p
          className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
          role="alert"
        >
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          The written policy has {view.policyRules} rules; Jev reads at most {view.maxPolicyRules},
          so every change waits for a person. Shorten it, or choose the LLM.
        </p>
      )}
    </section>
  );
}

// --- Placements ----------------------------------------------------------------------------------

function PlacementList({ view }: { view: JudgeView }) {
  const update = useOpMutation("judge.update");
  const [confirming, setConfirming] = useState<Placement | null>(null);
  const placements = view.placements.filter(shown);
  const total = placements.reduce((n, p) => n + p.spend.costUsd, 0);

  async function set(p: Placement, on: boolean | null) {
    try {
      await update.mutateAsync({ placements: { [p.id]: on } });
      toast.success(
        on === null ? `${p.label}: back to its default` : `${p.label}: ${on ? "on" : "off"}`,
      );
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  function toggle(p: Placement, on: boolean) {
    // Turning off a check that holds things for a person lets more through: confirm it.
    if (!on && p.failMode === "closed") setConfirming(p);
    else void set(p, on);
  }

  return (
    <section className="grid gap-2" aria-labelledby="judge-placements">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="judge-placements" className="text-sm font-medium">
          Where it checks
        </h3>
        <p className="text-xs text-muted-foreground" data-testid="judge-spend-total">
          Last {view.spendDays} days: {usd(total)}
        </p>
      </div>
      <ul className="divide-y rounded-md border" aria-label="Judge placements">
        {placements.map((p) => (
          <li
            key={p.id}
            className="grid gap-1.5 px-3 py-2.5 text-sm"
            data-testid={`judge-placement-${p.id}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex flex-wrap items-center gap-2 font-medium">
                {p.label}
                <Badge variant="outline" className="font-normal text-muted-foreground">
                  {SOURCE_LABELS[p.source]}
                </Badge>
                {p.sendsRecordContent && (
                  <Badge variant="outline" className="font-normal text-muted-foreground">
                    Sends record content
                  </Badge>
                )}
                {!p.built && (
                  <Badge variant="outline" className="font-normal text-muted-foreground">
                    Not built yet
                  </Badge>
                )}
              </span>
              {p.switchable ? (
                <span className="flex items-center gap-2">
                  {p.source === "admin" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => void set(p, null)}
                      disabled={update.isPending}
                    >
                      Reset
                    </Button>
                  )}
                  <Switch
                    checked={p.on}
                    onCheckedChange={(on) => toggle(p, on)}
                    disabled={update.isPending}
                    aria-label={`${p.label}: ${p.on ? "on" : "off"}`}
                  />
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {view.adjudicatorReviewer === "jev" ? "On: Jev reviews" : "Off: the LLM reviews"}
                </span>
              )}
            </div>
            <dl className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-[8rem_1fr]">
              <dt>Asked</dt>
              <dd>{p.askedWhen}</dd>
              <dt>Sends</dt>
              <dd>{p.sends}</dd>
              <dt>If it can't answer</dt>
              <dd>{p.onFailure}</dd>
              <dt>Spend</dt>
              <dd data-testid={`judge-spend-${p.id}`}>
                {p.spendCounted ? (
                  <>
                    {p.spend.calls.toLocaleString()} calls, {p.spend.inputTokens.toLocaleString()}{" "}
                    input tokens, {usd(p.spend.costUsd)}
                  </>
                ) : (
                  "Not counted here: it stores nothing, so its calls are in the Workers logs only"
                )}
              </dd>
            </dl>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        Spend is the judge's own count of the calls behind a stored result: the adjudicator's
        verdicts, extension proposals, summaries, outbound messages and job-change suggestions.
        Calls that store nothing (extension.check, the widget shape in Describe a widget, and Test)
        are in the Workers logs only.
      </p>
      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn off {confirming?.label.toLowerCase()}?</AlertDialogTitle>
            <AlertDialogDescription>
              This check holds things for a person when it finds a fault or cannot answer. With it
              off, more will go through without a person. The change is audited.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirming) void set(confirming, false);
                setConfirming(null);
              }}
            >
              Turn off
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
