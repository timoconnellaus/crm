// Which approvals need a deliberate second step (ADR 0345): destructive changes, and sends above a
// threshold. Browser-safe. The server works out the step (approvals/steps.ts) and hands it to every
// card and the Approvals inbox on the action, and refuses an approval that skipped it.
//
// ADR 0345's "external" risk is this repository's `outbound` risk class.

/** Email sends above this many recipients are high risk unless the setting says otherwise. */
export const DEFAULT_PHRASE_THRESHOLD = 25;

/** What this needs to know about a pending action. */
export interface HighRiskInput {
  risk: string;
  /** The action's title: "Delete Kestrel Energy". */
  title: string;
  outbound?: {
    fields: readonly { label: string; value: string; truncated?: boolean | undefined }[];
  } | null;
}

export interface SecondStep {
  /** The first button: "Send 240 emails". */
  label: string;
  /** The second button: "Confirm: send 240 emails". */
  confirmLabel: string;
  /** What to type or say instead: "I approve sending 240 emails to Q3 leads". */
  phrase: string;
}

const RECIPIENT_FIELD = /^(to|cc|bcc|recipients?)$/i;
const AUDIENCE_FIELD = /^(audience|list|segment|sent to)$/i;
/** A separator outside double quotes, so `"Smith, Ivy" <ivy@example.com>` stays one recipient. */
const SEPARATOR = /[,;](?=(?:[^"]*"[^"]*")*[^"]*$)/;
const COUNT = /^(\d[\d,]*)(?:\s+(?:recipients?|people|contacts?|leads?|addresses))?$/i;

/** How many people an outbound action reaches. */
export interface Reach {
  count: number;
  /** A list was cut for display, so it reaches more than `count`. */
  atLeast: boolean;
}

/** The address of `Name <address>`, lower case, so one person in To and Cc counts once. */
function addressOf(recipient: string): string {
  const inBrackets = /<([^>]+)>/.exec(recipient)?.[1];
  return (inBrackets ?? recipient).trim().toLowerCase();
}

/** A count in a Recipients field, or the To, Cc and Bcc lists with repeats counted once. */
export function recipientReach(input: HighRiskInput["outbound"]): Reach {
  let counted = 0;
  let atLeast = false;
  const addresses = new Set<string>();
  for (const field of input?.fields ?? []) {
    if (!RECIPIENT_FIELD.test(field.label.trim())) continue;
    if (field.truncated) atLeast = true;
    const value = field.value.trim();
    const count = COUNT.exec(value)?.[1];
    if (count) {
      counted += Number(count.replace(/,/g, ""));
      continue;
    }
    const items = value.includes("\n") ? value.split("\n") : value.split(SEPARATOR);
    for (const item of items) if (item.trim()) addresses.add(addressOf(item));
  }
  return { count: counted + addresses.size, atLeast };
}

/** How many people an outbound action reaches, at least. */
export function recipientCount(input: HighRiskInput["outbound"]): number {
  return recipientReach(input).count;
}

function audienceOf(input: HighRiskInput["outbound"]): string | null {
  const field = input?.fields.find((f) => AUDIENCE_FIELD.test(f.label.trim()));
  return field?.value.trim() || null;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

const GERUNDS: Record<string, string> = {
  Delete: "deleting",
  Erase: "erasing",
  Merge: "merging",
  Remove: "removing",
};

function step(label: string, phrase: string): SecondStep {
  return { label, confirmLabel: `Confirm: ${lowerFirst(label)}`, phrase };
}

function destructivePhrase(title: string): string {
  const [verb = "", ...rest] = title.split(" ");
  const gerund = GERUNDS[verb];
  return gerund ? `I approve ${gerund} ${rest.join(" ")}` : `I approve: ${lowerFirst(title)}`;
}

/** The second step one action needs, or null when one tap is enough. */
export function secondStep(action: HighRiskInput, threshold: number): SecondStep | null {
  if (action.risk === "destructive") {
    return step(action.title, destructivePhrase(action.title));
  }
  if (action.risk === "outbound") {
    const { count, atLeast } = recipientReach(action.outbound);
    if (count > threshold || atLeast) {
      const emails = `${count}${atLeast ? "+" : ""} emails`;
      const audience = audienceOf(action.outbound);
      return step(
        `Send ${emails}`,
        `I approve sending ${emails}${audience ? ` to ${audience}` : ""}`,
      );
    }
  }
  return null;
}

/** The step for approving these actions at once: one action names itself, several are counted. */
export function combinedStep(steps: readonly (SecondStep | null)[]): SecondStep | null {
  const [first] = steps.filter((s): s is SecondStep => s !== null);
  if (!first) return null;
  if (steps.length === 1) return first;
  return step(`Approve ${steps.length} changes`, `I approve all ${steps.length} changes`);
}

/** `combinedStep` straight from actions. */
export function secondStepFor(
  actions: readonly HighRiskInput[],
  threshold: number,
): SecondStep | null {
  return combinedStep(actions.map((a) => secondStep(a, threshold)));
}
