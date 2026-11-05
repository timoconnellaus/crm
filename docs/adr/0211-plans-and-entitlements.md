# ADR 0211: Plans, and the entitlements a hosted deployment enforces

Status: accepted, 2026-11-05 (Stage 10; pricing from the landing-page interview, which overrides the
Stage 10 spec's "per-seat or per-org" wording).

## Decision
| Plan | Price | Users | Records | AI included |
| --- | --- | --- | --- | --- |
| Free | $0 | 1 | 1,000 people + organisations | none: buy AI credit, or BYOK / MCP |
| Team | $39/month | 10 | unlimited | $10/month |
| Business | $149/month | unlimited | unlimited | $25/month |
| Enterprise | contract | unlimited | unlimited | by contract (default $25) |

Paid plans start with a 14-day trial (`TRIAL_DAYS`). Prices live in Stripe (ADR 0214); limits in
`apps/control/src/plans.ts`.

- **The entitlement surface** is one row the control plane writes into the customer's own D1 over
  the D1 API: `core_entitlements` (migration 0220), key `plan`, value
  `{ plan, maxUsers, maxRecords, platformAi, updatedAt }`. `null` = unlimited. No operation, UI or AI
  path writes it (identity and policy are not AI-configurable). **Self-hosted deployments have no
  row and so no limits.**
- **Enforced in the deployment** (`packages/core/src/entitlements.ts`), cached 60 s per isolate:
  - users: active humans (`kind='human'`, not deactivated, not support users) in the Better Auth
    sign-up hook and in `resolveActingUser`'s auto-create (Cloudflare Access); the first user is
    always allowed;
  - records: live people + organisations on `person.create`, `organisation.create`, their restores
    and `import.csv.commit`; counts use the partial live-row indexes and run only when a limit is set;
  - AI: `platformAi: false` blocks models we pay for (the Workers AI binding, Workers-secret keys,
    and the embed role) with `AiAllowanceError`; BYOK providers keep working, and a fallback is
    checked too, so a call never lands silently on a blocked model.
  Over a limit the operation fails with `PlanLimitError` (`plan_limit`) naming the plan and linking
  to billing. Existing data is never removed: an over-limit workspace just cannot add more.
- **Fail open on an unparseable row**: only our control plane writes it, so a bad value is our bug
  and must not lock out a paying customer (logged, tested).
- Settings → Plan (`plan.get`, admins) shows the plan and usage in a hosted workspace.

## Consequences
- A plan change reaches a deployment within a minute (the cache).
- The record count cannot see writes queued earlier in the same nested operation, so a workspace can
  end one record over its limit at the boundary.
- While `platformAi` is off, semantic-search embeddings stop and search falls back to full text.
  Whether embeddings should stay included on every plan is open.
