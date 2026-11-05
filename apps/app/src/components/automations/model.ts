// The automation UI's wording, as pure functions (unit-tested in test/automations-model.test.ts):
// status labels and tones, run outcome text ("Waiting (day 1 of 3)", "Failed step 1 · retried ✓"),
// the test-mode report as lines, the provenance line, diagram text with inline code, durations,
// compact relative times and where a notification links to.
import type {
  AutomationDetail,
  AutomationListItem,
  AutomationTestReport,
  NotificationItem,
  NotificationLink,
  RunItem,
  RunStatus,
  RunStepRecord,
} from "@relationship-os/core";

export type AutomationStatus = AutomationListItem["status"];

export const STATUS_LABELS: Record<AutomationStatus, string> = {
  active: "Active",
  disabled: "Disabled",
  paused: "Paused",
  killed: "Killed",
  removed: "Removed",
};

/** Pill colours: active green, paused/disabled amber, killed red, removed grey. */
export type Tone = "ok" | "fail" | "pause" | "muted";

export function statusTone(status: AutomationStatus): Tone {
  switch (status) {
    case "active":
      return "ok";
    case "killed":
      return "fail";
    case "paused":
    case "disabled":
      return "pause";
    default:
      return "muted";
  }
}

/** Text colour classes per tone (the reference's .ok, .fail, .pause). */
export const TONE_TEXT: Record<Tone, string> = {
  ok: "text-green-700 dark:text-green-400",
  fail: "text-red-700 dark:text-red-400",
  pause: "text-amber-800 dark:text-amber-300",
  muted: "text-muted-foreground",
};

/** Pill classes per tone (the reference's .pill). */
export const TONE_PILL: Record<Tone, string> = {
  ok: "bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-300",
  fail: "bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300",
  pause: "bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300",
  muted: "bg-muted text-muted-foreground",
};

const DAY = 86_400_000;

/** The run fields the outcome needs (a RunItem, or a partial one in tests). */
export type RunOutcomeInput = Pick<RunItem, "status" | "statusReason" | "outcomeText"> & {
  steps: readonly unknown[];
};

function stepsOf(run: { steps: readonly unknown[] }): RunStepRecord[] {
  return run.steps.filter(
    (s): s is RunStepRecord =>
      Boolean(s) && typeof s === "object" && typeof (s as RunStepRecord).name === "string",
  );
}

function retriedStepIndex(steps: readonly RunStepRecord[]): number {
  return steps.findIndex((s) => (s.attempts ?? 1) > 1 && s.status === "completed");
}

/** How a run's outcome reads, coloured: the server's `outcomeText` when it has one. */
export function runOutcome(
  run: RunOutcomeInput,
  now: number = Date.now(),
): {
  text: string;
  tone: Tone;
} {
  const tone = runTone(run);
  if (run.outcomeText.trim()) return { text: run.outcomeText, tone };
  return { text: fallbackOutcomeText(run, now), tone };
}

export function runTone(run: Pick<RunOutcomeInput, "status" | "steps">): Tone {
  switch (run.status) {
    case "completed":
      // A step that failed and then succeeded on retry reads as a (recovered) failure.
      return retriedStepIndex(stepsOf(run)) >= 0 ? "fail" : "ok";
    case "failed":
    case "expired":
      return "fail";
    case "waiting":
    case "review":
    case "queued":
    case "running":
      return "pause";
    default:
      return "muted";
  }
}

/** "Waiting (day 1 of 3)", "Failed step 1 · retried ✓", "Waiting for approval", ... */
export function fallbackOutcomeText(run: RunOutcomeInput, now: number = Date.now()): string {
  const steps = stepsOf(run);
  const reason = run.statusReason ? ` (${run.statusReason})` : "";
  switch (run.status) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "waiting": {
      const step = steps.findLast((s) => s.status === "waiting");
      if (step?.kind === "sleep" && step.until) {
        const start = Date.parse(step.startedAt);
        const end = Date.parse(step.until);
        if (!Number.isNaN(start) && !Number.isNaN(end) && end - start >= DAY) {
          const total = Math.round((end - start) / DAY);
          const day = Math.min(total, Math.max(1, Math.floor((now - start) / DAY) + 1));
          return `Waiting (day ${day} of ${total})`;
        }
        return `Waiting until ${new Date(end).toISOString().slice(11, 16)} UTC`;
      }
      if (step?.kind === "waitForEvent") return "Waiting for an event";
      return "Waiting";
    }
    case "review":
      return "Waiting for approval";
    case "completed": {
      const retried = retriedStepIndex(steps);
      return retried >= 0 ? `Failed step ${retried + 1} · retried ✓` : "Completed";
    }
    case "failed": {
      const failed = steps.findIndex((s) => s.status === "failed");
      return failed >= 0 ? `Failed step ${failed + 1}` : `Failed${reason}`;
    }
    case "cancelled":
      return `Cancelled${reason}`;
    case "expired":
      return "Expired (approval not decided)";
    case "skipped":
      return `Skipped${reason}`;
  }
}

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
  review: "Waiting for approval",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  expired: "Expired",
  skipped: "Skipped",
};

/** "3 days", "2 hours", "1.5 minutes": the largest unit that fits, to one decimal. */
export function formatDuration(ms: number): string {
  const units: [string, number][] = [
    ["week", 7 * DAY],
    ["day", DAY],
    ["hour", 3_600_000],
    ["minute", 60_000],
    ["second", 1000],
  ];
  for (const [unit, size] of units) {
    // Weeks only when whole: "10 days", not "1.4 weeks".
    if (unit === "week" && ms % size !== 0) continue;
    if (ms >= size) {
      const n = Math.round((ms / size) * 10) / 10;
      return `${n} ${unit}${n === 1 ? "" : "s"}`;
    }
  }
  return `${ms} ms`;
}

/** Step timing: "120 ms", "1.4 s", "2 min". */
export function formatMs(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${Math.round(ms / 100) / 10} s`;
  return `${Math.round(ms / 60_000)} min`;
}

/** "just now", "5m ago", "2h ago", "yesterday", "3d ago", then the date. */
export function compactRelative(value: string | null | undefined, now: number = Date.now()) {
  if (!value) return "";
  const at = Date.parse(value);
  if (Number.isNaN(at)) return value;
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 2 * 86_400) return "yesterday";
  if (seconds < 30 * 86_400) return `${Math.floor(seconds / 86_400)}d ago`;
  return new Date(at).toISOString().slice(0, 10);
}

/** "Deals extension · v3 · written by Claude (MCP) · approved by Tim, 2 days ago". */
export function provenanceLine(
  detail: Pick<AutomationDetail, "extensionId" | "extensionLabel" | "version" | "provenance">,
  relative: (value: string) => string,
): string {
  const parts = [`${detail.extensionLabel ?? detail.extensionId} extension`];
  if (detail.version)
    parts.push(/^v/i.test(detail.version) ? detail.version : `v${detail.version}`);
  const { author, approvedBy, approvedAt, shipped } = detail.provenance;
  if (author) parts.push(`written by ${author}`);
  else if (shipped) parts.push("shipped");
  if (approvedBy) {
    parts.push(`approved by ${approvedBy}${approvedAt ? `, ${relative(approvedAt)}` : ""}`);
  }
  return parts.join(" · ");
}

/** A diagram node's text split into plain and `{code}` parts (code items in order). */
export function diagramParts(
  text: string,
  code: readonly string[],
): { text: string; code: boolean }[] {
  const parts: { text: string; code: boolean }[] = [];
  const pieces = text.split("{code}");
  pieces.forEach((piece, i) => {
    if (piece) parts.push({ text: piece, code: false });
    if (i < pieces.length - 1) {
      const value = code[i];
      if (value !== undefined) parts.push({ text: value, code: true });
    }
  });
  // Code parts without a placeholder are appended, so nothing declared is hidden.
  for (const extra of code.slice(Math.max(0, pieces.length - 1))) {
    parts.push({ text: " ", code: false }, { text: extra, code: true });
  }
  return parts;
}

// --- Test-mode report --------------------------------------------------------------------------

export interface ReportLine {
  kind: "match" | "nomatch" | "write" | "notify" | "wait" | "error" | "approval" | "policy";
  /** Segments; `strong` ones are bold (names, counts). */
  parts: { text: string; strong?: boolean }[];
  muted?: boolean;
}

function noun(object: string, count: number): string {
  const base = (object.split(".").at(-1) ?? object).replace(/([a-z])([A-Z])/g, "$1 $2");
  const lower = base.toLowerCase();
  if (count === 1) return lower;
  if (lower.endsWith("y") && !/[aeiou]y$/.test(lower)) return `${lower.slice(0, -1)}ies`;
  if (/(s|x|ch|sh)$/.test(lower)) return `${lower}es`;
  return `${lower}s`;
}

const VERBS: Record<string, string> = {
  create: "create",
  update: "update",
  delete: "delete",
  restore: "restore",
  complete: "complete",
};

function capitalise(text: string): string {
  return text ? text[0]?.toUpperCase() + text.slice(1) : text;
}

/** Joins names: "Sarah", "Sarah and Tim", "Sarah, Tim and 2 others". */
export function joinNames(names: readonly string[]): string {
  const unique = [...new Set(names.filter(Boolean))];
  if (unique.length <= 1) return unique[0] ?? "";
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`;
  if (unique.length === 3) return `${unique[0]}, ${unique[1]} and ${unique[2]}`;
  return `${unique[0]}, ${unique[1]} and ${unique.length - 2} others`;
}

/** Narrows the `unknown` report of automation.test / lastTest to the documented shape. */
export function asTestReport(value: unknown): AutomationTestReport | null {
  if (!value || typeof value !== "object") return null;
  const report = value as Partial<AutomationTestReport>;
  if (typeof report.matched !== "boolean" || !Array.isArray(report.steps)) return null;
  return {
    automationId: report.automationId ?? "",
    record: report.record ?? null,
    matched: report.matched,
    matchReason: report.matchReason ?? "",
    steps: report.steps,
    writes: Array.isArray(report.writes) ? report.writes : [],
    notifications: Array.isArray(report.notifications) ? report.notifications : [],
    approvals: Array.isArray(report.approvals) ? report.approvals : [],
    policyPreset: report.policyPreset ?? "",
    ok: report.ok ?? true,
    ...(report.error ? { error: report.error } : {}),
    // Reports stored before stage 7b have no `stored`; a stored report was stored.
    stored: report.stored ?? true,
    ...(report.draft ? { draft: report.draft } : {}),
  };
}

/**
 * The test-mode result as lines, in the reference's order: trigger, writes, notifications, waits,
 * an error, then approvals (or "No approvals needed under your Balanced policy").
 * A write may name whom it is for (`for`, e.g. the task assignee), when the host knows.
 */
export function testReportLines(report: AutomationTestReport): ReportLine[] {
  const lines: ReportLine[] = [];
  lines.push(
    report.matched
      ? {
          kind: "match",
          parts: [
            {
              text: `✓ Trigger matched${report.matchReason ? ` (${report.matchReason})` : ""}`,
            },
          ],
        }
      : {
          kind: "nomatch",
          parts: [
            {
              text: `✗ Trigger did not match${report.matchReason ? `: ${report.matchReason}` : ""}`,
            },
          ],
        },
  );

  // Writes, grouped by action, object and whom they are for.
  const groups = new Map<string, { action: string; object: string; who: string; count: number }>();
  for (const write of report.writes) {
    const who = (write as { for?: unknown }).for;
    const whoText = typeof who === "string" ? who : "";
    const key = `${write.action}\u0000${write.object}\u0000${whoText}`;
    const group = groups.get(key) ?? {
      action: write.action,
      object: write.object,
      who: whoText,
      count: 0,
    };
    group.count += 1;
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const verb = VERBS[group.action] ?? group.action;
    const parts: ReportLine["parts"] = [
      { text: `Would ${verb} ${group.count} ${noun(group.object, group.count)}` },
    ];
    if (group.who) parts.push({ text: " for " }, { text: group.who, strong: true });
    parts.push({ text: " (simulated, nothing written)" });
    lines.push({ kind: "write", parts });
  }

  for (const notification of report.notifications) {
    const names = notification.toNames.length ? notification.toNames : notification.to;
    lines.push({
      kind: "notify",
      parts: [{ text: "Would notify " }, { text: joinNames(names) || "nobody", strong: true }],
    });
  }

  report.steps.forEach((step, i) => {
    if (step.kind === "do" || step.skippedMs === undefined) return;
    const next = report.steps[i + 1];
    const what =
      step.kind === "waitForEvent"
        ? `Would wait up to ${formatDuration(step.skippedMs)} for an event`
        : `Would wait ${formatDuration(step.skippedMs)}`;
    lines.push({
      kind: "wait",
      parts: [{ text: next ? `${what}, then ${next.name}` : what }],
    });
  });

  if (report.error) {
    lines.push({ kind: "error", parts: [{ text: `✗ Failed: ${report.error.message}` }] });
  }

  const policy = report.policyPreset ? `${capitalise(report.policyPreset)} ` : "";
  if (!report.approvals.length) {
    lines.push({
      kind: "policy",
      parts: [{ text: `No approvals needed under your ${policy}policy` }],
      muted: true,
    });
  } else {
    for (const approval of report.approvals) {
      lines.push({
        kind: "approval",
        parts: [
          { text: "Would need approval: " },
          { text: approval.operation, strong: true },
          ...(approval.bulkSize > 1 ? [{ text: ` ×${approval.bulkSize}` }] : []),
          ...(approval.reason ? [{ text: ` (${approval.reason})` }] : []),
        ],
      });
    }
    lines.push({
      kind: "policy",
      parts: [{ text: `Under your ${policy}policy` }],
      muted: true,
    });
  }
  return lines;
}

// --- Notifications -----------------------------------------------------------------------------

/** The app path of a notification link. */
export function linkHref(link: NotificationLink): string {
  switch (link.kind) {
    case "record":
      switch (link.object) {
        case "person":
          return `/people/${link.id}`;
        case "organisation":
          return `/organisations/${link.id}`;
        case "task":
          return "/tasks";
        case "activity":
          return "/activity";
        default:
          return `/x/${link.object}/${link.id}`;
      }
    case "approval":
      return `/approvals?set=${encodeURIComponent(link.changeSetId)}`;
    case "automationRun":
      return `/automations/${link.automationId}?tab=runs&run=${encodeURIComponent(link.runId)}`;
    case "automation":
      return `/automations/${link.automationId}`;
  }
}

/**
 * Where clicking a notification goes: its `href` (an app path; `/approvals/chs_…` is the inbox
 * with that set outlined), else its link, else nowhere. External URLs are never followed.
 */
export function notificationHref(item: Pick<NotificationItem, "href" | "link">): string | null {
  const href = item.href;
  if (href?.startsWith("/") && !href.startsWith("//")) {
    const approval = /^\/approvals\/(chs_[\w-]+)\/?$/.exec(href);
    if (approval?.[1]) return `/approvals?set=${approval[1]}`;
    return href;
  }
  return item.link ? linkHref(item.link) : null;
}

/**
 * What a run is about, for run lists: its record's title, else what fired it ("Webhook ·
 * invoice.paid", "Email received", "Scheduled run", "Approval decided").
 */
export function runLabel(run: Pick<RunItem, "record" | "trigger">): string {
  if (run.record) return run.record.title ?? run.record.id;
  const trigger = (run.trigger && typeof run.trigger === "object" ? run.trigger : {}) as {
    type?: unknown;
    integration?: { type?: unknown } | null;
  };
  const eventType = typeof trigger.integration?.type === "string" ? trigger.integration.type : null;
  switch (trigger.type) {
    case "webhook":
      return eventType ? `Webhook · ${eventType}` : "Webhook event";
    case "syncEvent":
      return eventType ? `Sync · ${eventType}` : "Sync event";
    case "approvalDecided":
      return "Approval decided";
    case "manual":
      return "Manual run";
    default:
      return "Scheduled run";
  }
}
