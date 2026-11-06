// Tasks and activities, deals and pipeline, calendar and meetings.
import type { A2uiAction, TaskItem } from "@relationship-os/agent-a2ui";
import {
  type RendererProps,
  useA2uiAction,
  useA2uiRunner,
} from "@relationship-os/agent-a2ui/react";
import { Button } from "@relationship-os/ui/components/button";
import { Checkbox } from "@relationship-os/ui/components/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@relationship-os/ui/components/dropdown-menu";
import { Input } from "@relationship-os/ui/components/input";
import { Label } from "@relationship-os/ui/components/label";
import { Textarea } from "@relationship-os/ui/components/textarea";
import { cn } from "@relationship-os/ui/lib/utils";
import {
  CalendarClockIcon,
  CheckIcon,
  LoaderCircleIcon,
  MailIcon,
  MessageSquareIcon,
  PhoneIcon,
  SendIcon,
  StickyNoteIcon,
  UsersIcon,
  ZapIcon,
} from "lucide-react";
import { useId, useState } from "react";
import { recordHref } from "#/lib/schema";
import { Fields, formValues, useFormValues } from "./forms.tsx";
import {
  ActionButton,
  ActionFooter,
  Body,
  CardLink,
  Chips,
  Facts,
  Footer,
  Frame,
  Header,
  LinkButton,
  Row,
  Rows,
  RowText,
} from "./parts.tsx";

// --- Tasks -----------------------------------------------------------------------------------

const atHour = (date: Date, hour: number) => {
  const next = new Date(date);
  next.setHours(hour, 0, 0, 0);
  return next;
};

/** The snooze presets, for the person's clock. */
export function snoozePresets(now = new Date()): { label: string; at: Date }[] {
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const monday = new Date(now);
  monday.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7));
  const later = new Date(now.getTime() + 3 * 3_600_000);
  return [
    { label: "Later today", at: later },
    { label: "Tomorrow", at: atHour(tomorrow, 9) },
    { label: "Next week", at: atHour(monday, 9) },
  ];
}

const when = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});

function taskDetail(task: TaskItem): string {
  return [
    task.done ? "Done" : (task.dueLabel ?? (task.dueAt ? `Due ${task.dueAt}` : null)),
    task.record?.label,
    task.assignee?.name,
  ]
    .filter(Boolean)
    .join(" · ");
}

function TaskRow({ task }: { task: TaskItem }) {
  const complete = useA2uiAction({
    kind: "operation",
    label: "Complete",
    operation: "task.complete",
    input: { id: task.id },
  });
  const run = useA2uiRunner();
  const [done, setDone] = useState(task.done);
  const [problem, setProblem] = useState<string | null>(null);
  const [snoozed, setSnoozed] = useState<string | null>(null);
  const checkbox = useId();

  async function toggle() {
    if (done) return;
    setDone(true);
    setProblem(null);
    const result = await complete.run();
    if (!result.ok) {
      setDone(false);
      setProblem(result.message);
    } else if (result.message) setProblem(result.message);
  }

  async function snooze(label: string, at: Date) {
    const result = await run({
      kind: "operation",
      label: "Snooze",
      operation: "task.update",
      input: { id: task.id, dueAt: at.toISOString() },
    });
    if (result.ok) setSnoozed(label);
    else setProblem(result.message);
  }

  const openTask = (): A2uiAction => ({ kind: "open", label: "Open", href: "/tasks" });
  const reassign = (): A2uiAction => ({
    kind: "reply",
    label: "Reassign",
    text: `Reassign "${task.title}"`,
  });

  return (
    <Row className={cn(done && "text-muted-foreground")}>
      <Checkbox
        id={checkbox}
        checked={done}
        disabled={done}
        onCheckedChange={() => void toggle()}
        aria-label={`Complete: ${task.title}`}
      />
      <RowText
        title={
          <label htmlFor={checkbox} className={cn(done && "line-through")}>
            {task.title}
          </label>
        }
        sub={
          problem ? (
            <span className="text-destructive">{problem}</span>
          ) : snoozed ? (
            `Snoozed: ${snoozed}`
          ) : (
            <span className={cn(task.overdue && !done && "text-destructive")}>
              {taskDetail({ ...task, done })}
            </span>
          )
        }
      />
      {!done && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon-xs"
              variant="ghost"
              className="max-md:size-8"
              aria-label={`Snooze or change: ${task.title}`}
            >
              <CalendarClockIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {snoozePresets().map((preset) => (
              <DropdownMenuItem
                key={preset.label}
                onSelect={() => void snooze(preset.label, preset.at)}
              >
                <span className="flex-1">{preset.label}</span>
                <span className="ml-3 text-xs text-muted-foreground">{when.format(preset.at)}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem onSelect={() => void run(reassign())}>Reassign</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void run(openTask())}>Open</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </Row>
  );
}

export function TaskListComponent({ props }: RendererProps<"taskList">) {
  return (
    <Frame type="taskList">
      <Header title={props.title} aside={props.total ?? props.tasks.length} />
      <Rows label={props.title}>
        {props.tasks.map((task) => (
          <TaskRow key={task.id} task={task} />
        ))}
      </Rows>
      {props.viewAll && (
        <Footer>
          <LinkButton href={props.viewAll} label="Open Tasks" />
        </Footer>
      )}
    </Frame>
  );
}

export function TaskCardComponent({ props }: RendererProps<"taskCard">) {
  const { task } = props;
  return (
    <Frame type="taskCard">
      <ul>
        <TaskRow task={task} />
      </ul>
      {task.notes && (
        <Body>
          <p className="whitespace-pre-wrap break-words text-[13px] text-muted-foreground">
            {task.notes}
          </p>
        </Body>
      )}
      <Footer>
        <LinkButton href="/tasks" label="Open" />
        <ActionButton
          action={{ kind: "reply", label: "Edit", text: `Edit the task "${task.title}"` }}
          index={1}
        />
      </Footer>
    </Frame>
  );
}

const KIND_ICON = {
  note: StickyNoteIcon,
  call: PhoneIcon,
  email: MailIcon,
  meeting: UsersIcon,
  task: CheckIcon,
  system: ZapIcon,
};

export function TimelineComponent({ props }: RendererProps<"timeline">) {
  return (
    <Frame type="timeline">
      <Header title={props.title} subtitle={props.record?.label} />
      <Rows label={props.title}>
        {props.entries.map((entry) => {
          const Icon = KIND_ICON[entry.kind] ?? MessageSquareIcon;
          return (
            <Row key={`${entry.when}:${entry.title}`} className="items-start">
              <Icon
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                aria-label={entry.kind}
              />
              <RowText
                title={entry.title}
                sub={[entry.when, entry.text].filter(Boolean).join(" · ")}
              />
            </Row>
          );
        })}
      </Rows>
      <ActionFooter actions={props.actions} />
    </Frame>
  );
}

export function EmailPreviewComponent({ props }: RendererProps<"emailPreview">) {
  return (
    <Frame type="emailPreview">
      <Header title={props.subject} subtitle={`${props.from.name} · ${props.when}`} />
      <Body>
        <p className="line-clamp-4 break-words text-[13px] text-muted-foreground">
          {props.snippet}
        </p>
      </Body>
      <ActionFooter actions={props.actions} />
    </Frame>
  );
}

const names = (people: readonly { name: string }[]) => people.map((p) => p.name).join(", ");

export function EmailDraftComponent({ props }: RendererProps<"emailDraft">) {
  const [subject, setSubject] = useState(props.subject);
  const [body, setBody] = useState(props.body);
  const [discarded, setDiscarded] = useState(false);
  const id = useId();
  const send: A2uiAction = {
    kind: "operation",
    label: "Send",
    operation: props.send.operation,
    input: props.send.input,
  };
  const state = useA2uiAction(send);
  if (discarded) {
    return (
      <Frame type="emailDraft" className="px-3 py-2.5 text-muted-foreground">
        Draft discarded.
      </Frame>
    );
  }
  const sending = state.status === "busy";
  const sent = state.status === "done";
  return (
    <Frame type="emailDraft">
      <Header title="Draft email" subtitle={`To ${names(props.to)}`} />
      <Body>
        {props.cc.length > 0 && (
          <p className="truncate text-xs text-muted-foreground">Cc {names(props.cc)}</p>
        )}
        <div className="grid gap-1">
          <Label htmlFor={`${id}-subject`} className="text-xs">
            Subject
          </Label>
          <Input
            id={`${id}-subject`}
            className="h-8"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            disabled={sent}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-body`} className="text-xs">
            Message
          </Label>
          <Textarea
            id={`${id}-body`}
            className="min-h-28 text-[13px]"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            disabled={sent}
          />
        </div>
        {props.attachments.length > 0 && (
          <p className="truncate text-xs text-muted-foreground">
            Attached: {props.attachments.join(", ")}
          </p>
        )}
      </Body>
      <Footer>
        <Button
          size="xs"
          className="max-md:h-8"
          disabled={sending || sent}
          onClick={() =>
            void state.run({ [props.send.subjectField]: subject, [props.send.bodyField]: body })
          }
        >
          {sending ? <LoaderCircleIcon className="animate-spin" /> : <SendIcon />}
          Send
        </Button>
        {!sent && (
          <Button
            size="xs"
            variant="ghost"
            className="max-md:h-8"
            onClick={() => setDiscarded(true)}
          >
            Discard
          </Button>
        )}
        {props.actions?.map((action, i) => (
          <ActionButton key={action.label} action={action} index={i + 1} />
        ))}
        {state.message && (
          <span
            role="status"
            className={cn(
              "text-xs",
              state.status === "failed" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {state.message}
          </span>
        )}
      </Footer>
    </Frame>
  );
}

export function LoggerComponent({ props }: RendererProps<"logger">) {
  const [subject, setSubject] = useState(props.subject ?? "");
  const [body, setBody] = useState(props.body ?? "");
  const id = useId();
  const save = useA2uiAction({
    kind: "operation",
    label: "Save",
    operation: "activity.log",
    input: {
      type: props.kind,
      links: [{ object: props.record.object, id: props.record.id }],
    },
    done: "Saved",
  });
  const saved = save.status === "done";
  return (
    <Frame type="logger">
      <Header
        title={`Log a ${props.kind}`}
        subtitle={
          <CardLink
            href={recordHref(props.record.object, props.record.id)}
            className="hover:underline"
          >
            {props.record.label}
          </CardLink>
        }
      />
      <Body>
        {props.kind === "call" && (
          <div className="grid gap-1">
            <Label htmlFor={`${id}-subject`} className="text-xs">
              Subject
            </Label>
            <Input
              id={`${id}-subject`}
              className="h-8"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>
        )}
        <div className="grid gap-1">
          <Label htmlFor={`${id}-body`} className="text-xs">
            Notes
          </Label>
          <Textarea
            id={`${id}-body`}
            className="min-h-16 text-[13px]"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>
      </Body>
      <Footer>
        <Button
          size="xs"
          className="max-md:h-8"
          disabled={save.status === "busy" || saved || !(subject.trim() || body.trim())}
          onClick={() =>
            void save.run({
              ...(subject.trim() ? { subject: subject.trim() } : {}),
              ...(body.trim() ? { body: body.trim() } : {}),
            })
          }
        >
          Save
        </Button>
        {save.message && (
          <span
            role="status"
            className={cn(
              "text-xs",
              save.status === "failed" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {save.message}
          </span>
        )}
      </Footer>
    </Frame>
  );
}

// --- Deals -----------------------------------------------------------------------------------

function StageTrack({ stage, index, count }: { stage: string; index: number; count: number }) {
  return (
    <div
      className="flex gap-1"
      role="img"
      aria-label={`Stage ${stage}, ${index} of ${count}`}
      data-testid="stage-track"
    >
      {Array.from({ length: count }, (_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed segments of a track.
          key={i}
          className={cn("h-1.5 flex-1 rounded-full", i < index ? "bg-primary" : "bg-muted")}
        />
      ))}
    </div>
  );
}

export function DealCardComponent({ props }: RendererProps<"dealCard">) {
  const { deal } = props;
  return (
    <Frame type="dealCard">
      <Header
        title={
          <CardLink href={recordHref(deal.object, deal.id)} className="hover:underline">
            {deal.label}
          </CardLink>
        }
        subtitle={deal.subtitle}
        aside={
          props.value && (
            <span className="text-sm font-semibold text-foreground tabular-nums">
              {props.value}
            </span>
          )
        }
      />
      <Body>
        {props.stageIndex && props.stageCount ? (
          <StageTrack stage={props.stage} index={props.stageIndex} count={props.stageCount} />
        ) : null}
        <Facts items={[{ label: "Stage", value: props.stage }, ...props.facts]} />
      </Body>
      <ActionFooter actions={props.actions} />
    </Frame>
  );
}

export function DealListComponent({ props }: RendererProps<"dealList">) {
  return (
    <Frame type="dealList">
      <Header title={props.title} aside={props.summary} />
      <Rows label={props.title}>
        {props.deals.map((item) => (
          <Row key={item.deal.id + item.deal.label}>
            <RowText
              title={
                <CardLink
                  href={recordHref(item.deal.object, item.deal.id)}
                  className="hover:underline"
                >
                  {item.deal.label}
                </CardLink>
              }
              sub={item.detail}
            />
            {item.value && <span className="shrink-0 tabular-nums">{item.value}</span>}
          </Row>
        ))}
      </Rows>
      <ActionFooter actions={props.actions} />
    </Frame>
  );
}

export function PipelineSnapshotComponent({ props }: RendererProps<"pipelineSnapshot">) {
  const max = Math.max(1, ...props.stages.map((s) => s.value));
  return (
    <Frame type="pipelineSnapshot">
      <Header title={props.title} aside={props.summary} />
      <Body>
        <div className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1.5 text-xs">
          {props.stages.map((stage) => (
            <div key={stage.label} className="contents">
              <span className="max-w-28 truncate">{stage.label}</span>
              <span
                className="block h-3.5 rounded bg-[var(--chart-1)]"
                style={{ width: `${Math.max(2, (stage.value / max) * 100)}%` }}
              />
              <span className="text-muted-foreground tabular-nums">
                {stage.valueLabel ?? stage.value}
              </span>
            </div>
          ))}
        </div>
      </Body>
      {props.open && (
        <Footer>
          <LinkButton href={props.open} label="Open board" />
        </Footer>
      )}
    </Frame>
  );
}

export function StageMoveConfirmComponent({ props }: RendererProps<"stageMoveConfirm">) {
  const form = useFormValues(props.fields);
  const submit = useA2uiAction({
    kind: "operation",
    label: props.submit.label,
    operation: props.submit.operation,
    input: props.submit.input,
    ...(props.submit.done ? { done: props.submit.done } : {}),
  });
  const moved = submit.status === "done";
  return (
    <Frame type="stageMoveConfirm">
      <Header title={`Move to ${props.to}`} subtitle={`${props.deal.label}, from ${props.from}`} />
      {props.fields.length > 0 && (
        <Body>
          <Fields fields={props.fields} form={form} />
        </Body>
      )}
      <Footer>
        <Button
          size="xs"
          className="max-md:h-8"
          disabled={submit.status === "busy" || moved || !form.complete}
          onClick={() => void submit.run(formValues(props.fields, form.values))}
        >
          {props.submit.label}
        </Button>
        {submit.message && (
          <span
            role="status"
            className={cn(
              "text-xs",
              submit.status === "failed" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {submit.message}
          </span>
        )}
      </Footer>
    </Frame>
  );
}

// --- Calendar --------------------------------------------------------------------------------

export function MeetingCardComponent({ props }: RendererProps<"meetingCard">) {
  return (
    <Frame type="meetingCard">
      <Header
        title={props.title}
        subtitle={[props.when, props.where].filter(Boolean).join(" · ")}
      />
      {(props.attendees.length > 0 || props.records.length > 0) && (
        <Body>
          {props.attendees.length > 0 && <Chips records={props.attendees} />}
          {props.records.length > 0 && <Chips records={props.records} />}
        </Body>
      )}
      <ActionFooter actions={props.actions}>
        {props.joinUrl && <LinkButton href={props.joinUrl} label="Join" />}
      </ActionFooter>
    </Frame>
  );
}

function PrepList({ title, items }: { title: string; items: readonly string[] }) {
  if (!items.length) return null;
  return (
    <div className="grid min-w-0 gap-1">
      <p className="text-xs text-muted-foreground">{title}</p>
      <ul className="grid list-disc gap-0.5 pl-4 text-[13px]">
        {items.map((item) => (
          <li key={item} className="break-words">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MeetingPrepComponent({ props }: RendererProps<"meetingPrep">) {
  return (
    <Frame type="meetingPrep">
      <Header title={`Prep: ${props.title}`} subtitle={props.when} />
      <Body className="gap-3">
        {props.attendees.length > 0 && <Chips records={props.attendees} />}
        {props.summary && (
          <div className="grid gap-1">
            <p className="break-words text-[13px]">{props.summary}</p>
            {props.checked && (
              <p className="text-xs text-muted-foreground">Checked against the records</p>
            )}
          </div>
        )}
        <PrepList title="Recent" items={props.recent} />
        <PrepList title="Open" items={props.open} />
        {props.records.length > 0 && <Chips records={props.records} />}
      </Body>
      <ActionFooter actions={props.actions}>
        {props.joinUrl && <LinkButton href={props.joinUrl} label="Join" />}
      </ActionFooter>
    </Frame>
  );
}

export function AvailabilitySlotsComponent({ props }: RendererProps<"availabilitySlots">) {
  return (
    <Frame type="availabilitySlots">
      <Header title={props.title} />
      <Body>
        <div className="flex flex-wrap gap-2">
          {props.slots.map((slot, i) => (
            <ActionButton
              key={slot.start}
              index={i === 0 ? 0 : 1}
              extra={{ [props.pick.field]: slot.start }}
              action={{
                kind: "operation",
                label: slot.label,
                operation: props.pick.operation,
                input: props.pick.input,
                style: "secondary",
              }}
            />
          ))}
        </div>
      </Body>
    </Frame>
  );
}
