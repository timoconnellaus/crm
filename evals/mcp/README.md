# MCP eval

Stage 2 acceptance criterion 11 ([docs/stages/02-mcp.md](../../docs/stages/02-mcp.md)): Claude,
connected to a running deployment over MCP, completes 20 natural-language CRM tasks, with the
target of at least 17 passing.

The runner signs in to the deployment as an eval user, connects to `/mcp` the way a real MCP
client does (OAuth 2.1 dynamic client registration, the consent page, a PKCE code exchange), and
hands the server's tools and instructions to Claude through the Messages API. For each task it
runs an agentic tool-use loop, carries out Claude's tool calls over MCP, records every call, then
grades the run. Results go to `reports/<timestamp>.md` and `.json`.

**No report has been committed yet.** When the harness was built, no Anthropic API key was
available, so it has been unit-tested and smoke-tested against a local deployment, but not run
against Claude. The first real run's report should be committed to `reports/`.

## Running it

1. Start the app. `pnpm dev` creates `apps/app/.dev.vars` (with `AUTH_ALLOW_SIGNUP=true`) and
   applies migrations to the local D1 database:

   ```sh
   pnpm dev                      # http://localhost:5173
   ```

2. Seed it, so the tasks run among realistic data (the tasks create their own records and do
   not depend on the seed):

   ```sh
   pnpm --filter @crm/db seed -- --people 300 --organisations 80 --activities 200 --tasks 60
   ```

3. Leave the org's approval preset on **Balanced** (the default). The tasks expect single creates
   and updates to apply, and bulk writes, deletes and merges to be queued for approval. The runner
   stops a task with a clear failure if a fixture write comes back pending.

4. Set a key and run:

   ```sh
   export ANTHROPIC_API_KEY=sk-ant-…
   node evals/mcp/runner.ts --base-url http://localhost:5173
   # or: pnpm --filter @crm/evals-mcp eval -- --base-url http://localhost:5173
   ```

   Options: `--only id,id` runs some tasks (all of them must pass), `--model` (default
   `claude-opus-5-5`), `--effort low|medium|high|xhigh|max` (default `high`), `--max-turns`
   (model requests per task, default 20), `--email` / `--password` (or `MCP_EVAL_EMAIL` /
   `MCP_EVAL_PASSWORD`) for the eval user. Without a key it exits with code 2 and writes nothing.
   It exits 0 when the target is met, 1 otherwise.

The eval user (`mcp-eval@example.com` by default) is signed in, or signed up when missing. On a
fresh database it is the first user and so an admin; otherwise it is a member, which is enough.

`node evals/mcp/smoke.ts --base-url …` checks the plumbing without Claude: sign-in, OAuth, MCP,
tool conversion, and every task's fixture setup and outcome check against the untouched fixture.

## How a task runs

- **Fixture.** Each task creates the records it needs over a separate setup connection. Names
  carry a word generated per run ("Priya Varodin", "Varodin Freight"), so tasks never collide
  with the seed or with earlier runs.
- **Fresh connection.** Claude gets a new OAuth client per task, so its MCP session, its change
  sets and any simulated pending state are its own.
- **Loop.** System prompt = the server's instructions plus today's date. Claude's tool calls are
  run over MCP until it ends its turn or hits `--max-turns`. Multi-turn tasks send the next user
  message on the same conversation.

## What is graded

A task passes only when every check holds:

- **Tool choice.** `expectTools` must each be matched by a call that did not fail; `anyOf`
  groups accept any member. `op:person.merge` matches `call_operation` with that name or a
  curated tool for it (`op:person.changeJob` matches `person_changeJob`). `forbidTools` may not be
  called at all; `forbidSuccess` may be tried but must not succeed.
- **Reply.** `expectText` patterns against Claude's reply to the last message (for example, that
  it told the user a change is waiting for approval), and `expectReason` patterns against the
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
- `smoke.ts`: the plumbing check without Claude.
- `lib/oauth.ts`, `lib/mcp.ts`: sign-in, OAuth and the MCP session.
- `lib/convert.ts`: MCP tools to Anthropic tool definitions. The Messages API refuses `anyOf` /
  `oneOf` at the top of `input_schema`, so union inputs (`activity_log`) are flattened, with the
  exact variants appended to the description.
- `lib/agent.ts`: the tool-use loop, behind `ModelClient` and `ToolExecutor` interfaces.
- `lib/grading.ts`, `lib/harness.ts`, `lib/report.ts`: grading, running a task, the report.
- `test/`: unit tests (plain Node, no network). The loop is tested with a scripted model, and the
  task file against the tool names generated from `@crm/core`'s registry.

The runner does not enable server-side refusal fallbacks: the eval measures one model, and a
fallback would answer with another. A refusal fails the task with its stop reason.
