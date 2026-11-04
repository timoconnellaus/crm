// Turns a pending action (operation + diff preview) into words a reviewer reads in the Approvals
// inbox: a title ("Update 38 people"), and per group of records the field changes as added,
// removed and changed lines, with labels from the field registry. Pure, so it is unit tested.
import { getObject } from "@crm/core/client";
import { diffValue } from "#/lib/format";

export interface PreviewEntry {
  object: string;
  id: string;
  action: string;
  diff: Record<string, { before: unknown; after: unknown }>;
}

const NOUNS: Record<string, [string, string]> = {
  person: ["person", "people"],
  organisation: ["organisation", "organisations"],
  activity: ["activity", "activities"],
  task: ["task", "tasks"],
  affiliation: ["affiliation", "affiliations"],
  connected_app: ["connected app", "connected apps"],
  view: ["saved view", "saved views"],
};

export function noun(object: string, count = 1): string {
  const [one, many] = NOUNS[object] ?? [object.replace(/_/g, " "), `${object.replace(/_/g, " ")}s`];
  return count === 1 ? one : many;
}

const VERBS: Record<string, string> = {
  create: "Create",
  update: "Update",
  updateMany: "Update",
  delete: "Delete",
  deleteMany: "Delete",
  restore: "Restore",
  merge: "Merge",
  erase: "Erase",
  log: "Log",
  complete: "Complete",
  reopen: "Reopen",
  changeJob: "Change job of",
  end: "End",
};

/** "updateMany" → "Update"; unknown camelCase verbs are spelled out ("sendEmail" → "Send email"). */
export function verbOf(operation: string): string {
  const verb = operation.split(".").at(-1) ?? operation;
  if (VERBS[verb]) return VERBS[verb];
  const words = verb.replace(/([A-Z])/g, " $1").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Records of the operation's own object the preview touches, falling back to any record. */
function mainRecords(operation: string, preview: readonly PreviewEntry[]): PreviewEntry[] {
  const object = operation.split(".")[0] ?? "";
  const own = preview.filter((p) => p.object === object);
  return own.length ? own : [...preview];
}

/** A reviewer's title: "Update 38 people", "Create person", "Log activity". */
export function actionTitle(
  operation: string,
  preview: readonly PreviewEntry[],
  input?: unknown,
): string {
  const args = (input ?? {}) as { id?: unknown; version?: unknown; eject?: unknown };
  if (operation === "extension.apply") {
    const what = `extension ${String(args.id ?? "")} ${String(args.version ?? "")}`.trim();
    return args.eject ? `Eject and install ${what}` : `Install ${what}`;
  }
  if (operation === "extension.dropHidden") {
    return `Drop hidden data of extension ${String(args.id ?? "")}`;
  }
  const object = operation.split(".")[0] ?? operation;
  const count = new Set(mainRecords(operation, preview).map((p) => p.id)).size;
  const verb = verbOf(operation);
  return count > 1 ? `${verb} ${count} ${noun(object, count)}` : `${verb} ${noun(object)}`;
}

export type LineKind = "add" | "remove" | "change" | "note";

export interface DiffLine {
  kind: LineKind;
  label: string;
  /** add/remove: the value(s); change: the new value; note: the text. */
  text: string;
  /** change only: the old value (omitted for bulk groups whose old values differ). */
  before?: string;
}

const isEmpty = (value: unknown) =>
  value === null ||
  value === undefined ||
  value === "" ||
  (Array.isArray(value) && value.length === 0);

function asList(value: unknown): string[] {
  if (!Array.isArray(value)) return isEmpty(value) ? [] : [diffValue(value)];
  return value.map((item) => diffValue([item]));
}

const ACTION_NOTES: Record<string, string> = {
  delete: "Moved to Trash",
  erase: "Erased permanently",
  restore: "Restored from Trash",
  reference: "Linked",
};

/** The field changes of one record as lines. */
export function diffLines(entry: PreviewEntry): DiffLine[] {
  const definition = getObject(entry.object);
  const label = (field: string) =>
    definition?.fields.find((f) => f.name === field)?.label ?? humanize(field);
  const lines: DiffLine[] = [];
  const note = ACTION_NOTES[entry.action];
  if (note)
    lines.push({ kind: entry.action === "restore" ? "add" : "remove", label: "", text: note });
  for (const [field, { before, after }] of Object.entries(entry.diff)) {
    if (field === "id" || field === "updatedAt" || field === "createdAt") continue;
    if (Array.isArray(before) || Array.isArray(after)) {
      const was = asList(before);
      const now = asList(after);
      const added = now.filter((v) => !was.includes(v));
      const removed = was.filter((v) => !now.includes(v));
      if (added.length) lines.push({ kind: "add", label: label(field), text: added.join(", ") });
      if (removed.length) {
        lines.push({ kind: "remove", label: label(field), text: removed.join(", ") });
      }
      continue;
    }
    if (isEmpty(before) && isEmpty(after)) continue;
    if (isEmpty(before)) lines.push({ kind: "add", label: label(field), text: diffValue(after) });
    else if (isEmpty(after)) {
      lines.push({ kind: "remove", label: label(field), text: diffValue(before) });
    } else {
      lines.push({
        kind: "change",
        label: label(field),
        text: diffValue(after),
        before: diffValue(before),
      });
    }
  }
  if (!lines.length && entry.action === "update") {
    lines.push({ kind: "note", label: "", text: "No field changes" });
  }
  return lines;
}

function humanize(field: string): string {
  const words = field.replace(/([A-Z])/g, " $1").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface PreviewGroup {
  object: string;
  action: string;
  ids: string[];
  lines: DiffLine[];
}

/**
 * Groups records that change the same way (same object, action and resulting lines), so a bulk
 * update of 38 people reads as one change "on 38 records". Old values are dropped from a group's
 * change lines when its records had different ones.
 */
export function groupPreview(preview: readonly PreviewEntry[]): PreviewGroup[] {
  const groups = new Map<string, PreviewGroup & { befores: Set<string> }>();
  for (const entry of preview) {
    const lines = diffLines(entry);
    const key = JSON.stringify([
      entry.object,
      entry.action,
      lines.map((l) => [l.kind, l.label, l.text]),
    ]);
    const group = groups.get(key);
    const befores = JSON.stringify(lines.map((l) => l.before ?? null));
    if (group) {
      if (!group.ids.includes(entry.id)) group.ids.push(entry.id);
      group.befores.add(befores);
    } else {
      groups.set(key, {
        object: entry.object,
        action: entry.action,
        ids: [entry.id],
        lines,
        befores: new Set([befores]),
      });
    }
  }
  return [...groups.values()].map(({ befores, ...group }) => ({
    ...group,
    lines: befores.size > 1 ? group.lines.map(({ before: _before, ...line }) => line) : group.lines,
  }));
}

/** Provisional ids (`per_pending_…`) belong to records that do not exist yet. */
export function isProvisional(id: string): boolean {
  return id.includes("_pending_");
}

/** A short form of an id for display: `per_01JB…`. */
export function shortId(id: string): string {
  const [prefix, rest = ""] = id.split(/_(.*)/s);
  if (isProvisional(id)) return `new ${noun(objectOfPrefix(prefix ?? ""))}`;
  return `${prefix}_${rest.slice(0, 4)}…`;
}

const PREFIXES: Record<string, string> = {
  per: "person",
  org: "organisation",
  act: "activity",
  tsk: "task",
  aff: "affiliation",
};

export function objectOfPrefix(prefix: string): string {
  return PREFIXES[prefix] ?? prefix;
}

/** A name for a record from its own diff (creates and renames carry one). */
export function nameFromDiff(entry: PreviewEntry): string | null {
  for (const field of ["displayName", "name", "title", "subject"]) {
    const value = entry.diff[field];
    const name = value?.after ?? value?.before;
    if (typeof name === "string" && name.trim()) return name;
  }
  return null;
}

export interface DecisionResultItem {
  actionId: string;
  status: string;
  statusReason: string | null;
}

/** What a reviewer needs to hear after approving or rejecting. */
export function summariseDecision(
  decision: "approve" | "reject",
  results: readonly DecisionResultItem[],
  requested: readonly string[] | null,
): { headline: string; cascaded: number; problems: DecisionResultItem[] } {
  const count = (status: string) => results.filter((r) => r.status === status).length;
  const cascaded = results.filter(
    (r) =>
      r.status === "rejected" &&
      (r.statusReason?.startsWith("Rejected because an action it depends on") ||
        (requested !== null && !requested.includes(r.actionId))),
  ).length;
  const problems = results.filter((r) => r.status === "failed" || r.status === "skipped");
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (decision === "reject") {
    const direct = count("rejected") - cascaded;
    const headline =
      `Rejected ${plural(direct, "change")}.` +
      (cascaded
        ? ` Rejecting ${direct === 1 ? "this" : "these"} also rejected ${plural(cascaded, "dependent action")}.`
        : "");
    return { headline, cascaded, problems };
  }
  const parts = [`Applied ${plural(count("applied"), "change")}`];
  if (count("failed")) parts.push(`${count("failed")} failed`);
  if (count("skipped")) parts.push(`${count("skipped")} skipped`);
  return { headline: `${parts.join(", ")}.`, cascaded: 0, problems };
}
