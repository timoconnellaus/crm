// What a memory save looks like in the chat (ADR 0342, the mockup's memory lines): a saved line
// with Undo, or, for a line the person has to check, a read-back with Save and Cancel. It follows
// the line's current state from `memory.list`, so it stays true after a reload or an edit on
// What your assistant remembers.
import type { AssistantMemorySave } from "@relationship-os/core/client";
import { Badge } from "@relationship-os/ui/components/badge";
import { Button } from "@relationship-os/ui/components/button";
import { Link } from "@tanstack/react-router";
import { BookmarkIcon, CheckIcon, ShieldCheckIcon } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

const INVALIDATES = { invalidates: ["memory."] };

function Line({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <div
      className="flex items-start gap-1.5 text-xs leading-4 text-muted-foreground"
      data-testid={testId}
    >
      <BookmarkIcon className="mt-px size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

function LinkButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="underline hover:text-foreground" onClick={onClick}>
      {children}
    </button>
  );
}

function ReadBack({
  save,
  onSave,
  onCancel,
}: {
  save: AssistantMemorySave;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { line, checked } = save;
  return (
    <div className="rounded-md border p-3 text-sm" data-testid="memory-readback">
      <div className="flex items-center gap-1.5 font-medium">
        <BookmarkIcon className="size-4 shrink-0" aria-hidden />
        {line.conditionLabel ? "Remember, only in some cases" : "Remember this?"}
      </div>
      {line.conditionLabel && (
        <div className="mt-2">
          <div className="text-xs font-medium text-muted-foreground">When</div>
          <div data-testid="memory-condition">{line.conditionLabel}</div>
        </div>
      )}
      <div className="mt-2">
        <div className="text-xs font-medium text-muted-foreground">I'll remember</div>
        <div>{line.text}</div>
      </div>
      {line.conditionLabel && checked === "judge" && (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheckIcon className="size-3.5 shrink-0" aria-hidden />
          Checked: this matches what you said
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="xs" onClick={onSave} data-testid="memory-save">
          <CheckIcon />
          Save
        </Button>
        <Button size="xs" variant="outline" asChild>
          <Link to="/settings/assistant-memory">Edit</Link>
        </Button>
        <Button size="xs" variant="ghost" onClick={onCancel} data-testid="memory-cancel">
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** The line under a reply for one memory save. */
export function MemorySaved({ save }: { save: AssistantMemorySave }) {
  const list = useOp("memory.list", {});
  const remove = useOpMutation("memory.delete", INVALIDATES);
  const confirm = useOpMutation("memory.update", INVALIDATES);
  const approve = useOpMutation("teamMemory.approve", INVALIDATES);
  const restore = useOpMutation("memory.propose", INVALIDATES);
  const { line } = save;
  const team = line.kind === "team";
  const current =
    list.data && [...list.data.lines, ...list.data.team].find((l) => l.id === line.id);

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }
  const undo = () => run(() => remove.mutateAsync({ id: line.id }));
  const redo = () =>
    run(() =>
      restore.mutateAsync({
        text: line.text,
        kind: line.kind as "personal",
        ...(line.condition ? { condition: line.condition as never } : {}),
        restore: {
          id: line.id,
          ...(line.source ? { sourceSeq: line.source.messageSeq } : {}),
        },
      }),
    );

  if (!list.data) return null;
  if (current?.status === "proposed") {
    if (save.result === "awaiting_approval") {
      return (
        <Line testId="memory-awaiting">
          Proposed for the team: <b className="font-medium text-foreground">{line.text}</b>{" "}
          <Badge variant="outline">Waiting for approval</Badge>
        </Line>
      );
    }
    return (
      <ReadBack
        save={save}
        onSave={() =>
          run(() =>
            team
              ? approve.mutateAsync({ id: line.id, approve: true })
              : confirm.mutateAsync({ id: line.id, confirm: true }),
          )
        }
        onCancel={undo}
      />
    );
  }
  if (current) {
    return (
      <Line testId="memory-saved">
        {current.conditionLabel ? (
          <>Saved to memory, for {current.conditionLabel}</>
        ) : (
          <>
            Saved to memory: <b className="font-medium text-foreground">{current.text}</b>
          </>
        )}{" "}
        · <LinkButton onClick={undo}>Undo</LinkButton>
      </Line>
    );
  }
  if (team) return <Line testId="memory-removed">Not in team memory</Line>;
  return (
    <Line testId="memory-removed">
      Removed from memory · <LinkButton onClick={redo}>Redo</LinkButton>
    </Line>
  );
}
