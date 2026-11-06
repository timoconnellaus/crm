// Settings → What your assistant remembers (ADR 0342 decision 9): every line with its condition,
// source message and date, with edit, delete, pause and reset; memory on or paused; and team lines
// with their author and history, under the workspace's governance setting.
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
import { Textarea } from "@relationship-os/ui/components/textarea";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { ErrorState } from "#/components/empty-state";
import { PageLayout } from "#/components/layout/page-layout";
import { formatDate } from "#/lib/format";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

export const Route = createFileRoute("/_app/settings/assistant-memory")({
  component: AssistantMemoryPage,
});

type Memory = CoreOutput<"memory.list">;
type MemoryLine = Memory["lines"][number];
type Governance = Memory["governance"];

const INVALIDATES = { invalidates: ["memory."] };

const SECTIONS: { kind: MemoryLine["kind"]; title: string; description: string }[] = [
  { kind: "personal", title: "About you", description: "Your preferences, habits and rules." },
  { kind: "shortcut", title: "Shortcuts", description: "What you mean by a word or phrase." },
  { kind: "style", title: "Writing style", description: "How you like your writing." },
  {
    kind: "conditional",
    title: "Only in some cases",
    description: "Read only when the record in view matches.",
  },
];

const GOVERNANCE: { value: Governance; label: string }[] = [
  { value: "open", label: "Open: anyone can edit" },
  { value: "approval", label: "Approval: anyone proposes, admins approve" },
  { value: "restricted", label: "Restricted: only admins propose and edit" },
];

function AssistantMemoryPage() {
  const memory = useOp("memory.list", {});
  return (
    <PageLayout
      title="What your assistant remembers"
      width="md"
      back={{ to: "/settings", label: "Settings" }}
      description="Your assistant saves these as you chat, and reads them in every reply. Facts about customers stay on their records, not here."
    >
      {memory.isPending ? (
        <Skeleton className="h-72" />
      ) : memory.isError ? (
        <ErrorState
          title="Could not load your assistant's memory"
          error={memory.error}
          onRetry={() => void memory.refetch()}
        />
      ) : (
        <div className="grid gap-6">
          <MemorySwitch memory={memory.data} />
          {SECTIONS.map((section) => {
            const lines = memory.data.lines.filter((l) => l.kind === section.kind);
            return (
              <section key={section.kind} className="grid gap-2" aria-label={section.title}>
                <div>
                  <h2 className="text-sm font-medium">{section.title}</h2>
                  <p className="text-sm text-muted-foreground">{section.description}</p>
                </div>
                {lines.length ? (
                  <ul className="grid gap-2">
                    {lines.map((line) => (
                      <LineRow key={line.id} line={line} />
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">Nothing yet.</p>
                )}
              </section>
            );
          })}
          <TeamMemory memory={memory.data} />
        </div>
      )}
    </PageLayout>
  );
}

function MemorySwitch({ memory }: { memory: Memory }) {
  const pause = useOpMutation("memory.pause", INVALIDATES);
  const reset = useOpMutation("memory.reset", INVALIDATES);
  const [confirming, setConfirming] = useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Memory</CardTitle>
        <CardDescription>
          While memory is off, your assistant reads and saves nothing. Your lines are kept.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Switch
            id="memory-on"
            checked={!memory.paused}
            onCheckedChange={(on) =>
              pause
                .mutateAsync({ paused: !on })
                .catch((error: unknown) => toast.error(errorMessage(error)))
            }
            data-testid="memory-on"
          />
          <Label htmlFor="memory-on">{memory.paused ? "Paused" : "On"}</Label>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={!memory.lines.length}
          onClick={() => setConfirming(true)}
          data-testid="memory-reset"
        >
          Reset
        </Button>
      </CardContent>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete everything your assistant remembers?</AlertDialogTitle>
            <AlertDialogDescription>
              All {memory.lines.length} of your lines go, including your writing style. Team lines
              stay. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                reset
                  .mutateAsync({})
                  .then(() => toast.success("Memory reset"))
                  .catch((error: unknown) => toast.error(errorMessage(error)))
              }
            >
              Delete all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function Editor({
  text,
  onSave,
  onCancel,
}: {
  text: string;
  onSave: (text: string) => Promise<unknown>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(text);
  return (
    <div className="grid gap-2">
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        maxLength={500}
        aria-label="Line"
        data-testid="memory-edit-text"
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!draft.trim()}
          onClick={() => void onSave(draft.trim())}
          data-testid="memory-edit-save"
        >
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function Meta({ line }: { line: MemoryLine }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
      <span>Saved {formatDate(line.createdAt)}</span>
      {line.source && (
        <Link
          to="/assistant"
          search={{ seq: line.source.messageSeq }}
          className="underline hover:text-foreground"
          data-testid="memory-source"
        >
          Source message
        </Link>
      )}
      {line.authorName && line.kind === "team" && <span>By {line.authorName}</span>}
    </div>
  );
}

function Status({ line }: { line: MemoryLine }) {
  if (line.status === "paused") return <Badge variant="outline">Paused</Badge>;
  if (line.status === "proposed") return <Badge variant="outline">Waiting</Badge>;
  return null;
}

function LineRow({ line }: { line: MemoryLine }) {
  const update = useOpMutation("memory.update", INVALIDATES);
  const pause = useOpMutation("memory.pause", INVALIDATES);
  const remove = useOpMutation("memory.delete", INVALIDATES);
  const [editing, setEditing] = useState(false);
  const fail = (error: unknown) => toast.error(errorMessage(error));
  return (
    <li className="grid gap-1 rounded-md border p-3 text-sm" data-testid="memory-line">
      {editing ? (
        <Editor
          text={line.text}
          onCancel={() => setEditing(false)}
          onSave={(text) =>
            update
              .mutateAsync({ id: line.id, text })
              .then(() => setEditing(false))
              .catch(fail)
          }
        />
      ) : (
        <>
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0">{line.text}</p>
            <Status line={line} />
          </div>
          {line.conditionLabel && (
            <p className="text-muted-foreground" data-testid="memory-line-condition">
              When: {line.conditionLabel}
            </p>
          )}
          <Meta line={line} />
          <div className="mt-1 flex flex-wrap gap-1">
            {line.status === "proposed" && (
              <Button
                size="xs"
                onClick={() => update.mutateAsync({ id: line.id, confirm: true }).catch(fail)}
              >
                Save
              </Button>
            )}
            <Button size="xs" variant="outline" onClick={() => setEditing(true)}>
              Edit
            </Button>
            {line.status !== "proposed" && (
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  pause.mutateAsync({ id: line.id, paused: line.status === "active" }).catch(fail)
                }
              >
                {line.status === "active" ? "Pause" : "Resume"}
              </Button>
            )}
            <Button
              size="xs"
              variant="ghost"
              onClick={() => remove.mutateAsync({ id: line.id }).catch(fail)}
              data-testid="memory-line-delete"
            >
              Delete
            </Button>
          </div>
        </>
      )}
    </li>
  );
}

function TeamRow({ line, memory }: { line: MemoryLine; memory: Memory }) {
  const update = useOpMutation("teamMemory.update", INVALIDATES);
  const approve = useOpMutation("teamMemory.approve", INVALIDATES);
  const remove = useOpMutation("memory.delete", INVALIDATES);
  const [editing, setEditing] = useState(false);
  const fail = (error: unknown) => toast.error(errorMessage(error));
  const history = line.history as { at: string; action: string }[];
  return (
    <li className="grid gap-1 rounded-md border p-3 text-sm" data-testid="team-memory-line">
      {editing ? (
        <Editor
          text={line.text}
          onCancel={() => setEditing(false)}
          onSave={(text) =>
            update
              .mutateAsync({ id: line.id, text })
              .then(() => setEditing(false))
              .catch(fail)
          }
        />
      ) : (
        <>
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0">{line.text}</p>
            <Status line={line} />
          </div>
          <Meta line={line} />
          {history.length > 1 && (
            <p className="text-xs text-muted-foreground">
              {history.map((h) => `${h.action} ${formatDate(h.at)}`).join(", ")}
            </p>
          )}
          {memory.canEditTeam && (
            <div className="mt-1 flex flex-wrap gap-1">
              {line.status === "proposed" ? (
                <>
                  <Button
                    size="xs"
                    onClick={() => approve.mutateAsync({ id: line.id, approve: true }).catch(fail)}
                    data-testid="team-memory-approve"
                  >
                    Approve
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => approve.mutateAsync({ id: line.id, approve: false }).catch(fail)}
                  >
                    Reject
                  </Button>
                </>
              ) : (
                <>
                  <Button size="xs" variant="outline" onClick={() => setEditing(true)}>
                    Edit
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      update
                        .mutateAsync({ id: line.id, paused: line.status === "active" })
                        .catch(fail)
                    }
                  >
                    {line.status === "active" ? "Pause" : "Resume"}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => remove.mutateAsync({ id: line.id }).catch(fail)}
                  >
                    Delete
                  </Button>
                </>
              )}
            </div>
          )}
        </>
      )}
    </li>
  );
}

function TeamMemory({ memory }: { memory: Memory }) {
  const govern = useOpMutation("teamMemory.setGovernance", INVALIDATES);
  return (
    <section className="grid gap-2" aria-label="Team memory">
      <div>
        <h2 className="text-sm font-medium">Team memory</h2>
        <p className="text-sm text-muted-foreground">
          Every assistant in the workspace reads these lines.
        </p>
      </div>
      {memory.canManageTeam ? (
        <div className="grid gap-1">
          <Label htmlFor="team-governance">Who can change team memory</Label>
          <Select
            value={memory.governance}
            onValueChange={(governance) =>
              govern
                .mutateAsync({ governance: governance as Governance })
                .catch((error: unknown) => toast.error(errorMessage(error)))
            }
          >
            <SelectTrigger id="team-governance" className="w-full sm:w-96">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GOVERNANCE.map((g) => (
                <SelectItem key={g.value} value={g.value}>
                  {g.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {GOVERNANCE.find((g) => g.value === memory.governance)?.label}
        </p>
      )}
      {memory.team.length ? (
        <ul className="grid gap-2">
          {memory.team.map((line) => (
            <TeamRow key={line.id} line={line} memory={memory} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">Nothing yet.</p>
      )}
    </section>
  );
}
