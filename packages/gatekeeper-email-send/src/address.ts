// Email address and domain-list helpers, dependency-free so the configurator module can use them.

const MAX_ADDRESS_LENGTH = 254;

// A deliberately plain address grammar: local@domain.tld, no display names, quotes, comments or
// whitespace, so nothing an approver reads differs from what Email Service receives.
const ADDRESS =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

/** Whether `value` is a plain email address this gatekeeper accepts. */
export function isEmailAddress(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_ADDRESS_LENGTH && ADDRESS.test(value);
}

/** The lower-cased domain of a validated address. */
export function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/** Parses a comma-separated domain list from a var, lower-cased, blanks dropped. */
export function parseDomainList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain) => domain !== "");
}
