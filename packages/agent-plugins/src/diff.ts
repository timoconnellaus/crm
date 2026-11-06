// Diffs and the three-way merge (ADR 0347), for any JSON item body. Text is merged by line (diff3),
// objects by key, and anything else as one value. What cannot be merged by rule comes back as a
// conflict; only a conflict is ever put to a model (merge.ts).
import { canonicalJson } from "./fingerprint.ts";

export type DiffLineKind = "same" | "add" | "remove";
export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/** The longest common subsequence as index pairs, in order. */
function commonLines(a: readonly string[], b: readonly string[]): [number, number][] {
  const cols = b.length + 1;
  const table = new Uint32Array((a.length + 1) * cols);
  const at = (i: number, j: number) => table[i * cols + j] as number;
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push([i, j]);
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return out;
}

const lines = (text: string) => (text === "" ? [] : text.split("\n"));

export function diffLines(before: string, after: string): DiffLine[] {
  const a = lines(before);
  const b = lines(after);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  for (const [x, y] of [...commonLines(a, b), [a.length, b.length] as [number, number]]) {
    while (i < x) out.push({ kind: "remove", text: a[i++] as string });
    while (j < y) out.push({ kind: "add", text: b[j++] as string });
    if (x < a.length) out.push({ kind: "same", text: a[x] as string });
    i = x + 1;
    j = y + 1;
  }
  return out;
}

export interface TextConflict {
  /** The lines each side had where they disagree. */
  base: string;
  mine: string;
  theirs: string;
}

interface Chunk {
  stable: boolean;
  base: string[];
  mine: string[];
  theirs: string[];
}

/** diff3: splits the three texts at the lines all of them keep. */
function chunks(base: string[], mine: string[], theirs: string[]): Chunk[] {
  const toMine = new Map(commonLines(base, mine));
  const toTheirs = new Map(commonLines(base, theirs));
  const out: Chunk[] = [];
  let b = 0;
  let m = 0;
  let t = 0;
  const unstable = (bEnd: number, mEnd: number, tEnd: number) => {
    if (bEnd > b || mEnd > m || tEnd > t) {
      out.push({
        stable: false,
        base: base.slice(b, bEnd),
        mine: mine.slice(m, mEnd),
        theirs: theirs.slice(t, tEnd),
      });
    }
  };
  for (let i = 0; i < base.length; i += 1) {
    const inMine = toMine.get(i);
    const inTheirs = toTheirs.get(i);
    if (inMine === undefined || inTheirs === undefined) continue;
    // A line both sides moved past each other is not a stable point.
    if (inMine < m || inTheirs < t) continue;
    unstable(i, inMine, inTheirs);
    out.push({
      stable: true,
      base: [base[i] as string],
      mine: [mine[inMine] as string],
      theirs: [theirs[inTheirs] as string],
    });
    b = i + 1;
    m = inMine + 1;
    t = inTheirs + 1;
  }
  unstable(base.length, mine.length, theirs.length);
  return out;
}

const equal = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((line, i) => line === b[i]);

/** One piece of a text merge: lines that merged, or a conflict left to resolve. */
export type TextPiece = { lines: string[] } | { conflict: TextConflict };

export function mergeTextPieces(base: string, mine: string, theirs: string): TextPiece[] {
  const pieces: TextPiece[] = [];
  const push = (text: string[]) => {
    if (!text.length) return;
    const last = pieces.at(-1);
    if (last && "lines" in last) last.lines.push(...text);
    else pieces.push({ lines: [...text] });
  };
  for (const chunk of chunks(lines(base), lines(mine), lines(theirs))) {
    if (chunk.stable || equal(chunk.mine, chunk.theirs)) push(chunk.mine);
    else if (equal(chunk.mine, chunk.base)) push(chunk.theirs);
    else if (equal(chunk.theirs, chunk.base)) push(chunk.mine);
    else {
      pieces.push({
        conflict: {
          base: chunk.base.join("\n"),
          mine: chunk.mine.join("\n"),
          theirs: chunk.theirs.join("\n"),
        },
      });
    }
  }
  return pieces;
}

export interface ThreeWayConflict {
  /** Where: a dotted path into the body, with `#n` for the nth conflict within a text. */
  path: string;
  base: unknown;
  mine: unknown;
  theirs: unknown;
}

export interface ThreeWayChange {
  path: string;
  side: "theirs" | "mine" | "both";
}

export interface ThreeWayResult {
  /** The body with every clean change in. A conflict holds its resolution, or your side. */
  merged: unknown;
  changes: ThreeWayChange[];
  conflicts: ThreeWayConflict[];
}

/** A conflict's answer, or undefined to keep your side. */
export type ConflictResolver = (conflict: ThreeWayConflict) => unknown;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const join = (path: string, key: string) => (path ? `${path}.${key}` : key);

interface Walk extends Pick<ThreeWayResult, "changes" | "conflicts"> {
  resolve: ConflictResolver;
}

function mergeText(path: string, base: unknown, mine: string, theirs: string, out: Walk) {
  const pieces = mergeTextPieces(typeof base === "string" ? base : "", mine, theirs);
  const text: string[] = [];
  let index = 0;
  for (const piece of pieces) {
    if ("lines" in piece) {
      text.push(...piece.lines);
      continue;
    }
    const conflict = { path: `${path}#${index}`, ...piece.conflict };
    out.conflicts.push(conflict);
    const answer = out.resolve(conflict);
    const chosen = typeof answer === "string" ? answer : piece.conflict.mine;
    if (chosen) text.push(chosen);
    index += 1;
  }
  out.changes.push({ path, side: "both" });
  return text.join("\n");
}

function walk(base: unknown, mine: unknown, theirs: unknown, path: string, out: Walk): unknown {
  if (same(mine, theirs)) {
    if (!same(base, mine)) out.changes.push({ path, side: "both" });
    return mine;
  }
  if (same(base, theirs)) {
    out.changes.push({ path, side: "mine" });
    return mine;
  }
  if (same(base, mine)) {
    out.changes.push({ path, side: "theirs" });
    return theirs;
  }
  if (isObject(mine) && isObject(theirs)) {
    const from = isObject(base) ? base : {};
    const merged: Record<string, unknown> = {};
    const keys = new Set([...Object.keys(mine), ...Object.keys(theirs), ...Object.keys(from)]);
    for (const key of [...keys].sort()) {
      const value = walk(from[key], mine[key], theirs[key], join(path, key), out);
      if (value !== undefined) merged[key] = value;
    }
    return merged;
  }
  if (typeof mine === "string" && typeof theirs === "string") {
    return mergeText(path, base, mine, theirs, out);
  }
  const conflict = { path, base, mine, theirs };
  out.conflicts.push(conflict);
  const answer = out.resolve(conflict);
  return answer === undefined ? mine : answer;
}

export function threeWay(
  base: unknown,
  mine: unknown,
  theirs: unknown,
  resolve: ConflictResolver = () => undefined,
): ThreeWayResult {
  const out: Walk = { changes: [], conflicts: [], resolve };
  const merged = walk(base, mine, theirs, "", out);
  return { merged, changes: out.changes, conflicts: out.conflicts };
}

/** A body as lines a person can read and diff: text as it is, anything else one field a line. */
export function bodyLines(value: unknown, prefix = ""): string[] {
  if (typeof value === "string") {
    const text = value.split("\n");
    return prefix ? [`${prefix}:`, ...text.map((t) => `  ${t}`)] : text;
  }
  if (isObject(value)) {
    return Object.keys(value)
      .sort()
      .flatMap((key) => bodyLines(value[key], prefix ? `${prefix}.${key}` : key));
  }
  return [`${prefix}: ${JSON.stringify(value)}`];
}

/** A one-item diff, as the merge card shows it. */
export function bodyDiff(before: unknown, after: unknown): DiffLine[] {
  return diffLines(bodyLines(before).join("\n"), bodyLines(after).join("\n"));
}
