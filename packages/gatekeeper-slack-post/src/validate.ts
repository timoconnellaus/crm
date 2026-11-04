// Input validation for everything that reaches this Worker over RPC. Sessions are called by
// untrusted extension code, so every value is parsed strictly and bounded in size.

import { z } from "zod";

/** Slack truncates longer messages; refuse them instead so the approver sees what is sent. */
export const MAX_TEXT_LENGTH = 4000;
export const MAX_RELATED_RECORDS = 20;

const CHANNEL_ID = /^C[A-Z0-9]{2,20}$/;
const CHANNEL_NAME = /^#?[a-z0-9][a-z0-9._-]{0,79}$/;
const USER_ID = /^[UW][A-Z0-9]{2,20}$/;
const TEAM_ID = /^T[A-Z0-9]{2,20}$/;
const MESSAGE_TS = /^\d{9,12}\.\d{1,9}$/;
const RECORD_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const EMAIL =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

export function isChannelId(value: string): boolean {
  return CHANNEL_ID.test(value);
}

export function isUserId(value: string): boolean {
  return USER_ID.test(value);
}

export function isTeamId(value: unknown): value is string {
  return typeof value === "string" && TEAM_ID.test(value);
}

const email = z.string().max(254).regex(EMAIL, "must be an email address");
const text = z
  .string()
  .max(MAX_TEXT_LENGTH)
  .refine((value) => value.trim() !== "", "must not be empty");
const relatedRecords = z
  .array(z.string().regex(RECORD_ID, "must be a CRM record id"))
  .max(MAX_RELATED_RECORDS)
  .optional();

const postSchema = z.strictObject({
  channel: z
    .string()
    .max(81)
    .refine(
      (value) => CHANNEL_ID.test(value) || CHANNEL_NAME.test(value),
      "must be a public channel id (C…) or name (#name)",
    ),
  text,
  threadTs: z.string().regex(MESSAGE_TS, "must be a Slack message ts").optional(),
  relatedRecords,
});

const dmSchema = z.strictObject({
  user: z
    .string()
    .max(254)
    .refine(
      (value) => USER_ID.test(value) || EMAIL.test(value),
      "must be a Slack user id (U…) or an email address",
    ),
  text,
  relatedRecords,
});

export type PostInput = z.infer<typeof postSchema>;
export type DmInput = z.infer<typeof dmSchema>;

function parse<T>(schema: z.ZodType<T>, input: unknown, what: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join(".")} ` : "";
    throw new TypeError(`Invalid ${what}: ${where}${issue?.message ?? "is malformed"}.`);
  }
  return result.data;
}

export function parsePost(input: unknown): PostInput {
  return parse(postSchema, input, "Slack post");
}

export function parseDm(input: unknown): DmInput {
  return parse(dmSchema, input, "Slack DM");
}

export function parseEmail(input: unknown): string {
  return parse(email, input, "email address");
}
