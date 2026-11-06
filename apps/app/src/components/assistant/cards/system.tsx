// Assistant system flows (host-rendered): only the app itself sends these. Their workstreams (W3
// memory, W4 routines, W7 plugins, W8 connected assistants) send the documents; the cards are here.
import type { RendererProps } from "@relationship-os/agent-a2ui/react";
import { cn } from "@relationship-os/ui/lib/utils";
import { CheckIcon, SparklesIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { ApprovalCard } from "./approval.tsx";
import {
  ActionButton,
  ActionFooter,
  Body,
  Facts,
  Frame,
  Header,
  LinkButton,
  Pill,
  Row,
  Rows,
  RowText,
} from "./parts.tsx";

export function ApprovalComponent({ props }: RendererProps<"approval">) {
  return (
    <ApprovalCard
      changeSetId={props.changeSetId}
      actionIds={props.actionIds}
      title={props.title}
      youAsked={props.youAsked}
    />
  );
}

/** A check that passed or failed. */
function Check({ passed, children }: { passed: boolean; children: ReactNode }) {
  const Icon = passed ? CheckIcon : XIcon;
  return (
    <li className="flex min-w-0 items-start gap-1.5 text-[13px]">
      <Icon
        className={cn("mt-0.5 size-3.5 shrink-0", passed ? "text-success" : "text-destructive")}
        aria-label={passed ? "Passed" : "Failed"}
      />
      <span className="min-w-0 break-words">{children}</span>
    </li>
  );
}

export function RoutineReadBackComponent({ props }: RendererProps<"routineReadBack">) {
  return (
    <Frame type="routineReadBack" tone="pending">
      <Body className="pt-2.5">
        <p className="break-words font-medium">{props.summary}</p>
        <Facts items={[{ label: "When", value: props.trigger }]} />
        {props.gates.length > 0 && (
          <ul className="grid gap-1 text-[13px]">
            {props.gates.map((gate) => (
              <li key={gate.text} className="flex min-w-0 items-start gap-1.5">
                {gate.kind === "jev" && (
                  <SparklesIcon
                    className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                    aria-label="Checked by the judge"
                  />
                )}
                <span className="min-w-0 break-words">Only if: {gate.text}</span>
              </li>
            ))}
          </ul>
        )}
        {props.backtest && (
          <div className="grid gap-1 rounded-md bg-muted/50 p-2">
            <p className="text-xs">
              In the last {props.backtest.days} days it would have run {props.backtest.fired} times.
            </p>
            <ul className="grid gap-0.5">
              {props.backtest.examples.map((example) => (
                <Check key={example.text} passed={example.passed}>
                  {example.text}
                </Check>
              ))}
            </ul>
          </div>
        )}
      </Body>
      <ActionFooter actions={props.actions} />
    </Frame>
  );
}

const ROUTINE_TONE = { on: "success", paused: "neutral", failing: "danger" } as const;

export function RoutineListComponent({ props }: RendererProps<"routineList">) {
  return (
    <Frame type="routineList">
      <Header title="Your routines" aside={props.routines.length} />
      <Rows label="Your routines">
        {props.routines.map((routine) => (
          <Row key={routine.id} className="flex-wrap">
            <RowText
              title={routine.name}
              sub={[
                routine.lastRun && `Last: ${routine.lastRun}`,
                routine.nextRun && `Next: ${routine.nextRun}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            />
            <Pill tone={ROUTINE_TONE[routine.status]}>{routine.status}</Pill>
            {routine.actions?.map((action, i) => (
              <ActionButton key={action.label} action={action} index={i} />
            ))}
          </Row>
        ))}
      </Rows>
    </Frame>
  );
}

export function WhyThisComponent({ props }: RendererProps<"whyThis">) {
  return (
    <Frame type="whyThis">
      <Header title={`Why this? ${props.routine}`} subtitle={`Because ${props.trigger}`} />
      {(props.checks.length > 0 || props.jev) && (
        <Body>
          <ul className="grid gap-1">
            {props.checks.map((check) => (
              <Check key={check.text} passed={check.passed}>
                {check.text}
              </Check>
            ))}
            {props.jev && <Check passed={props.jev.passed}>{props.jev.text}</Check>}
          </ul>
        </Body>
      )}
      <ActionFooter actions={props.actions} />
    </Frame>
  );
}

export function MemorySavedComponent({ props }: RendererProps<"memorySaved">) {
  return (
    <Frame type="memorySaved" tone="ok">
      <Body className="pt-2.5">
        <p className="text-xs text-muted-foreground">Saved to memory</p>
        <p className="break-words">{props.line}</p>
        {props.condition && (
          <p className="break-words text-xs text-muted-foreground">When {props.condition}</p>
        )}
      </Body>
      <ActionFooter actions={props.actions} />
    </Frame>
  );
}

export function ConditionalMemoryReadBackComponent({
  props,
}: RendererProps<"conditionalMemoryReadBack">) {
  return (
    <Frame type="conditionalMemoryReadBack" tone="pending">
      <Body className="pt-2.5">
        <p className="break-words text-xs text-muted-foreground">When {props.condition}:</p>
        <p className="break-words">{props.line}</p>
      </Body>
      <ActionFooter actions={props.actions} />
    </Frame>
  );
}

export function PluginInstallComponent({ props }: RendererProps<"pluginInstall">) {
  return (
    <Frame type="pluginInstall">
      <Header title={`Install ${props.name}`} subtitle={props.publisher} />
      <Body>
        {props.adds.length > 0 && (
          <ul className="grid gap-0.5 text-[13px]">
            {props.adds.map((item) => (
              <li key={`${item.kind}:${item.label}`} className="min-w-0 break-words">
                <span className="text-muted-foreground">{item.kind}:</span> {item.label}
              </li>
            ))}
          </ul>
        )}
        <Facts
          items={[
            ...(props.scopes.length ? [{ label: "Access", value: props.scopes.join(", ") }] : []),
            ...(props.needs.length ? [{ label: "Needs", value: props.needs.join(", ") }] : []),
          ]}
        />
      </Body>
      <ActionFooter actions={props.actions} />
    </Frame>
  );
}

const MERGE_STYLE = {
  add: "bg-green-500/10 text-green-800 dark:text-green-300",
  remove: "bg-red-500/10 text-red-800 dark:text-red-300",
  same: "",
};
const MERGE_SIGN = { add: "+", remove: "-", same: " " };

export function PluginUpdateComponent({ props }: RendererProps<"pluginUpdate">) {
  return (
    <Frame type="pluginUpdate">
      <Header title={`Update for ${props.name}`} />
      <Body>
        {props.upstream.length > 0 && (
          <Facts items={[{ label: "Upstream", value: props.upstream.join("; ") }]} />
        )}
        {props.yours.length > 0 && (
          <Facts items={[{ label: "Your edits", value: props.yours.join("; ") }]} />
        )}
        {props.merged.length > 0 && (
          <pre className="max-h-48 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs">
            {props.merged.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a diff's lines may repeat.
              <div key={i} className={MERGE_STYLE[line.kind]}>
                {MERGE_SIGN[line.kind]} {line.text}
              </div>
            ))}
          </pre>
        )}
      </Body>
      <ActionFooter actions={props.actions} />
    </Frame>
  );
}

const CONNECTION_TONE = { missing: "warning", connected: "success", error: "danger" } as const;

export function ConnectionNeededComponent({ props }: RendererProps<"connectionNeeded">) {
  return (
    <Frame type="connectionNeeded">
      <Header
        title={props.service}
        aside={<Pill tone={CONNECTION_TONE[props.status]}>{props.status}</Pill>}
      />
      <Body>
        <p className="break-words text-[13px]">{props.reason}</p>
      </Body>
      <ActionFooter
        actions={props.connect ? [{ style: "primary", ...props.connect }] : undefined}
      />
    </Frame>
  );
}

export function AgentConnectionRequestComponent({
  props,
}: RendererProps<"agentConnectionRequest">) {
  return (
    <Frame type="agentConnectionRequest" tone="pending">
      <Header title={`${props.from} wants to connect assistants`} />
      <Body>
        <ul className="grid list-disc gap-0.5 pl-4 text-[13px]">
          {props.rules.map((rule) => (
            <li key={rule} className="break-words">
              {rule}
            </li>
          ))}
        </ul>
      </Body>
      <ActionFooter actions={props.actions} />
    </Frame>
  );
}

export function AgentRequestComponent({ props }: RendererProps<"agentRequest">) {
  return (
    <Frame type="agentRequest" tone="pending">
      <Header title={`${props.from}'s assistant asks`} />
      <Body>
        <p className="break-words">{props.request}</p>
        {props.rule && <p className="break-words text-xs text-muted-foreground">{props.rule}</p>}
      </Body>
      <ActionFooter actions={props.actions} />
    </Frame>
  );
}

export function AgentLogEntryComponent({ props }: RendererProps<"agentLogEntry">) {
  return (
    <Frame type="agentLogEntry" tone={props.verdict.allowed ? "default" : "blocked"}>
      <Header
        title={`${props.direction === "sent" ? "Shared with" : "Received from"} ${props.with}`}
        aside={props.when}
      />
      <Body>
        <p className="break-words text-[13px]">{props.shared}</p>
        {props.rule && (
          <p className="break-words text-xs text-muted-foreground">Rule: {props.rule}</p>
        )}
        <ul>
          <Check passed={props.verdict.allowed}>{props.verdict.text}</Check>
        </ul>
      </Body>
      {props.open && (
        <footer className="border-t px-3 py-2">
          <LinkButton href={props.open} label="Open log" />
        </footer>
      )}
    </Frame>
  );
}
