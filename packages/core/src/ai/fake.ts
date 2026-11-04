// Deterministic stand-ins for the model roles (ADR 0150): local development and e2e without an
// `AI` binding (AI_FAKE_MODEL=true), and tests. Never used when a binding exists.
import { fakeBuildModel } from "../dashboards/describe.ts";
import type { FakeModels, ModelMessage } from "./client.ts";
import type { ModelRole } from "./roles.ts";

export const FAKE_EMBEDDING_DIMENSIONS = 384;

const WORD_RE = /[\p{L}\p{N}]+/gu;

/** A crude stemmer: enough that "renewals" and "renewal", "hiring" and "hire" meet. */
export function stem(word: string): string {
  let w = word.toLowerCase();
  for (const suffix of ["ing", "ies", "es", "ed", "ly", "s"]) {
    if (w.length > suffix.length + 3 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      if (suffix === "ies") w += "y";
      break;
    }
  }
  return w;
}

/** FNV-1a, 32-bit. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const STOP = new Set(
  "the a an and or of to in on for with at by is are was be it this that from as who what about we our their".split(
    " ",
  ),
);

/**
 * A deterministic text embedding: feature-hashed word stems (weight 1) and character trigrams
 * (weight 0.35), L2-normalised. Similar wording gives similar vectors; meaning beyond wording is
 * not modelled. Tests and local development only.
 */
export function fakeEmbed(text: string, dimensions = FAKE_EMBEDDING_DIMENSIONS): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const add = (feature: string, weight: number) => {
    const h = hash(feature);
    vector[h % dimensions] = (vector[h % dimensions] ?? 0) + ((h >>> 16) & 1 ? weight : -weight);
  };
  for (const raw of text.normalize("NFD").replace(/\p{M}/gu, "").match(WORD_RE) ?? []) {
    const word = raw.toLowerCase();
    if (STOP.has(word)) continue;
    const s = stem(word);
    add(`w:${s}`, 1);
    const padded = `^${s}$`;
    for (let i = 0; i + 3 <= padded.length; i++) add(`t:${padded.slice(i, i + 3)}`, 0.35);
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((v) => v / norm);
}

function lastUser(messages: readonly ModelMessage[]): string {
  return [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
}

/** Bullet lines ("- …") of a prompt, the facts a summary prompt lists. */
function facts(prompt: string): string[] {
  return prompt
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2));
}

/** A one-sentence, deterministic "summary" built from the prompt's facts. */
function fakeSummary(prompt: string, sentences: number): string {
  const lines = facts(prompt);
  if (!lines.length) {
    const words = prompt.replace(/\s+/g, " ").trim().split(" ").slice(-25).join(" ");
    return `Summary: ${words}`;
  }
  return lines
    .slice(0, sentences)
    .map((l) => (l.endsWith(".") ? l : `${l}.`))
    .join(" ");
}

export function fakeModels(): FakeModels {
  const build = fakeBuildModel();
  return {
    async run(role: ModelRole, messages) {
      const prompt = lastUser(messages);
      switch (role) {
        case "build":
          return (await build.run(role, messages)).text;
        case "summarise": {
          const oneLine = /one line|one sentence/i.test(messages[0]?.content ?? "");
          return fakeSummary(prompt, oneLine ? 1 : 3);
        }
        case "classify": {
          const labels = /exactly one of: (\[.*?\])/.exec(prompt)?.[1];
          try {
            return (JSON.parse(labels ?? "[]") as string[])[0] ?? "";
          } catch {
            return "";
          }
        }
        case "extract":
          return "{}";
        default:
          return "OK";
      }
    },
    embed(texts) {
      return texts.map((t) => fakeEmbed(t));
    },
  };
}
