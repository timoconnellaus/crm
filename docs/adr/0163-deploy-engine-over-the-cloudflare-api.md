# ADR 0163: The deploy engine talks to the Cloudflare API directly

Status: accepted, 2026-11-05 (stage 8 build).

## Decision
`packages/release` deploys a bundle with `fetch` against the Cloudflare REST API, in Node (the CLI)
and in Workers (the self-updater) alike. No wrangler at runtime.

- **Provision** (find by name, else create): D1 ([create/list](https://developers.cloudflare.com/api/resources/d1/subresources/database/)),
  R2 ([buckets](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/create/)),
  KV ([namespaces](https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/methods/create/)),
  Queues ([queues](https://developers.cloudflare.com/api/resources/queues/methods/create/)),
  Vectorize ([v2 indexes](https://developers.cloudflare.com/api/resources/vectorize/subresources/indexes/methods/create/)).
  Workflows and Durable Objects are created by the script upload itself (a `workflow` binding with no
  `script_name` registers it); resolved ids go into `core_install`.
- **Migrations** over `POST …/d1/database/{id}/query`, each migration plus its `core_migrations` row
  in one query, which D1 runs as one batch, exactly as `wrangler d1 migrations apply` bookkeeps, so
  either tool sees the other's work.
- **Workers:** stage everything first: assets through an upload session
  ([direct upload](https://developers.cloudflare.com/workers/static-assets/direct-upload/)), then a new
  **version** of each existing Worker without traffic
  ([versions](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/));
  then switch them back to back, dependencies first, with
  [deployments](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/create/).
  A new Worker, or one whose Durable Object migration tag moves, is uploaded with `PUT …/scripts/{name}`
  (versions cannot carry DO migrations), with `old_tag` = the deployed tag and only the later steps.
  There is no cross-script atomic deploy, so "together" means after all uploads succeeded, in
  consecutive calls.
- **Secrets** are `secret_text` bindings in the upload metadata (one version, not one per secret,
  unlike [the secrets API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/)),
  and every upload sends `keep_bindings: ["secret_text", "secret_key"]` so secrets not set in this
  run keep their stored values.
- **Then:** cron schedules, queue consumers (not part of upload metadata), workers.dev on/off
  ([subdomain](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/methods/create/))
  or a custom domain ([domains](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/)).
- **Idempotent:** every step checks first; re-running an install changes nothing that is already
  right and keeps BETTER_AUTH_SECRET.
- **Token permissions** (account level): Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit,
  Workers KV Storage Edit, Queues Edit, Vectorize Edit, Account Settings Read; for a custom hostname
  also Zone Read and Workers Routes Edit on the zone
  ([permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)).
- The client never logs, and errors carry the API's messages, never request bodies. The CLI also
  redacts every secret it handled from its output.
- **Tests** run against `FakeCloudflare` (`@crm/release/testing`), which is strict where the API is
  (auth, DO `old_tag`, no migrations on versions, assets tokens), with SQL on Node's SQLite and Time
  Travel emulated by replaying writes.

## Consequences
- We maintain a small API client instead of depending on wrangler's internals. Fields such as
  `worker_loader` are documented only in wrangler's source; the real-account test (ADR 0168) is the
  backstop.
