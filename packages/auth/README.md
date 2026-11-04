# @crm/auth

Deploy-time identity (ADR 0008).

- `IdentityProvider`: request → `Principal { userId, email, name, roles }`, or null.
- `better-auth` (default): email + password and Google sign-in, stored in `core_user`,
  `core_session`, `core_account` and `core_verification`. Sign-up is closed after the first user
  unless `AUTH_ALLOW_SIGNUP=true`.
- `cloudflare-access`: verifies the `Cf-Access-Jwt-Assertion` header (or `CF_Authorization` cookie)
  against the team's JWKS, issuer and the application's AUD tag.
- `createIdentityProvider(env)` picks the adapter from `IDENTITY_PROVIDER` and fails closed on an
  unknown value or missing configuration.

Identity is never configurable at runtime or by AI. Secrets come only from the environment.
