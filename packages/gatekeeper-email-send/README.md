# @crm/gatekeeper-email-send

Worker `crm-gatekeeper-email-send`: an outbound gatekeeper that sends email through
[Cloudflare Email Service](https://developers.cloudflare.com/email-service/). It is ours, not
vendored. It is built on `@crm/gatekeeper-kit` and implements the Cloudflare OS gatekeeper interface
(`@crm/gatekeeper-interface`). Every email is an approval-queue action, and nothing is sent until
the host applies that action. See `docs/stages/06-integrations.md`, "Own outbound gatekeepers".

## Shape

| Piece | Name |
| --- | --- |
| Vendor entrypoint (default export) | `GatekeeperVendor` |
| Account entrypoint (from `createAccount()`) | `EmailSendAccount` |
| Verifier entrypoint | `EmailSendVerifier`, which admits everyone |
| Facet (Durable Object class, reached through `ctx.exports`) | `EmailSendGatekeeper` |
| Migration | `v1`: `new_sqlite_classes: ["EmailSendGatekeeper"]` |

- **Vendor**: `describe()` returns display name "Email sending" with `autoProvisionsAccount: true`.
  `createAccount()` mints an account with no OAuth, and `connectAccount()` throws.
- **Resource**: one grantable type, **Sender address**, with URL pattern
  `email-send://sender/:address`. The address is URL-encoded, e.g.
  `email-send://sender/crm%40example.com`. `getGatekeeperClassFor()` refuses a sender whose domain
  is not in `ALLOWED_SENDER_DOMAINS`.
- **Configurator**: `startResourceConfigurator()` returns a minimal fallback iframe plus a `ui`
  capability with `allowedDomains(): Promise<string[]>`. The CRM renders the spec module
  `@crm/gatekeeper-email-send/configurator/sender` (`src/configurator/sender-configurator-ui.tsx`,
  written against `@crm/gatekeeper-configurator-ui`): a text input for the address, whose
  `resourceUrl` builds the URL above.

## Session API (`EmailSendSession`, types in `src/types.d.ts`)

```ts
send(message: {
  to: string[]; cc?: string[]; bcc?: string[];   // 1–50 recipients in total, plain addresses
  subject: string;                                // one line, ≤ 998 chars
  text?: string; html?: string;                   // at least one; each ≤ 32 KiB
  replyTo?: string;
  relatedRecords?: string[];                      // ≤ 20 CRM ids, provisional ones (per_pending_…) fine
}): Promise<{ status: "pending" | "sent"; id: number }>;
listSent(): Promise<Array<{ id: number; to: string[]; subject: string;
  status: "pending" | "sent" | "rejected"; sentAt?: string }>>;
getSender(): Promise<string>;
```

Every input is validated explicitly (zod, strict objects, bounded sizes). We use no `@validateRpc`
decorators, because the CRM app's Vite dev server does not transform them. `listSent()` calls
`authorizeObservation()` before it returns. It shows sends still awaiting approval as `pending`
(simulation from the action journal), then the last 200 sent or rejected ones.

## Actions

| `actionKind.tag` | Label | `autoApprovable` | When |
| --- | --- | --- | --- |
| `email.send` | Send email | `false` | Any send with a recipient outside `INTERNAL_DOMAINS` |
| `email.internal` | Send email to colleagues | `true` | Every recipient's domain is in `INTERNAL_DOMAINS` |

`getAutoApprovableActions()` returns `[email.internal]`. The description is a rendered preview
built with the kit's `buildDescription`:

- title `Send email: <subject>`
- fields From, To, Cc, Bcc, Reply-To, Subject, Body (plain text), HTML body (`syntax: "html"`) and
  Related records (so the host can find provisional CRM ids)
- `descriptionIsComplete: true` and `implementsRevert: false`

Agent text never goes into the prose.

`applyAction(n)` sends once through the kit's journal, with `claimBeforeApply`:

- Applying an id again is a no-op.
- If the activation dies mid-send, the outcome becomes unknown and is never retried.
- An Email Service refusal (`E_SENDER_NOT_VERIFIED` and similar) fails terminally.
- `E_RATE_LIMIT_EXCEEDED` and `E_DAILY_LIMIT_EXCEEDED` are retryable.

Other errors are an unknown outcome, so the email is not resent. Resolution is serialized, and the
host applies in its own order. The gatekeeper does not block a later action behind an earlier
pending one, because an auto-approved internal email must not wait for an external one under
review. `rejectAction(n)` drops the email, and `revertAction` throws.

## Transport

`src/transport.ts` is the only code that touches Email Service. It uses the `send_email` binding
`EMAIL` and its structured `send()`:

```ts
env.EMAIL.send({ from, to, cc, bcc, subject, text, html, replyTo })
// → Promise<{ messageId: string }>
```

The binding throws `Error`s with a `code` such as `E_SENDER_NOT_VERIFIED`. The binding is declared
in `wrangler.jsonc` as `"send_email": [{ "name": "EMAIL" }]`, and `wrangler types` gives `SendEmail`
with `send(builder: EmailMessageBuilder)`. Sources, checked 2026-11-05:

- <https://developers.cloudflare.com/email-service/api/send-emails/workers-api/>
- <https://developers.cloudflare.com/email-service/> (onboard each sender domain first)

The tests bind `EMAIL` to a fake entrypoint with the same `send()` shape (`test/worker.ts`,
`FakeEmail`). They do that through miniflare's current-worker service binding.

## Configuration

| Var | Meaning |
| --- | --- |
| `ALLOWED_SENDER_DOMAINS` | Comma-separated sender domains. If empty, every sender is refused with a clear error. |
| `INTERNAL_DOMAINS` | Comma-separated colleague domains for `email.internal`. If empty, nothing is internal. |

There are no secrets and no public routes. The Worker is reached only through a service binding
from the integration host.

## Scripts

`pnpm typecheck` runs `wrangler types --check` and `tsc`. `pnpm test` runs the workerd tests via
`@cloudflare/vitest-plugin`, through a host-like `TestHost` DO that creates the facet with
`ctx.facets.get()`. `pnpm build` runs `wrangler deploy --dry-run`.
