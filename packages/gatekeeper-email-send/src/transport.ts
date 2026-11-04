// The one seam between this gatekeeper and Cloudflare Email Service. Production passes the
// `send_email` binding (`env.EMAIL`); tests bind `EMAIL` to a fake entrypoint with the same
// `send()` shape, so nothing else needs to know which it is.

/** What an approved send hands the transport: plain addresses, already validated. */
export type OutgoingEmail = {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
};

/** The structural subset of Email Service's `SendEmail` binding this gatekeeper uses. */
export type EmailTransport = {
  send(message: OutgoingEmail): Promise<{ messageId: string }>;
};

/** Sends through Email Service's structured `send()` (no raw MIME). */
export async function sendEmail(
  transport: EmailTransport,
  email: OutgoingEmail,
): Promise<{ messageId: string }> {
  const result = await transport.send(email);
  return { messageId: typeof result?.messageId === "string" ? result.messageId : "" };
}

/**
 * Whether an Email Service error proves the message was refused before delivery started: a
 * payload, sender or recipient error. Anything else (rate limits, delivery or internal errors,
 * a dropped connection) leaves the outcome unknown.
 */
export function isRefusedBeforeSending(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return (
    typeof code === "string" &&
    [
      "E_VALIDATION_ERROR",
      "E_FIELD_MISSING",
      "E_TOO_MANY_RECIPIENTS",
      "E_TOO_MANY_ATTACHMENTS",
      "E_CONTENT_TOO_LARGE",
      "E_SENDER_NOT_VERIFIED",
      "E_SENDER_DOMAIN_NOT_AVAILABLE",
      "E_RECIPIENT_NOT_ALLOWED",
      "E_RECIPIENT_SUPPRESSED",
      "E_ACCOUNT_SUSPENDED",
      "E_RATE_LIMIT_EXCEEDED",
      "E_DAILY_LIMIT_EXCEEDED",
      "E_HEADER_NOT_ALLOWED",
      "E_HEADER_USE_API_FIELD",
      "E_HEADER_VALUE_INVALID",
      "E_HEADER_VALUE_TOO_LONG",
      "E_HEADER_NAME_INVALID",
      "E_HEADERS_TOO_LARGE",
      "E_HEADERS_TOO_MANY",
    ].includes(code)
  );
}

/** Rate and quota refusals: known not sent, and worth retrying later. */
export function isRetryableRefusal(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return code === "E_RATE_LIMIT_EXCEEDED" || code === "E_DAILY_LIMIT_EXCEEDED";
}
