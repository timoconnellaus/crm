# ADR 0156: Optional AI bindings, added at deploy; stand-ins locally

Status: accepted, 2026-11-05 (stage 7a build). Amends ADR 0059's `AI_FAKE_MODEL`.

## Context
Neither Workers AI nor Vectorize runs locally: both are remote-only bindings
([local development](https://developers.cloudflare.com/workers/local-development/)). Declaring
`"ai"` or `"vectorize"` in `wrangler.jsonc` makes `vite dev`, `wrangler dev` and
`@cloudflare/vitest-plugin` open a remote proxy, which needs a Cloudflare login and an account
choice. We tried it: the app's test pool fails to start ("More than one account available but
unable to select one in non-interactive mode"). Tests and e2e must run without credentials.

## Decision
- **The committed `wrangler.jsonc` files leave both bindings out.** `pnpm run deploy` adds them:
  it writes `wrangler.deploy.jsonc` next to each config (git-ignored) with `"ai": { "binding": "AI" }`
  on both Workers and `"vectorize": [{ "binding": "VECTORIZE", "index_name": "crm-records" }]` on
  crm-app, creates the index when missing, deploys crm-runner with `--config`, and builds crm-app
  with `CRM_WRANGLER_CONFIG` (read by `vite.config.ts`). `CRM_AI=off` deploys without them.
- **Every AI feature degrades when a binding is missing**: no model runner → "AI is not
  configured" (summaries, Describe a widget, the Test button, `codemode:ai`); no Vectorize →
  search.hybrid is full-text only, Similar records says semantic search is not configured, and
  the embedding queue is left alone (nothing to drain into).
- **Locally**, `AI_FAKE_MODEL=true` (written to `.dev.vars` by `pnpm dev`, never in production)
  now answers **every** role with deterministic stand-ins (`fakeModels()`: the build role's canned
  widgets, summaries built from the prompt's fact lines, the fake embedder) and crm-app keeps
  vectors in memory per isolate. The stand-ins are used only when there is no `AI` binding.
- Tests inject a fake `AI` binding, a fake OpenAI-compatible server and an in-memory vector store
  (`packages/core/test/ai-helpers.ts`), so the whole registry, gateway routing and the drain run in
  workerd without network.

## Consequences
- A deploy made with plain `wrangler deploy` (not the script) has no AI until the bindings are
  added; Settings → AI then says why.
- In-memory vectors in local development are lost when the dev server restarts; records written
  after that are indexed again by the post-commit drain, older ones by the backfill only if their
  state rows are cleared. This is dev-only.
