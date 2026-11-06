// The placements (ADR 0230, docs/jev.md "The placements"): every named place in the code that asks
// the judge, with its fail mode, its timeout, what evidence it sends and whether it is on by
// default. Code asks for a placement, never a model.
//
// Defaults: a placement that sends only a person's request, a manifest or a prompt is on when the
// judge has a key. A placement that sends record content (summaries and their facts, outbound
// messages, signatures) is off in a fresh install; a deployment turns it on with the
// JUDGE_PLACEMENTS deploy var, or an admin does in Settings → AI (`judge.update`). TypeSafe
// processes in the US with zero retention only on request: ask for it before a hosted (SaaS)
// tenant can turn a record-content placement on (docs/jev.md, "Data handling").

export type JudgeFailMode =
  /** Advice: carry on as without the judge, and say it did not check. */
  | "open"
  /** Anything looser or unseen waits for a person. */
  | "closed"
  /** Open for record, meeting and activity summaries; closed for change-set summaries. */
  | "open-except-change-sets"
  /** An eval grader: a case with no answer is "could not be checked", never a pass. */
  | "never-a-pass";

export interface JudgePlacement {
  id: string;
  label: string;
  /** Where it asks, for Settings → AI. */
  askedWhen: string;
  failMode: JudgeFailMode;
  /** What happens when the judge cannot answer, in a sentence. */
  onFailure: string;
  /** Per call, before the answer is `timeout`. */
  timeoutMs: number;
  /** What goes to TypeSafe, for Settings → AI's data note. */
  sends: string;
  /** Sends CRM record content (not only a person's request, a manifest or a prompt). */
  sendsRecordContent: boolean;
  /**
   * On by default when the judge has a key. False for record content. The adjudicator's placement
   * has no switch: it follows the adjudicator's reviewer (`adjudicatorReviewer`).
   */
  defaultOn: boolean;
  /** Has an admin switch in Settings → AI. */
  switchable: boolean;
  /** Built and asked in this release (false: declared for its build step, never asked yet). */
  built: boolean;
  /**
   * Its calls are counted in core_judge_usage, in the batch that stores their result (ADR 0234).
   * False where nothing is stored (widget.describe writes nothing): the Workers log only.
   */
  spendCounted: boolean;
}

const place = <const T extends JudgePlacement>(p: T) => p;

export const JUDGE_PLACEMENTS = [
  place({
    id: "authoring.intent",
    label: "Automations and extensions against the request",
    askedWhen: "extension.check (given the request) and extension.propose",
    failMode: "open",
    onFailure:
      "The check passes without intent findings, with an intent/unchecked note; the approval screen says it was not checked",
    timeoutMs: 4_000,
    sends:
      "The person's request words and the manifest's declarations (trigger, conditions, steps, recipients)",
    sendsRecordContent: false,
    defaultOn: true,
    switchable: true,
    built: true,
    spendCounted: true,
  }),
  place({
    id: "adjudicator.policy",
    label: "The policy adjudicator's Jev reviewer",
    askedWhen: "The adjudicator, when its reviewer is Jev",
    failMode: "closed",
    onFailure: "The action escalates to a person (note judge_unavailable); never the LLM reviewer",
    timeoutMs: 10_000,
    sends: "The policy rules, the operation, and the diff's before and after values",
    sendsRecordContent: true,
    defaultOn: true,
    switchable: false,
    built: true,
    spendCounted: true,
  }),
  place({
    id: "summary.statements",
    label: "Summary statements against their facts",
    askedWhen: "summary.generate (record, meeting and change-set summaries), never on read",
    failMode: "open-except-change-sets",
    onFailure:
      "Stored with a Not checked mark; a change-set summary is withheld and the approver sees the diff",
    timeoutMs: 4_000,
    sends:
      "The summary and its facts: record fields, activity text, and email bodies where the mailbox shares full content",
    sendsRecordContent: true,
    defaultOn: false,
    switchable: true,
    built: true,
    spendCounted: true,
  }),
  place({
    id: "outbound.message",
    label: "Model-written messages before they leave",
    askedWhen:
      "An outbound message (email, chat post) from an AI actor; never notification delivery's templates",
    failMode: "closed",
    onFailure:
      "An action that would have left unreviewed waits for a person, marked could not be checked",
    timeoutMs: 6_000,
    sends: "The message, the person's request, and facts about the records it names",
    sendsRecordContent: true,
    defaultOn: false,
    switchable: true,
    built: true,
    spendCounted: true,
  }),
  place({
    id: "sync.jobChange",
    label: "Job changes from email signatures",
    askedWhen: "sync.ingest, only when a known person's signature changed",
    failMode: "open",
    onFailure: "Today's string compare decides",
    timeoutMs: 3_000,
    sends:
      "The new signature block with phone, email and web lines removed, what the last one said (title and company), and the person's name, organisation and title; only from mailboxes that share full content",
    sendsRecordContent: true,
    defaultOn: false,
    switchable: true,
    built: true,
    spendCounted: true,
  }),
  place({
    id: "widget.shape",
    label: "Widget shape from the prompt",
    askedWhen: "widget.describe",
    failMode: "open",
    onFailure: "The widget is generated without the shape hint or the shape check",
    timeoutMs: 3_000,
    sends: "The person's prompt",
    sendsRecordContent: false,
    defaultOn: true,
    switchable: true,
    built: true,
    spendCounted: false,
  }),
  place({
    id: "memory.write",
    label: "Memory lines before the assistant saves them",
    askedWhen: "memory.propose and teamMemory.propose, when the assistant saves a line from the chat",
    failMode: "closed",
    onFailure:
      "The deterministic checks decide what they can, and the line is read back and saved only when the person confirms",
    timeoutMs: 4_000,
    sends: "The person's words this turn, the line, and the lines already in memory",
    sendsRecordContent: false,
    defaultOn: true,
    switchable: true,
    built: true,
    spendCounted: true,
  }),
  place({
    id: "memory.condition",
    label: "A conditional memory's filter against the person's words",
    askedWhen: "memory.propose for a line that holds only on some records",
    failMode: "closed",
    onFailure: "The condition is read back in words and saved only when the person confirms",
    timeoutMs: 4_000,
    sends: "The person's words this turn, the line, and the filter written out in words",
    sendsRecordContent: false,
    defaultOn: true,
    switchable: true,
    built: true,
    spendCounted: true,
  }),
  place({
    id: "judge.test",
    label: "Settings → AI's Test button and the calibration preflight",
    askedWhen: "An admin's Test, and before a calibration run",
    failMode: "open",
    onFailure: "Says which failure it was",
    timeoutMs: 8_000,
    sends: "A fixed sentence",
    sendsRecordContent: false,
    defaultOn: true,
    switchable: false,
    built: true,
    spendCounted: false,
  }),
  place({
    id: "eval.automations",
    label: "The automations eval's intent grader",
    askedWhen: "Eval runs only",
    failMode: "never-a-pass",
    onFailure: "The case could not be checked, and the run fails",
    timeoutMs: 15_000,
    sends: "Hand-written eval prompts and the manifests a model wrote for them",
    sendsRecordContent: false,
    defaultOn: true,
    switchable: false,
    built: true,
    spendCounted: false,
  }),
] as const satisfies readonly JudgePlacement[];

export type JudgePlacementId = (typeof JUDGE_PLACEMENTS)[number]["id"];

export const JUDGE_PLACEMENT_IDS = JUDGE_PLACEMENTS.map((p) => p.id) as JudgePlacementId[];

export function isJudgePlacement(value: unknown): value is JudgePlacementId {
  return typeof value === "string" && (JUDGE_PLACEMENT_IDS as string[]).includes(value);
}

export function placementInfo(id: JudgePlacementId): JudgePlacement {
  return JUDGE_PLACEMENTS.find((p) => p.id === id) as JudgePlacement;
}

/** Placements with an admin switch. */
export const SWITCHABLE_PLACEMENTS = JUDGE_PLACEMENTS.filter((p) => p.switchable).map(
  (p) => p.id,
) as JudgePlacementId[];
