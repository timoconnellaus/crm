// The host-generated plain-English summary and step diagram (ADR 0131): deterministic, no AI,
// rendered from an automation's declared trigger, conditions and steps. Used on the automation
// page, in automation.get, and on the approval screen for an extension change.
//
// STUB (interfaces commit): the SDK/summary workstream replaces the bodies.
import type { AutomationManifest } from "@crm/sdk";
import type { AutomationSummary, DiagramNode } from "./schemas.ts";

/** Labels the summary needs, resolved by the caller from the field registry. */
export interface SummaryContext {
  /** `deals.deal` → { label: "Deal", plural: "Deals" }; null when unknown. */
  objectLabel(object: string): { label: string; plural: string } | null;
  /** A field's label, e.g. `expectedClose` → "expected close"; null when unknown. */
  fieldLabel(object: string, field: string): string | null;
  /** Labels of a select field's options (value → label), for from/to values. */
  optionLabel?(object: string, field: string, value: string): string | null;
  /** The automation timezone, e.g. "Australia/Sydney". */
  timezone: string;
}

export function triggerText(spec: AutomationManifest, _ctx: SummaryContext): string {
  return spec.trigger.type;
}

export function automationSummary(
  spec: AutomationManifest,
  _ctx: SummaryContext,
): AutomationSummary {
  return { segments: [{ text: spec.description, strong: false }], text: spec.description };
}

export function automationDiagram(spec: AutomationManifest, ctx: SummaryContext): DiagramNode[] {
  return [
    {
      kind: "trigger",
      heading: "Trigger",
      text: triggerText(spec, ctx),
      code: [],
      detail: null,
      risk: null,
      stepName: null,
    },
  ];
}
