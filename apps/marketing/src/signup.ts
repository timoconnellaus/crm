// The landing page's one form: join the waitlist, or ask sales to get in touch (ADR 0191).
// Submissions go to D1 only; nothing is sent to a third party and no tracking data is kept.
import { z } from "zod";

export const SignupInput = z.object({
  kind: z.enum(["waitlist", "sales"]).default("waitlist"),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  name: z.string().trim().max(200).optional(),
  company: z.string().trim().max(200).optional(),
  plan: z.enum(["self-host", "cloud", "enterprise"]).optional(),
  message: z.string().trim().max(2000).optional(),
});
export type SignupInput = z.infer<typeof SignupInput>;

/** The honeypot field: hidden from people, filled in by naive bots. */
export const HONEYPOT = "website";

/** Form fields to a plain object: empty strings are left out, so optional fields stay optional. */
export function formFields(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of form) {
    if (typeof value === "string" && value.trim() !== "") out[key] = value;
  }
  return out;
}

/** Stores a submission. A repeat for the same email and kind updates it. */
export async function saveSignup(db: D1Database, input: SignupInput, now = new Date()) {
  const at = now.toISOString();
  await db
    .prepare(
      `INSERT INTO marketing_signup (kind, email, name, company, plan, message, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
       ON CONFLICT (kind, email) DO UPDATE SET
         name = COALESCE(excluded.name, name),
         company = COALESCE(excluded.company, company),
         plan = COALESCE(excluded.plan, plan),
         message = COALESCE(excluded.message, message),
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.kind,
      input.email,
      input.name ?? null,
      input.company ?? null,
      input.plan ?? null,
      input.message ?? null,
      at,
    )
    .run();
}
