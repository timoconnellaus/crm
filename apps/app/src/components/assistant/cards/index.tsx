// The CRM's component map (ADR 0346): one component per catalogue type, built with packages/ui.
// `Required` makes a new catalogue component a type error here until it has a renderer.
import type { A2uiPart, ComponentType } from "@relationship-os/agent-a2ui";
import { A2uiView, type ComponentMap } from "@relationship-os/agent-a2ui/react";
import { useMemo } from "react";
import { Markdown } from "../../markdown.tsx";
import {
  ActionsComponent,
  BadgeComponent,
  CardComponent,
  DividerComponent,
  EmptyStateComponent,
  HeadingComponent,
  ImageComponent,
  KeyValueComponent,
  LinkComponent,
  ListComponent,
  ProgressComponent,
  RecordCardComponent,
  RecordChipComponent,
  RecordDiffComponent,
  RecordListComponent,
  RelatedRecordsComponent,
  SearchResultsComponent,
  StackComponent,
  TableComponent,
  TextComponent,
} from "./basics.tsx";
import {
  ChoiceComponent,
  ConfirmComponent,
  FileUploadComponent,
  FormComponent,
  RecordFormComponent,
} from "./forms.tsx";
import { CardHostContext, cardActions, useCardHost } from "./host.tsx";
import { ChartComponent, KpiComponent, LeaderboardComponent } from "./numbers.tsx";
import {
  AgentConnectionRequestComponent,
  AgentLogEntryComponent,
  AgentRequestComponent,
  ApprovalComponent,
  ConditionalMemoryReadBackComponent,
  ConnectionNeededComponent,
  MemorySavedComponent,
  PluginInstallComponent,
  PluginUpdateComponent,
  RoutineListComponent,
  RoutineReadBackComponent,
  WhyThisComponent,
} from "./system.tsx";
import {
  AvailabilitySlotsComponent,
  DealCardComponent,
  DealListComponent,
  EmailDraftComponent,
  EmailPreviewComponent,
  LoggerComponent,
  MeetingCardComponent,
  MeetingPrepComponent,
  PipelineSnapshotComponent,
  StageMoveConfirmComponent,
  TaskCardComponent,
  TaskListComponent,
  TimelineComponent,
} from "./work.tsx";

export const crmCards: Required<ComponentMap> & Record<ComponentType, unknown> = {
  card: CardComponent,
  stack: StackComponent,
  text: TextComponent,
  heading: HeadingComponent,
  divider: DividerComponent,
  keyValue: KeyValueComponent,
  badge: BadgeComponent,
  recordChip: RecordChipComponent,
  list: ListComponent,
  table: TableComponent,
  actions: ActionsComponent,
  link: LinkComponent,
  image: ImageComponent,
  progress: ProgressComponent,
  emptyState: EmptyStateComponent,
  recordCard: RecordCardComponent,
  recordList: RecordListComponent,
  recordDiff: RecordDiffComponent,
  searchResults: SearchResultsComponent,
  relatedRecords: RelatedRecordsComponent,
  taskList: TaskListComponent,
  taskCard: TaskCardComponent,
  timeline: TimelineComponent,
  emailPreview: EmailPreviewComponent,
  emailDraft: EmailDraftComponent,
  logger: LoggerComponent,
  dealCard: DealCardComponent,
  dealList: DealListComponent,
  pipelineSnapshot: PipelineSnapshotComponent,
  stageMoveConfirm: StageMoveConfirmComponent,
  meetingCard: MeetingCardComponent,
  meetingPrep: MeetingPrepComponent,
  availabilitySlots: AvailabilitySlotsComponent,
  kpi: KpiComponent,
  chart: ChartComponent,
  leaderboard: LeaderboardComponent,
  recordForm: RecordFormComponent,
  form: FormComponent,
  choice: ChoiceComponent,
  confirm: ConfirmComponent,
  fileUpload: FileUploadComponent,
  approval: ApprovalComponent,
  routineReadBack: RoutineReadBackComponent,
  routineList: RoutineListComponent,
  whyThis: WhyThisComponent,
  memorySaved: MemorySavedComponent,
  conditionalMemoryReadBack: ConditionalMemoryReadBackComponent,
  pluginInstall: PluginInstallComponent,
  pluginUpdate: PluginUpdateComponent,
  connectionNeeded: ConnectionNeededComponent,
  agentConnectionRequest: AgentConnectionRequestComponent,
  agentRequest: AgentRequestComponent,
  agentLogEntry: AgentLogEntryComponent,
};

/** A card's text fallback: what it says when it cannot be drawn. */
function CardFallback({ text }: { text: string; problems?: string[] }) {
  return (
    <div data-testid="a2ui-fallback">
      <Markdown noImages>{text}</Markdown>
    </div>
  );
}

/** One stored card, drawn for the CardHost around it. */
export function Card({ part }: { part: A2uiPart }) {
  const host = useCardHost();
  const onAction = useMemo(() => cardActions(host), [host]);
  return <A2uiView part={part} components={crmCards} onAction={onAction} Fallback={CardFallback} />;
}

export { CardHostContext };
