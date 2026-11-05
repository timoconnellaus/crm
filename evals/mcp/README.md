# MCP eval

Stage 2 acceptance criterion 11 ([docs/stages/02-mcp.md](../../docs/stages/02-mcp.md)): an MCP
client model, connected to a running deployment over MCP, completes 20 natural-language CRM
tasks, with the target of at least 17 passing.

The runner signs in to the deployment as an eval user, connects to `/mcp` the way a real MCP
client does (OAuth 2.1 dynamic client registration, the consent page, a PKCE code exchange), and
hands the server's tools and instructions to the model over an OpenAI-compatible
chat-completions API with function calling. For each task it runs an agentic tool-use loop,
carries out the model's tool calls over MCP, records every call, then grades the run. Results go
to `reports/<timestamp>.md` and `.json`.

**No report has been committed yet.** The harness has been unit-tested and smoke-tested against a
local deployment, but not yet run against a model. The first real run's report (with Workers AI
credentials) should be committed to `reports/`.

## The model

The model is reached with plain `fetch` over the OpenAI chat-completions format (`tools` of type
`function`, `tool_calls` in the assistant message, `role: "tool"` results). Where it goes is
chosen from the environment:

| Variables | Endpoint |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | Workers AI: `https://api.cloudflare.com/client/v4/accounts/<account>/ai/v1/chat/completions` (the default) |
| … plus `CF_AI_GATEWAY_ID` (and `CF_AIG_TOKEN` for an authenticated gateway) | AI Gateway's OpenAI-compatible endpoint, `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/compat/chat/completions`, with the model sent as `workers-ai/<model>` |
| `EVAL_BASE_URL`, `EVAL_API_KEY` | any OpenAI-compatible server (`…/v1`; `/chat/completions` is appended). Takes precedence over the Cloudflare variables. `EVAL_API_KEY` is required; use any value for a server without keys |

The API token needs the Workers AI permission. The default model is
`@cf/moonshotai/kimi-k2.6` (Workers AI lists it with function calling, multi-turn tool use and a
262k-token context, which the 60-odd tool definitions and long tool results need). `--model` (or
`EVAL_MODEL`) picks another Workers AI model with function calling (see the catalogue), e.g.
`@cf/openai/gpt-oss-120b`; with `EVAL_BASE_URL`, pass that server's model name.

Requests answered 429 or 5xx, and requests that get no answer at all (a network error or the
10-minute per-attempt timeout), are retried up to 6 times with backoff from 2 s doubling to 60 s,
about two minutes in all. The runner logs each retry with its cause; a request that still fails
reports the cause (Node's fetch alone says only "fetch failed") and whether the machine slept
meanwhile. A 401, 403 or 404 (bad token, wrong account, unknown model) stops the run, since no
task could pass.

`--thinking on|off` (or `EVAL_THINKING`) sends DeepSeek's `thinking: { type: "enabled" |
"disabled" }`. Unset, nothing is sent and the server's default applies: DeepSeek thinks by
default, and the thinking counts against `max_tokens`.

### Credentials file (shared by every worktree)

Instead of exporting variables, put them in `.env.evals` at the root of the **main checkout**
(gitignored by `.env*`). Every runner (`evals/{mcp,extensions,dashboards,automations}`) loads it
from any worktree, because it finds the main checkout through git's common dir. Variables already
set in the shell win; `EVAL_ENV_FILE=/path/to/file` points at a different file.

```sh
# <main checkout>/.env.evals   (chmod 600)
EVAL_BASE_URL=https://api.deepseek.com/v1
EVAL_API_KEY=sk-…
EVAL_MODEL=deepseek-flash      # DeepSeek V4.1 Flash; deepseek-v4-pro also available
```

## Running it

1. Start the app. `pnpm dev` creates `apps/app/.dev.vars` (with `AUTH_ALLOW_SIGNUP=true`) and
   applies migrations to the local D1 database:

   ```sh
   pnpm dev                      # http://localhost:5173
   ```

2. Seed it, so the tasks run among realistic data (the tasks create their own records and do
   not depend on the seed):

   ```sh
   pnpm --filter @relationship-os/db seed -- --people 300 --organisations 80 --activities 200 --tasks 60
   ```

3. Leave the org's approval preset on **Balanced** (the default). The tasks expect single creates
   and updates to apply, and bulk writes, deletes and merges to be queued for approval. The runner
   stops a task with a clear failure if a fixture write comes back pending.

4. Set credentials and run:

   ```sh
   export CLOUDFLARE_ACCOUNT_ID=…  CLOUDFLARE_API_TOKEN=…
   node evals/mcp/runner.ts --base-url http://localhost:5173
   # or: pnpm --filter @relationship-os/evals-mcp eval -- --base-url http://localhost:5173
   ```

   Options: `--only id,id` runs some tasks (all of them must pass), `--model` (default
   `@cf/moonshotai/kimi-k2.6`), `--temperature` (0–2; the provider's default when omitted),
   `--max-tokens` (per model response, default 16000), `--reasoning-effort` (sent as
   `reasoning_effort` to models that take it), `--thinking on|off`, `--max-turns` (model requests per task, default
   20), `--email` / `--password` (or `MCP_EVAL_EMAIL` / `MCP_EVAL_PASSWORD`) for the eval user.
   Without credentials it exits with code 2 and writes nothing. It exits 0 when the target is
   met, 1 otherwise.

The eval user (`mcp-eval@example.com` by default) is signed in, or signed up when missing. On a
fresh database it is the first user and so an admin; otherwise it is a member, which is enough.

`node evals/mcp/smoke.ts --base-url …` checks the plumbing without a model: sign-in, OAuth, MCP,
tool conversion, and every task's fixture setup and outcome check against the untouched fixture.

## How a task runs

- **Fixture.** Each task creates the records it needs over a separate setup connection. Names
  carry a word generated per run ("Priya Varodin", "Varodin Freight"), so tasks never collide
  with the seed or with earlier runs.
- **Fresh connection.** The model gets a new OAuth client per task, so its MCP session, its change
  sets and any simulated pending state are its own.
- **Loop.** System message = the server's instructions plus today's date. The model's tool calls
  are run over MCP until it replies without tool calls or hits `--max-turns`. Multi-turn tasks
  send the next user message on the same conversation.

## What is graded

A task passes only when every check holds:

- **Tool choice.** `expectTools` must each be matched by a call that did not fail; `anyOf`
  groups accept any member. `op:person.merge` matches `call_operation` with that name or a
  curated tool for it (`op:person.changeJob` matches `person_changeJob`). `forbidTools` may not be
  called at all; `forbidSuccess` may be tried but must not succeed.
- **Reply.** `expectText` patterns against the model's reply to the last message (for example,
  that it told the user a change is waiting for approval), and `expectReason` patterns against the
  `reason` it gave a write.
- **Outcome.** A check reads the CRM afterwards over the setup connection (`query_sql` on the
  `crm_*` views, so real state without simulation), or the agent's own session for
  `approval_status`.

| Task | Covers |
| --- | --- |
| `search-before-create` | the person exists: search, don't duplicate |
| `create-person` | `person_create` with email, phone, location |
| `update-person` | `person_update`, with a reason naming the source |
| `create-organisation` | `organisation_create` with domain and industry |
| `change-job` | `person_changeJob`: old job ends, new one is current |
| `log-call` | `activity_log` call with duration |
| `log-note-organisation` | `activity_log` note on an organisation |
| `log-meeting` | meeting yesterday, linked to two people |
| `timeline` | summarise `activity_listForRecord` |
| `create-task` | `task_create` with due date and link |
| `complete-task` | `task_complete` on the right one of two tasks |
| `my-tasks` | `task.listMine` (long tail, via `call_operation`) |
| `sql-aggregate` | `query_sql` counts, answer checked in the reply |
| `bulk-update` | `person.updateMany` queued; nothing applied; user told |
| `merge` | `person.merge` queued with the right survivor; reason |
| `trash-person` | `person.delete` (long tail) queued |
| `change-history` | `audit.listForRecord` (long tail): the old value |
| `changeset` | `changeset_begin` … creates and notes … `changeset_commit` |
| `approval-follow-up` | delete queued, then `approval_status` when asked |
| `hidden-erase` | `person.erase` is hidden: nothing erased, user told |

## Layout

- `tasks.ts`: the 20 tasks.
- `runner.ts`: the CLI.
- `smoke.ts`: the plumbing check without a model.
- `lib/oauth.ts`, `lib/mcp.ts`: sign-in, OAuth (scopes are a parameter) and the MCP session.
- `lib/model.ts`: the OpenAI-compatible chat-completions client (`ModelClient`), provider
  selection from the environment, and the default model.
- `lib/convert.ts`: MCP tools to OpenAI function tools (`toOpenAiTools`). Function calling
  refuses `anyOf` / `oneOf` at the top of `parameters`, so union inputs (`activity_log`) are
  flattened, with the exact variants appended to the description.
- `lib/agent.ts`: the tool-use loop, behind `ModelClient` and `ToolExecutor` interfaces.
- `lib/cli.ts`: model options, the credentials check (exit 2) and `--only`, shared by runners.
- `lib/grading.ts`, `lib/harness.ts`, `lib/report.ts`: grading, running a task, the report.
- `test/`: unit tests (plain Node, no network). The loop is tested with a scripted model, the
  client against a fake `fetch`, and the task file against the tool names generated from
  `@relationship-os/core`'s registry.

`lib/*` is exported (`@relationship-os/evals-mcp/lib/agent.ts` and so on) for the other eval packages;
`evals/extensions` reuses the OAuth, MCP, model, conversion and loop modules.
