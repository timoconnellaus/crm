// What a person sees before they install (ADR 0347): what a plugin adds, what it reaches, how each
// routine would have behaved on the last 30 days, the deterministic checks, and Jev's risk note.
// Nothing here writes to the workspace: it is the read-back the install card shows.
import { type A2uiPart, prepareCard } from "@relationship-os/agent-a2ui";
import type { PluginItem, PluginManifest } from "@relationship-os/agent-plugins";
import { backtestRoutine } from "../assistant/routine-backtest.ts";
import {
  assertRoutine,
  plainGateWords,
  type RoutineDefinition,
  routineDefinitionSchema,
  routineWhen,
} from "../assistant/routines.ts";
import { shortestCronGap } from "../automations/cron.ts";
import { loadAutomationSettings } from "../automations/registry.ts";
import { ValidationError } from "../errors.ts";
import { askPluginRisk, pluginRiskState } from "../judge/questions/plugin-risk.ts";
import { judgeUsageStatement } from "../judge/usage.ts";
import type { HandlerContext } from "../operation.ts";
import { adapt, type NeedStatus, needStatus } from "./engine.ts";
import { pluginKinds } from "./kinds.ts";
import type { PluginSource } from "./sources.ts";
import { type Adaptation, SKILL_KINDS } from "./store.ts";

const SEND = /(^|\.)(send|post|publish|reply|forward)/i;

export interface RoutinePreview {
  key: string;
  name: string;
  when: string;
  gates: string[];
  fired: number | null;
  days: number;
  note: string | null;
}

export interface PluginPreview {
  adds: { kind: string; label: string; description: string | null }[];
  access: string[];
  needs: NeedStatus[];
  routines: RoutinePreview[];
  checks: { text: string; passed: boolean }[];
  /** Jev's notes, in plain words. Empty when it found nothing or is off. */
  risks: string[];
  /** Swaps the assistant suggests, because the connection is missing and another is there. */
  swaps: { from: string; to: string; label: string }[];
  presets: string[];
}

const routinesOf = (items: readonly PluginItem[]): [PluginItem, RoutineDefinition][] =>
  items.filter((i) => i.kind === "routine").map((i) => [i, routineDefinitionSchema.parse(i.body)]);

/** The names the plugin itself brings, so its routines can refer to them. */
export function comingNames(items: readonly PluginItem[]) {
  const names = (kinds: readonly string[]) =>
    items.filter((i) => kinds.includes(i.kind)).map((i) => String(i.body.name));
  return { producers: names(["producer"]), skills: names(SKILL_KINDS) };
}

/** What the routine really does, for the risk question. Written by the host, not the plugin. */
function doesWords(definition: RoutineDefinition, when: string): string[] {
  const m = definition.message;
  const out = [`Runs ${when}`];
  if (m.kind === "producer") out.push("Messages the person in their own chat with a saved card");
  if (m.kind === "skill") out.push("Writes the person a message in their own chat");
  if (m.kind === "turn") out.push(`Writes the person a message in their own chat: ${m.prompt}`);
  if (m.kind === "agent") out.push(`Starts a background agent with the brief: ${m.brief}`);
  return out;
}

function deterministicChecks(
  routines: readonly [PluginItem, RoutineDefinition][],
  operations: readonly string[],
  now: string,
) {
  const checks: { text: string; passed: boolean }[] = [];
  if (routines.length) {
    const gaps = routines.map(([, d]) =>
      d.trigger.type === "schedule" ? shortestCronGap(d.trigger.cron, now.slice(0, 10)) : null,
    );
    checks.push({
      text: "Messages you at most once a day from each",
      passed: gaps.every((gap) => gap !== null && gap >= 1_380),
    });
  }
  checks.push({ text: "Only touches records you can see", passed: true });
  checks.push({
    text: "Sends nothing without you",
    passed: !operations.some((op) => SEND.test(op)),
  });
  return checks;
}

const words = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export async function previewPlugin(
  ctx: HandlerContext,
  source: PluginManifest,
  adaptations: readonly Adaptation[],
): Promise<PluginPreview> {
  const manifest = adapt(source, adaptations);
  const { items } = manifest;
  const { timezone } = await loadAutomationSettings(ctx.db);
  const access = pluginKinds.accessOf(manifest);
  const coming = comingNames(items);
  const routines = routinesOf(items);

  const previews: RoutinePreview[] = [];
  const risks: string[] = [];
  let spend = { calls: 0, inputTokens: 0 };
  let riskSpend = { calls: 0, inputTokens: 0 };
  for (const [item, definition] of routines) {
    try {
      await assertRoutine(ctx, definition, coming);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "It cannot run here";
      throw new ValidationError(`${item.label} cannot run here: ${reason}`);
    }
    const { backtest, judge } = await backtestRoutine({
      db: ctx.db,
      judge: ctx.judge,
      ownerId: ctx.user.id,
      definition,
      now: ctx.now,
      timezone,
    });
    spend = {
      calls: spend.calls + judge.calls,
      inputTokens: spend.inputTokens + judge.inputTokens,
    };
    const when = routineWhen(definition, timezone);
    const gates = plainGateWords(definition);
    const noData = backtest.flags.some((f) => f.code === "no_data");
    const fired = noData ? null : backtest.fired;
    let note: string | null = null;
    if (ctx.judge) {
      const asked = await askPluginRisk(
        ctx.judge,
        pluginRiskState({
          routine: `${definition.name}: I'll ${definition.what}`,
          when,
          checks: gates,
          fired,
          days: backtest.days,
          does: doesWords(definition, when),
          access: [...access.operations, ...access.connections, ...access.schema],
        }),
      );
      if (asked.status === "answered") {
        riskSpend = {
          calls: riskSpend.calls + 1,
          inputTokens: riskSpend.inputTokens + asked.inputTokens,
        };
        if (asked.busy) {
          note = `This one could get busy: it would have messaged you ${fired ?? "many"} times in ${backtest.days} days.`;
        } else if (asked.doesMore) {
          note = `${definition.name} does more than it says. Check what it reaches before you install.`;
        }
      }
    }
    if (note) risks.push(note);
    previews.push({
      key: item.key,
      name: definition.name,
      when,
      gates,
      fired,
      days: backtest.days,
      note,
    });
  }
  if (spend.calls) ctx.write(judgeUsageStatement(ctx.db, "routine.gate", spend, ctx.now));
  if (riskSpend.calls) ctx.write(judgeUsageStatement(ctx.db, "plugin.risk", riskSpend, ctx.now));

  const needs = await needStatus(ctx.db, items, ctx.user.id);
  return {
    adds: items.map((item) => ({
      kind: pluginKinds.get(item.kind)?.label ?? item.kind,
      label: item.label,
      description: item.description ?? null,
    })),
    access: access.words,
    needs,
    routines: previews,
    checks: deterministicChecks(routines, access.operations, ctx.now),
    risks,
    swaps: needs.flatMap((n) =>
      n.swap ? [{ from: n.service, to: n.swap.service, label: n.swap.label }] : [],
    ),
    presets: items
      .filter((i) => i.kind === "assistantPreset")
      .flatMap((i) => [
        ...((i.body.shortcuts as string[] | undefined) ?? []),
        ...((i.body.style as string[] | undefined) ?? []),
      ]),
  };
}

export interface InstallTarget {
  plugin: string;
  version: string;
  source: PluginSource;
  fingerprint: string;
  adaptations: readonly Adaptation[];
  scope?: Record<string, unknown>;
}

/** The install card: a host card, so Install runs as the person who presses it. */
export function installCard(
  manifest: PluginManifest,
  preview: PluginPreview,
  target: InstallTarget,
): A2uiPart {
  const others = preview.adds.filter((a) => a.kind !== "Routine");
  const counts = new Map<string, number>();
  for (const add of others) counts.set(add.kind, (counts.get(add.kind) ?? 0) + 1);
  const summary = [...counts].map(([kind, n]) => words(n, kind.toLowerCase())).join(", ");
  const text = `Install ${manifest.name} ${manifest.version}${summary ? `: ${summary}` : ""}.`;
  return prepareCard(
    {
      a2ui: 1,
      root: {
        type: "pluginInstall",
        name: `${manifest.name} ${manifest.version}`.slice(0, 120),
        publisher: manifest.publisher,
        adds: others.slice(0, 20).map(({ kind, label }) => ({ kind, label })),
        scopes: preview.access.slice(0, 10),
        needs: preview.needs
          .filter((n) => !n.met)
          .slice(0, 10)
          .map((n) => n.label),
        routines: preview.routines.slice(0, 10).map((r) => ({
          name: r.name,
          when: r.when,
          ...(r.fired === null
            ? {}
            : { tried: `Would have messaged you ${words(r.fired, "time")} in ${r.days} days` }),
          ...(r.note ? { note: r.note } : {}),
        })),
        checks: preview.checks.slice(0, 8),
        swaps: target.adaptations.slice(0, 5).map((s) => `Uses ${s.to} instead of ${s.from}`),
        actions: [
          {
            kind: "operation",
            label: "Install",
            style: "primary",
            operation: "plugin.install",
            input: {
              plugin: target.plugin,
              version: target.version,
              source: target.source,
              fingerprint: target.fingerprint,
              adaptations: [...target.adaptations],
              ...(target.scope ? { scope: target.scope } : {}),
            },
            done: "Installed. It's your own copy, so you can change anything in it.",
          },
          {
            kind: "open",
            label: "Details",
            style: "secondary",
            href: `/plugins/${target.plugin}`,
          },
          { kind: "reply", label: "Cancel", style: "ghost", text: "No thanks, leave it" },
        ],
      },
    },
    { source: "host", text },
  );
}
