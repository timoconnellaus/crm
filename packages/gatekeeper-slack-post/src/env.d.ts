// Secrets, which `wrangler types` cannot see (they are not in wrangler.jsonc).

declare namespace Cloudflare {
  interface Env {
    // The Slack app shared with crm-gatekeeper-slack: the same secret names it uses.
    CLIENT_ID?: string;
    CLIENT_SECRET?: string;
  }
}
