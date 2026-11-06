// An A2UI document and its validation (ADR 0346). A document names the catalogue version it was
// written for and a root component; containers (card, stack) hold children. Validation is by the
// catalogue: an unknown or reserved type, a component newer than the declared version, a
// host-only component from anyone but the host, bad props, or a tree too deep or too big makes
// the whole card invalid, and the host shows its text fallback instead of rendering it blindly.
import { z } from "zod";
import {
  A2UI_CATALOGUE_VERSION,
  type ComponentType,
  componentDefinition,
  RESERVED_COMPONENTS,
} from "./catalogue.ts";

/** Who wrote a card: the model, a saved producer, or the host itself. */
export const A2UI_SOURCES = ["model", "producer", "host"] as const;
export type A2uiSource = (typeof A2UI_SOURCES)[number];

/** One component of a card: `type` plus that component's props. */
export interface A2uiNode {
  type: string;
  [prop: string]: unknown;
}

export interface A2uiDocument {
  /** The catalogue version the card was written for. */
  a2ui: number;
  root: A2uiNode;
}

/** Limits that keep a card small enough for the thread and the model's context. */
export const A2UI_LIMITS = { maxDepth: 4, maxNodes: 60, maxBytes: 64_000 } as const;

export interface ValidateOptions {
  source: A2uiSource;
  /** The newest catalogue version the host renders (default: this package's). */
  supportedVersion?: number;
}

export type Validation =
  | { ok: true; document: A2uiDocument; fallback: string }
  | { ok: false; problems: string[] };

const envelope = z.object({
  a2ui: z.number().int().min(1),
  root: z.looseObject({ type: z.string().min(1).max(80) }),
});

function issues(error: z.ZodError, at: string): string[] {
  return error.issues.slice(0, 5).map((i) => {
    const path = i.path.length ? `.${i.path.join(".")}` : "";
    return `${at}${path}: ${i.message}`;
  });
}

/**
 * Validates a card against the catalogue. On success the document comes back normalised (zod
 * defaults applied, unknown props dropped) with its text fallback.
 */
export function validateDocument(input: unknown, options: ValidateOptions): Validation {
  const supported = options.supportedVersion ?? A2UI_CATALOGUE_VERSION;
  let size = 0;
  try {
    size = JSON.stringify(input ?? null).length;
  } catch {
    return { ok: false, problems: ["the card is not JSON"] };
  }
  if (size > A2UI_LIMITS.maxBytes) {
    return { ok: false, problems: [`the card is ${size} bytes; at most ${A2UI_LIMITS.maxBytes}`] };
  }
  const parsed = envelope.safeParse(input);
  if (!parsed.success) return { ok: false, problems: issues(parsed.error, "card") };
  const version = parsed.data.a2ui;
  if (version > supported) {
    return {
      ok: false,
      problems: [`the card targets catalogue version ${version}; this app renders up to ${supported}`],
    };
  }
  const problems: string[] = [];
  let nodes = 0;

  function visit(raw: unknown, at: string, depth: number): A2uiNode | null {
    nodes += 1;
    if (nodes > A2UI_LIMITS.maxNodes) {
      if (nodes === A2UI_LIMITS.maxNodes + 1) {
        problems.push(`the card has more than ${A2UI_LIMITS.maxNodes} components`);
      }
      return null;
    }
    if (depth > A2UI_LIMITS.maxDepth) {
      problems.push(`${at}: nested more than ${A2UI_LIMITS.maxDepth} deep`);
      return null;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      problems.push(`${at}: a component is an object with a type`);
      return null;
    }
    const { type, ...props } = raw as { type?: unknown } & Record<string, unknown>;
    if (typeof type !== "string") {
      problems.push(`${at}: a component needs a type`);
      return null;
    }
    const definition = componentDefinition(type);
    if (!definition) {
      problems.push(
        (RESERVED_COMPONENTS as readonly string[]).includes(type)
          ? `${at}: ${type} is not in this catalogue yet`
          : `${at}: unknown component ${type}`,
      );
      return null;
    }
    if (definition.since > version) {
      problems.push(`${at}: ${type} needs catalogue version ${definition.since}`);
      return null;
    }
    if (definition.hostOnly && options.source !== "host") {
      problems.push(`${at}: only the app itself sends ${type} cards`);
      return null;
    }
    const result = definition.props.safeParse(props);
    if (!result.success) {
      problems.push(...issues(result.error, `${at} (${type})`));
      return null;
    }
    const node = { type, ...(result.data as Record<string, unknown>) } as A2uiNode;
    if (definition.container) {
      const kids = (node.children as unknown[] | undefined) ?? [];
      node.children = kids
        .map((child, i) => visit(child, `${at}.children.${i}`, depth + 1))
        .filter((c): c is A2uiNode => c !== null);
    }
    return node;
  }

  const root = visit(parsed.data.root, "root", 1);
  if (!root || problems.length) {
    return { ok: false, problems: problems.length ? problems : ["the card is empty"] };
  }
  const document: A2uiDocument = { a2ui: version, root };
  return { ok: true, document, fallback: textFallback(document) };
}

/** The plain-text version of a (valid) node and everything in it. */
export function nodeFallback(node: A2uiNode): string {
  const definition = componentDefinition(node.type);
  if (!definition) return "";
  const kids = definition.container ? ((node.children as A2uiNode[] | undefined) ?? []) : [];
  const { type: _type, ...props } = node;
  const children = kids.map(nodeFallback).filter((t) => t.trim().length > 0);
  return definition.fallback(props as never, { children }).trim();
}

/** The plain-text version of a whole (valid) card: what is stored with the message. */
export function textFallback(document: A2uiDocument): string {
  return nodeFallback(document.root);
}

/**
 * What the thread stores for a card (ADR 0346): who sent it, the validated document (null when
 * it was invalid), and its text fallback, which the model reads and plain clients show.
 */
export const a2uiPartSchema = z.object({
  type: z.literal("a2ui"),
  source: z.enum(A2UI_SOURCES),
  /** The saved producer that made it (`tasks.overdueCard@1`). */
  producer: z.string().max(200).optional(),
  document: z.custom<A2uiDocument>((v) => typeof v === "object" && v !== null).nullable(),
  fallback: z.string(),
  /** Why the card was not shown (invalid A2UI). */
  problems: z.array(z.string()).optional(),
});
export type A2uiPart = z.infer<typeof a2uiPartSchema>;

export const NO_CARD_TEXT = "(A card could not be shown.)";

/**
 * A card ready to store: validated, with its fallback. An invalid card keeps no document and
 * falls back to `text` (what its author wrote in words), or a plain note.
 */
export function prepareCard(
  input: unknown,
  options: ValidateOptions & { text?: string | undefined; producer?: string | undefined },
): A2uiPart {
  const result = validateDocument(input, options);
  const base = {
    type: "a2ui" as const,
    source: options.source,
    ...(options.producer ? { producer: options.producer } : {}),
  };
  if (result.ok) return { ...base, document: result.document, fallback: result.fallback };
  return {
    ...base,
    document: null,
    fallback: options.text?.trim() || NO_CARD_TEXT,
    problems: result.problems,
  };
}

/** Is this one of the component types the catalogue lists? */
export function isComponentType(type: string): type is ComponentType {
  return componentDefinition(type) !== undefined;
}
