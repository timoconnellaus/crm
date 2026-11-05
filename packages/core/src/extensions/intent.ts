// The authoring.intent placement in extension.check and extension.propose (ADR 0230, docs/jev.md
// placement 1): asks the judge whether each automation a version adds or changes does exactly
// what the person asked, and turns faults into warnings. Advice only: it never fails a check,
// fails open when the judge cannot answer, and does nothing when the judge is off.
//
// The request: in the assistant, the person's own words, passed by its Durable Object's code
// (`ctx.personsWords`), which win over anything the model passes. Over MCP, the client may pass
// `request` itself; it is labelled "as the client reported it" wherever it is shown.
import type { ExtensionManifest } from "@relationship-os/sdk";
import { z } from "zod";
import {
  checkIntent,
  type IntentCheck,
  type IntentIssue,
  intentIssues,
  REQUEST_MAX_CHARS,
} from "../judge/questions/authoring-intent.ts";
import type { HandlerContext } from "../operation.ts";

export const intentRequestInput = z
  .string()
  .trim()
  .min(1)
  .max(REQUEST_MAX_CHARS)
  .optional()
  .describe(
    "What the user asked for, in their own words (quote them; do not summarise). When given, " +
      "each automation is checked against it, and anything it adds, leaves out or sends to " +
      "someone else comes back as a warning issue (code intent/…). Warnings never fail the check.",
  );

/** Stored and shown checks parse back through this (a bad row reads as no check). */
export function parseIntentCheck(text: string | null | undefined): IntentCheck | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as IntentCheck;
    return value && (value.status === "checked" || value.status === "unchecked") ? value : null;
  } catch {
    return null;
  }
}

/** The installed manifest of an extension, the baseline "changed" is measured against. */
async function installedManifest(
  ctx: HandlerContext,
  id: string,
): Promise<ExtensionManifest | null> {
  const row = await ctx.db
    .selectFrom("core_extensions")
    .select("manifest")
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) return null;
  try {
    return JSON.parse(row.manifest) as ExtensionManifest;
  } catch {
    return null;
  }
}

/**
 * The intent check of a checked manifest, and the issues it adds. Null (and no issues) when there
 * is no request, no automation changed, or the judge is off.
 */
export async function authoringIntent(
  ctx: HandlerContext,
  input: {
    manifest: ExtensionManifest;
    request?: string | undefined;
    previous?: ExtensionManifest | null;
  },
): Promise<{ check: IntentCheck | null; issues: IntentIssue[] }> {
  const fromPerson = ctx.personsWords?.trim();
  const request = fromPerson || input.request?.trim();
  if (!ctx.judge || !request || !Object.keys(input.manifest.automations ?? {}).length) {
    return { check: null, issues: [] };
  }
  const previous =
    input.previous !== undefined ? input.previous : await installedManifest(ctx, input.manifest.id);
  const check = await checkIntent({
    judge: ctx.judge,
    request,
    requestSource: fromPerson ? "person" : "client",
    manifest: input.manifest,
    previous,
    now: ctx.now,
  });
  return { check, issues: intentIssues(check) };
}
