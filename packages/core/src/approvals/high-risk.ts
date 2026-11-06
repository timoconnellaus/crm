// Which approvals need a deliberate second step (ADR 0345): destructive changes, and sends above a
// threshold. Browser-safe, so the approval card can show the two-step button, and W5 uses the same
// rule for the exact spoken or typed phrase.
//
// ADR 0345's "external" risk is this repository's `outbound` risk class.

/** Email sends above this many recipients are high risk (`approvals.phraseThreshold.email`). */
export const EMAIL_RECIPIENT_THRESHOLD = 25;

/** What this needs to know about a pending action. */
export interface HighRiskInput {
  risk: string;
  /** The action's title: "Delete Kestrel Energy". */
  title: string;
  outbound?: { fields: readonly { label: string; value: string }[] } | null;
}

export interface SecondStep {
  /** The first button: "Send 240 emails". */
  label: string;
  /** The second button: "Confirm: send 240 emails". */
  confirmLabel: string;
}

const RECIPIENT_FIELD = /^(to|cc|bcc|recipients?)$/i;

/** How many people an outbound action reaches: a count, or a list in its To, Cc and Bcc fields. */
export function recipientCount(input: HighRiskInput["outbound"]): number {
  let total = 0;
  for (const field of input?.fields ?? []) {
    if (!RECIPIENT_FIELD.test(field.label.trim())) continue;
    const value = field.value.trim();
    if (/^\d[\d,]*$/.test(value)) total += Number(value.replace(/,/g, ""));
    else total += value.split(/[,;\n]/).filter((v) => v.trim()).length;
  }
  return total;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function step(label: string): SecondStep {
  return { label, confirmLabel: `Confirm: ${lowerFirst(label)}` };
}

/** The second step one action needs, or null when one tap is enough. */
export function secondStep(
  action: HighRiskInput,
  threshold: number = EMAIL_RECIPIENT_THRESHOLD,
): SecondStep | null {
  if (action.risk === "destructive") return step(action.title);
  if (action.risk === "outbound") {
    const recipients = recipientCount(action.outbound);
    if (recipients > threshold) return step(`Send ${recipients} emails`);
  }
  return null;
}

/** The second step for approving some actions at once: one high-risk action names itself. */
export function secondStepFor(
  actions: readonly HighRiskInput[],
  threshold: number = EMAIL_RECIPIENT_THRESHOLD,
): SecondStep | null {
  const steps = actions.flatMap((a) => secondStep(a, threshold) ?? []);
  const [first] = steps;
  if (!first) return null;
  return actions.length === 1 ? first : step(`Approve ${actions.length} changes`);
}
