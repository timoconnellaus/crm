// The reference answers in reference/<idBase>.ts, as the source smoke.ts writes to a deployment.
// Each file uses its prompt's idBase as the extension id ("tickets", and "tickets.ticket" for its
// object); that is rewritten to the run's id.
import { readFileSync } from "node:fs";
import type { AuthoringPrompt } from "../prompts.ts";

export const referencePath = (prompt: AuthoringPrompt) =>
  new URL(`../reference/${prompt.idBase}.ts`, import.meta.url);

export function rewriteId(source: string, from: string, to: string): string {
  return source.replaceAll(`"${from}"`, `"${to}"`).replaceAll(`"${from}.`, `"${to}.`);
}

/** The reference extension's index.ts for `prompt`, with `extensionId` as its id. */
export function referenceSource(prompt: AuthoringPrompt, extensionId: string): string {
  return rewriteId(readFileSync(referencePath(prompt), "utf8"), prompt.idBase, extensionId);
}
