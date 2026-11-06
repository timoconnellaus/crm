// The building blocks every A2UI component is made of (ADR 0346): short texts, record references,
// facts, actions and form fields. Everything is bounded, so a card stays small enough for the
// thread and the model's context, and nothing in it is code: links are paths or allow-listed
// https URLs, images come from the host's own storage, and an action names an operation and its
// input (the host runs it with the viewer's permissions), a page to open, or a reply to send.
import { z } from "zod";

/** A short line of text (titles, labels, values). */
export const line = (max = 200) => z.string().trim().min(1).max(max);
/** Longer text: notes, summaries, a draft's body. Markdown where a component says so. */
export const prose = (max = 4_000) => z.string().max(max);

/** How a status or badge reads. */
export const TONES = ["neutral", "info", "success", "warning", "danger"] as const;
export const toneSchema = z.enum(TONES);
export type Tone = z.infer<typeof toneSchema>;

/**
 * A path inside the host app ("/people/per_…"), or an https URL. Hosts decide which external
 * origins they open (`A2uiHost.allowExternal`); the schema only refuses other schemes.
 */
export const hrefSchema = z
  .string()
  .max(2_000)
  .refine((href) => /^\/(?!\/)/.test(href) || /^https:\/\/[^\s]+$/.test(href), {
    message: "a link is a path starting with / or an https URL",
  });

/** An operation name: `object.verb`, or an extension tool `x.ext.tool`. */
export const operationNameSchema = z
  .string()
  .max(120)
  .regex(/^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9_-]+)+$/, "an operation name such as task.complete");

/** A record the card shows: what it is, its id and how it is called. */
export const recordRefSchema = z.object({
  object: line(80).describe("person, organisation, task, deals.deal, …"),
  id: line(80),
  label: line(200),
  subtitle: z.string().max(200).optional(),
});
export type RecordRef = z.infer<typeof recordRefSchema>;

/** One "label: value" fact. */
export const factSchema = z.object({
  label: line(80),
  value: z.string().max(400),
  record: recordRefSchema.optional().describe("When the value is a record, it shows as a chip"),
});
export type Fact = z.infer<typeof factSchema>;

export const ACTION_STYLES = ["primary", "secondary", "ghost", "destructive"] as const;

const actionBase = {
  label: line(60),
  style: z.enum(ACTION_STYLES).optional(),
};

/**
 * What a button does. Every button that changes something is an operation call, run by the host
 * with the viewer's permissions, through the gate and approvals (ADR 0346). `confirm` makes it a
 * two-step button: the first press shows the confirm label and Cancel.
 */
export const actionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("operation"),
    ...actionBase,
    operation: operationNameSchema,
    input: z.record(z.string(), z.unknown()).default({}),
    confirm: line(120).optional().describe("Two-step: the label of the second press"),
    done: z.string().max(120).optional().describe("Shown once it worked, e.g. 'Task created'"),
  }),
  z.object({ kind: z.literal("open"), ...actionBase, href: hrefSchema }),
  z.object({
    kind: z.literal("reply"),
    ...actionBase,
    text: line(500).describe("Sent to the assistant as the person's message"),
  }),
]);
export type A2uiAction = z.infer<typeof actionSchema>;
export type OperationAction = Extract<A2uiAction, { kind: "operation" }>;

/** Buttons: at most four, as the catalogue says. */
export const actionsSchema = z.array(actionSchema).max(4);

export const FIELD_KINDS = [
  "text",
  "textarea",
  "number",
  "money",
  "date",
  "select",
  "user",
  "record",
  "checkbox",
] as const;

/** A form field (record forms, generic forms, stage rules). */
export const formFieldSchema = z.object({
  name: z
    .string()
    .max(80)
    .regex(/^[A-Za-z_][A-Za-z0-9_.]*$/, "a field name"),
  label: line(80),
  kind: z.enum(FIELD_KINDS),
  required: z.boolean().optional(),
  value: z.union([z.string().max(4_000), z.number(), z.boolean(), z.null()]).optional(),
  /** The value's display text, for user and record fields ("Lumen Labs"). */
  valueLabel: z.string().max(200).optional(),
  placeholder: z.string().max(200).optional(),
  options: z
    .array(z.object({ value: line(200), label: line(200) }))
    .max(50)
    .optional(),
  /** Record fields: which object to pick from. */
  object: z.string().max(80).optional(),
  help: z.string().max(300).optional(),
});
export type FormField = z.infer<typeof formFieldSchema>;

/**
 * Where a form's values go: one operation. `input` is fixed input merged under the field values
 * (`{ object: "deals.deal" }`); a field named `values.name` lands at `input.values.name`.
 */
export const submitSchema = z.object({
  label: line(60),
  operation: operationNameSchema,
  input: z.record(z.string(), z.unknown()).default({}),
  done: z.string().max(120).optional(),
});
export type FormSubmit = z.infer<typeof submitSchema>;
