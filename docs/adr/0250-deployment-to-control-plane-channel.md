# ADR 0250: A signed channel from a hosted deployment to the control plane

Status: accepted, 2026-11-05 (hosted AI build). Builds on ADR 0210 and ADR 0212; used by the
ADR 0213 amendment (the customer's own keys as tenant Worker secrets).

## Context
Until now the control plane only called deployments: it writes `core_entitlements` and
`core_support_grants` over the D1 API, and signs support-session tokens (Ed25519, ADR 0212) that
deployments verify. The hosted AI decision needs the reverse: Settings → AI in a hosted workspace
must get the customer's provider key set as a secret on that tenant's own Workers, which only the
control plane can do (it holds the Cloudflare API token; the deployment holds none). The request
must prove which tenant it comes from, and must never let one tenant change another's Workers.

There was no existing deployment → control-plane channel to reuse. The support token goes the
other way: reusing it would mean giving every deployment a private key the control plane trusts,
which is one key for all tenants.

## Decision
- **One key per tenant, derived, not stored.** `ROS_CONTROL_KEY = base64url(HMAC-SHA256(
  CONTROL_CHANNEL_SECRET, "ros-deployment-channel:" + tenant))`. The control plane derives it from
  one master secret (`CONTROL_CHANNEL_SECRET`, a ros-control secret) and sets it as a secret on the
  tenant's app Worker at provisioning, with the vars `ROS_TENANT_ID` and `ROS_CONTROL_URL`. Nothing
  per tenant is stored in the control plane's D1.
- **Each request is signed.** Headers `x-ros-tenant`, `x-ros-timestamp` (unix seconds) and
  `x-ros-signature: v1=<hex HMAC-SHA256(key, "v1\n<tenant>\n<timestamp>\n<METHOD>\n<path>\n<sha256
  hex of body>")>`, over HTTPS to `ROS_CONTROL_URL`. The control plane refuses a timestamp more than
  5 minutes off, an unknown tenant, or a bad signature (constant-time compare). Signing and
  verifying live in `@relationship-os/release` (`channel.ts`), which both ends already depend on.
- **One call today: `POST /api/deployment/ai-secret`** with `{ name, value? }`. It sets (or, with
  no value, removes) one secret on the tenant's AI Workers (those provisioned with
  `AI_PLATFORM_GATEWAY_ID`) through the Workers for Platforms script-secrets API. **Only**
  `AI_KEY_<PROVIDER>` and `AI_CUSTOMER_GATEWAY` are allowed (`isCustomerAiSecret`): never
  `BETTER_AUTH_SECRET`, the platform token or the channel key. Only for an active or paused
  instance in our account. Audited in `cp_audit` with the secret's name, never its value; the value
  is never stored, logged or echoed.
- **Replays.** No nonce is stored. A captured request can be replayed only within its 5 minutes,
  for the same tenant and the same body; every call is idempotent ("set this secret to this
  value"), so a replay changes nothing.

## Consequences
- Rotating `CONTROL_CHANNEL_SECRET` changes every tenant's key: re-set `ROS_CONTROL_KEY` on each
  deployment (a job over all instances; not built). Until then their calls fail with 401.
- The same channel can carry other deployment-initiated requests later (each with its own path and
  allowlist), instead of a new mechanism per feature.
- **To verify on real Cloudflare:** that a user Worker in the dispatch namespace can `fetch`
  `https://app.relationshiposcrm.com` (a Custom Domain on the same zone). If not, route the call
  through the dispatch Worker (an outbound Worker or a service binding to `ControlRpc`), keeping
  the same signature.
