// Compaction of the person's one thread (ADR 0341): everything the AssistantAgent does about it,
// behind a few hook points. agent-core holds the maths and the thread helpers; this holds the
// state and the timing.
//
// At each turn's end it turns the provider's usage into cache observations and usage stats, runs
// the planner, and either compacts or sets the one idle alarm just before the estimated cache
// expiry. When the alarm fires it asks the planner again. The review data rides on the turn's own
// D1 write; only an idle alarm or a finished compaction makes one of its own.
//
// A compaction asks the model for a "where we left off" note over the same prefix and history the
// last turn sent, so the call reads them from the cache, and then commits two values in one
// transaction: the note and the seq it covers. The thread's messages are never touched, so they all
// stay searchable. Nothing else changes until that commit, which is why a turn arriving during
// the summary call simply runs on the pre-compaction context: the compaction then commits, and
// that turn's messages, being after the seq, are the messages since the compaction.
import {
  advanceDecisions,
  type CompactionCut,
  ceilingCut,
  compactedTokens,
  compactionCut,
  contextTokensAfter,
  cacheObservations,
  emptyUsageState,
  historyForModel,
  type LastRequest,
  messageChars,
  NOTE_REQUEST,
  NOTE_TOKENS,
  observeTurn,
  type OpenDecision,
  type PlanDecision,
  type PlanInput,
  planCompaction,
  runTurn,
  type SqliteMessageStore,
  type StepUsage,
  turnCost,
  type TurnModel,
  type TurnTool,
  type UsageState,
  usageProfile,
} from "@relationship-os/agent-core";
import type { CacheEstimate, CacheRails, CacheReview } from "@relationship-os/core";

/** The role compaction runs on: the front agent's own, so the summary call reads its cache. */
export const COMPACTION_ROLE = "assistant.core";

/** Planned with when a model does not say how large its window is. */
const UNKNOWN_WINDOW_TOKENS = 32_000;

/** Longest note kept, whatever the model wrote. */
const NOTE_MAX_CHARS = 4_000;

/** Roughly four characters a token, for a provider that reports no usage. */
const CHARS_PER_TOKEN = 4;

/** A model as the planner needs it. */
export interface PlanModel {
  provider: string;
  modelId: string;
  pricing: {
    input: number;
    cacheWrite: number;
    cachedInput: number;
    output: number;
    cacheLifetimeSeconds: number | null;
  } | null;
  contextTokens: number;
}

/** What a summary call needs from the host: the last turn's prefix, rebuilt byte for byte. */
export interface SummaryRequest {
  models: readonly TurnModel[];
  system: string;
  tools: readonly TurnTool[];
  prefixHash: string;
  close(): Promise<void>;
}

/** The AssistantAgent, as compaction sees it. */
export interface CompactionHost {
  meta(key: string): string | null;
  setMeta(key: string, value: string): void;
  store: SqliteMessageStore;
  transaction(run: () => void): void;
  turnRunning(): boolean;
  setAlarm(at: Date): Promise<string>;
  cancelAlarm(id: string): Promise<void>;
  rails(): Promise<CacheRails>;
  openSummary(): Promise<SummaryRequest>;
  /** Writes review data outside a turn. */
  record(review: CacheReview): Promise<CacheEstimate | null>;
  /** Folds pending memory lines into the memory block (ADR 0342), just before a compaction commits. */
  foldPendingLines(): Promise<void>;
}

/** Everything the planner remembers between turns, in one row. */
interface CompactionState {
  last: LastRequest | null;
  /** When the person's last turn made its first request (epoch ms): their reply gap. */
  lastTurnAt: number | null;
  usage: UsageState;
  /** C, in tokens. */
  contextTokens: number;
  /** False when `contextTokens` is an estimate (right after a compaction). */
  measured: boolean;
  prefixChars: number;
  model: PlanModel | null;
  estimate: CacheEstimate | null;
  open: OpenDecision[];
  alarmId: string | null;
}

function emptyState(): CompactionState {
  return {
    last: null,
    lastTurnAt: null,
    usage: emptyUsageState(),
    contextTokens: 0,
    measured: false,
    prefixChars: 0,
    model: null,
    estimate: null,
    open: [],
    alarmId: null,
  };
}

export interface FinishedTurn {
  steps: readonly StepUsage[];
  prefixHash: string;
  prefixChars: number;
  model: PlanModel;
  /** The compaction seq the turn's context was assembled with. */
  since: number;
  /** The turn's own first message: where its history ended. */
  now: number;
}

interface Flight {
  cut: CompactionCut;
  /** A message the note would cover was deleted: the note must not be kept. */
  abandoned: boolean;
  /** Erases that arrived during the summary call: applied to the note before it is kept. */
  scrubs: RegExp[];
}

function observationRecords(
  observations: ReturnType<typeof cacheObservations>["observations"],
): CacheReview["observations"] {
  return observations.map((o) => ({
    provider: o.provider,
    model: o.modelId,
    role: COMPACTION_ROLE,
    at: new Date(o.at).toISOString(),
    gapSeconds: o.gapSeconds,
    prefixUnchanged: o.prefixUnchanged,
    cachedTokens: o.cachedTokens,
    promptTokens: o.promptTokens,
    prefixTokens: o.prefixTokens ?? null,
  }));
}

function reviewModel(model: PlanModel): CacheReview["model"] {
  return {
    provider: model.provider,
    model: model.modelId,
    publishedLifetimeSeconds: model.pricing?.cacheLifetimeSeconds ?? null,
  };
}

export class ThreadCompaction {
  #flight: Flight | null = null;
  /** What the turn that just finished decided, for `afterTurn`. */
  #next: { plan: PlanDecision; cut: CompactionCut | null } | null = null;

  constructor(private readonly host: CompactionHost) {}

  #state(): CompactionState {
    const raw = this.host.meta("compaction_state");
    return raw ? { ...emptyState(), ...(JSON.parse(raw) as Partial<CompactionState>) } : emptyState();
  }

  #save(state: CompactionState) {
    this.host.setMeta("compaction_state", JSON.stringify(state));
  }

  /** The note of the last compaction, for the prefix. */
  note(): string | undefined {
    return this.host.meta("compaction_note") || undefined;
  }

  /** The seq the last compaction covers: the model sees the messages after it. */
  since(): number {
    return Number(this.host.meta("compaction_seq") ?? 0);
  }

  get compacting(): boolean {
    return this.#flight !== null;
  }

  /** A new turn cancels the idle alarm (ADR 0341). Most threads never have one. */
  async turnStarted() {
    const state = this.#state();
    if (!state.alarmId) return;
    const id = state.alarmId;
    this.#save({ ...state, alarmId: null });
    await this.host.cancelAlarm(id).catch((error: unknown) => {
      console.warn("assistant: could not cancel the idle alarm", error);
    });
  }

  /** The live messages since the last compaction. */
  #live() {
    return this.host.store.list({ afterSeq: this.since() });
  }

  #lifetime(state: CompactionState, model: PlanModel): PlanInput["lifetime"] {
    const e = state.estimate;
    if (e && e.provider === model.provider && e.model === model.modelId) {
      return { seconds: e.seconds, source: e.source, confidence: e.confidence };
    }
    const published = model.pricing?.cacheLifetimeSeconds ?? null;
    return { seconds: published, source: published === null ? "fallback" : "published" };
  }

  /** The planner over the thread as it stands, and the cut a compaction would make. */
  #plan(
    state: CompactionState,
    model: PlanModel,
    rails: CacheRails,
    moment: PlanInput["moment"],
    now: number,
    lastRequestAt: number,
  ): { input: PlanInput; plan: PlanDecision; cut: CompactionCut | null } {
    const live = this.#live();
    const historyChars = live.reduce((n, m) => n + messageChars(m), 0);
    const size = (keptChars: number) =>
      compactedTokens({
        contextTokens: state.contextTokens,
        prefixChars: state.prefixChars,
        historyChars,
        keptChars,
      });
    const usage = usageProfile(state.usage);
    const normal = compactionCut(live);
    const input: PlanInput = {
      moment,
      now,
      lastRequestAt,
      contextTokens: state.contextTokens,
      // With nothing to fold, compacting would save nothing.
      compactedTokens: normal ? size(normal.keptChars) : state.contextTokens,
      noteTokens: NOTE_TOKENS,
      contextWindow: model.contextTokens || UNKNOWN_WINDOW_TOKENS,
      prices: model.pricing
        ? {
            input: model.pricing.input,
            output: model.pricing.output,
            cacheWrite: model.pricing.cacheWrite,
            cachedInput: model.pricing.cachedInput,
          }
        : { input: null, output: null },
      lifetime: this.#lifetime(state, model),
      usage,
      rails: { minTokens: rails.minTokens, maxShareOfWindow: rails.maxShareOfWindow },
      params: { fallbackIdleSeconds: rails.fallbackIdleMinutes * 60 },
    };
    const plan = planCompaction(input);
    // Only the ceiling may keep fewer than the usual exchanges: the context must fit.
    const cut =
      plan.rule === "ceiling"
        ? ceilingCut(
            live,
            (c) => size(c.keptChars) + usage.addedTokensPerTurn < plan.ceilingTokens,
          )
        : normal;
    return { input, plan, cut };
  }

  #decisionRecord(
    id: string,
    model: PlanModel,
    input: PlanInput,
    plan: PlanDecision,
  ): CacheReview["decisions"][number] {
    return {
      id,
      provider: model.provider,
      model: model.modelId,
      role: COMPACTION_ROLE,
      at: new Date(input.now).toISOString(),
      input,
      result: {
        decision: plan.decision,
        rule: plan.rule,
        costContinue: plan.costContinue,
        costCompact: plan.costCompact,
        horizonTurns: plan.horizonTurns,
        nextAlarmAt: plan.nextAlarmAt,
      },
      actual: null,
    };
  }

  /**
   * The turn is stored: learn from its usage and plan. Returns the review data for the turn's D1
   * write. Only local work and one read of the rails, so the turn's end is not held up.
   */
  async finishTurn(turn: FinishedTurn): Promise<CacheReview> {
    const state = this.#state();
    const review: CacheReview = {
      role: COMPACTION_ROLE,
      model: reviewModel(turn.model),
      observations: [],
      decisions: [],
      actuals: [],
    };
    const { observations, last } = cacheObservations(turn.steps, turn.prefixHash, state.last);
    review.observations = observationRecords(observations);
    state.last = last;

    // A compaction that committed during this turn: the turn's sizes are of the older context.
    const rebased = this.since() !== turn.since;
    const historyChars = () =>
      this.host.store.list({ afterSeq: turn.since }).reduce((n, m) => n + messageChars(m), 0);
    const measured = contextTokensAfter(turn.steps);
    const before = usageProfile(state.usage);
    const tokens =
      measured ?? Math.round((turn.prefixChars + historyChars()) / CHARS_PER_TOKEN);
    const first = turn.steps[0];
    if (first) {
      const added =
        state.measured && !rebased
          ? Math.max(0, tokens - state.contextTokens)
          : before.addedTokensPerTurn;
      state.usage = observeTurn(state.usage, {
        at: first.startedAt,
        gapSeconds:
          state.lastTurnAt !== null
            ? Math.max(0, (first.startedAt - state.lastTurnAt) / 1000)
            : null,
        addedTokens: added,
        outputTokens: turn.steps.reduce((n, s) => n + (s.outputTokens ?? 0), 0),
      });
      state.lastTurnAt = first.startedAt;
    }
    state.contextTokens = rebased
      ? compactedTokens({
          contextTokens: tokens,
          prefixChars: turn.prefixChars,
          historyChars: historyChars(),
          keptChars: this.#live().reduce((n, m) => n + messageChars(m), 0),
        })
      : tokens;
    state.measured = measured !== null && !rebased;
    state.prefixChars = turn.prefixChars;
    state.model = turn.model;

    const spent = turnCost(turn.steps, turn.model.pricing);
    const advanced = advanceDecisions(state.open, spent, true);
    state.open = advanced.open;
    review.actuals = advanced.closed;

    // A compaction is under way: it decides this thread's size, so there is nothing to plan.
    if (!this.#flight) {
      const rails = await this.host.rails();
      const { input, plan, cut } = this.#plan(
        state,
        turn.model,
        rails,
        "turn-end",
        turn.now,
        last?.at ?? turn.now,
      );
      const id = crypto.randomUUID();
      review.decisions = [this.#decisionRecord(id, turn.model, input, plan)];
      if (turn.model.pricing) {
        state.open.push({ id, target: Math.ceil(plan.horizonTurns), turns: 0, cost: 0 });
      }
      this.#next = { plan, cut };
    }
    this.#save(state);
    return review;
  }

  /** Keeps the estimate the turn's write answered with, for the next plan. */
  rememberEstimate(estimate: CacheEstimate | null) {
    if (!estimate) return;
    const state = this.#state();
    const e = state.estimate;
    if (
      e?.seconds === estimate.seconds &&
      e.source === estimate.source &&
      e.provider === estimate.provider &&
      e.model === estimate.model &&
      e.confidence === estimate.confidence
    ) {
      return;
    }
    this.#save({ ...state, estimate });
  }

  /** After the turn has ended for its readers: compact, or set the idle alarm. Never throws. */
  async afterTurn() {
    const next = this.#next;
    this.#next = null;
    if (!next) return;
    try {
      await this.#act(next.plan, next.cut);
    } catch (error) {
      console.warn("assistant: compaction failed", error);
    }
  }

  async #act(plan: PlanDecision, cut: CompactionCut | null) {
    if (plan.decision === "compact") {
      if (cut) await this.#compact(cut);
      return;
    }
    if (plan.nextAlarmAt === null || this.host.turnRunning()) return;
    const id = await this.host.setAlarm(new Date(plan.nextAlarmAt));
    this.#save({ ...this.#state(), alarmId: id });
  }

  /** The idle alarm fired: the cache is about to expire. Ask the planner again. */
  async idleAlarm() {
    try {
      const state = this.#state();
      state.alarmId = null;
      this.#save(state);
      // A turn's end plans again, and a compaction under way is already the answer.
      if (this.host.turnRunning() || this.#flight || !state.model || !state.last) return;
      const rails = await this.host.rails();
      const now = Date.now();
      const { input, plan, cut } = this.#plan(
        state,
        state.model,
        rails,
        "idle",
        now,
        state.last.at,
      );
      const id = crypto.randomUUID();
      if (state.model.pricing) {
        this.#save({
          ...state,
          open: [...state.open, { id, target: Math.ceil(plan.horizonTurns), turns: 0, cost: 0 }],
        });
      }
      await this.host.record({
        role: COMPACTION_ROLE,
        model: reviewModel(state.model),
        observations: [],
        decisions: [this.#decisionRecord(id, state.model, input, plan)],
        actuals: [],
      });
      await this.#act(plan, cut);
    } catch (error) {
      console.warn("assistant: the idle alarm failed", error);
    }
  }

  async #compact(cut: CompactionCut) {
    if (this.#flight || this.host.turnRunning()) return;
    const flight: Flight = { cut, abandoned: false, scrubs: [] };
    this.#flight = flight;
    try {
      await this.#run(flight);
    } finally {
      this.#flight = null;
    }
  }

  async #run(flight: Flight) {
    const before = this.#state();
    const live = this.#live();
    const request = await this.host.openSummary();
    let steps: StepUsage[];
    let note: string;
    try {
      const window = before.model?.contextTokens || UNKNOWN_WINDOW_TOKENS;
      const result = await runTurn({
        models: request.models,
        system: request.system,
        // The same bytes the last turn sent, then the request. Trimmed only when the thread has
        // outgrown the window, when no cache is worth keeping.
        messages: [
          ...historyForModel(live, window * CHARS_PER_TOKEN * 0.8),
          { role: "user", content: NOTE_REQUEST },
        ],
        tools: request.tools,
        emit: () => {},
        maxSteps: 1,
        toolChoice: "none",
      });
      steps = result.steps;
      note = result.status === "done" ? result.text.trim().slice(0, NOTE_MAX_CHARS) : "";
    } finally {
      await request.close();
    }

    if (note) await this.host.foldPendingLines();

    // Read now: a turn may have finished during the summary call, and it counts too.
    const state = this.#state();
    const { observations, last } = cacheObservations(steps, request.prefixHash, state.last);
    const newest = last && state.last && last.at < state.last.at ? state.last : last;
    const spent = turnCost(steps, state.model?.pricing ?? null);
    const advanced = advanceDecisions(state.open, spent, false);
    const review: CacheReview | null = state.model
      ? {
          role: COMPACTION_ROLE,
          model: reviewModel(state.model),
          observations: observationRecords(observations),
          decisions: [],
          actuals: [],
        }
      : null;

    const commit = Boolean(note) && !flight.abandoned;
    if (commit) {
      for (const pattern of flight.scrubs) note = note.replace(pattern, "[erased]");
    }
    this.host.transaction(() => {
      const next: CompactionState = { ...state, last: newest, open: advanced.open };
      if (commit) {
        const messages = this.#live();
        const historyChars = messages.reduce((n, m) => n + messageChars(m), 0);
        const keptChars = messages
          .filter((m) => m.seq > flight.cut.boundary)
          .reduce((n, m) => n + messageChars(m), 0);
        next.contextTokens = compactedTokens({
          contextTokens: state.contextTokens,
          prefixChars: state.prefixChars,
          historyChars,
          keptChars,
        });
        next.measured = false;
        this.host.setMeta("compaction_note", note);
        this.host.setMeta("compaction_seq", String(flight.cut.boundary));
      }
      this.#save(next);
    });
    if (review && review.observations.length) await this.host.record(review);
    if (!commit) console.warn("assistant: compaction wrote no note; the thread stays as it is");
  }

  /**
   * Messages were deleted. The note may repeat what they said, and a deleted message must be gone
   * from what the model sees, so a note covering one is dropped: the messages it covered stay
   * searchable and the next compaction starts afresh.
   */
  deleted(seqs: readonly number[]) {
    const flight = this.#flight;
    if (flight && seqs.some((s) => s <= flight.cut.boundary)) flight.abandoned = true;
    if (seqs.some((s) => s <= this.since()) && this.note()) {
      this.host.setMeta("compaction_note", "");
    }
  }

  /** An erase: the note loses the subject too, and so does one being written. */
  scrub(pattern: RegExp) {
    this.#flight?.scrubs.push(pattern);
    const note = this.note();
    if (!note) return;
    const scrubbed = note.replace(pattern, "[erased]");
    if (scrubbed !== note) this.host.setMeta("compaction_note", scrubbed);
  }
}
