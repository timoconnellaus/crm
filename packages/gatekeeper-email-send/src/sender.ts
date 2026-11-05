// The sender-address resource: `email-send://sender/<url-encoded address>`.

import { domainOf, isEmailAddress, parseDomainList } from "./address";

export const SENDER_URL_PATTERN = "email-send://sender/:address";
const SENDER_URL_PREFIX = "email-send://sender/";
const MAX_URL_LENGTH = 1024;

/** The resource URL for a sender address. */
export function senderUrl(address: string): string {
  return SENDER_URL_PREFIX + encodeURIComponent(address);
}

/** The sender address a resource URL names, domain lower-cased. Throws on anything else. */
export function senderFromUrl(url: unknown): string {
  if (
    typeof url !== "string" ||
    url.length > MAX_URL_LENGTH ||
    !url.startsWith(SENDER_URL_PREFIX)
  ) {
    throw new TypeError(`Not a sender address URL; expected ${SENDER_URL_PATTERN}.`);
  }
  let address: string;
  try {
    address = decodeURIComponent(url.slice(SENDER_URL_PREFIX.length));
  } catch {
    throw new TypeError("The sender address URL is not validly encoded.");
  }
  if (!isEmailAddress(address)) {
    throw new TypeError("The sender address URL does not name a plain email address.");
  }
  const at = address.lastIndexOf("@");
  return `${address.slice(0, at)}@${address.slice(at + 1).toLowerCase()}`;
}

/** Throws unless the sender's domain is one of the comma-separated `allowedDomains`. */
export function assertSenderAllowed(sender: string, allowedDomains: string | undefined): void {
  const allowed = parseDomainList(allowedDomains);
  if (allowed.length === 0) {
    throw new Error(
      "No sender domains are configured for email sending: an administrator must set " +
        "ALLOWED_SENDER_DOMAINS on the ros-gatekeeper-email-send Worker.",
    );
  }
  const domain = domainOf(sender);
  if (!allowed.includes(domain)) {
    throw new Error(
      `Email can't be sent from ${domain}. Allowed sender domains: ${allowed.join(", ")}.`,
    );
  }
}
