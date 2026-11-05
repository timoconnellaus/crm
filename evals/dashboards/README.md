# Dashboards eval

Stage 4a: a model, connected to a running deployment over MCP, turns 10 "build me a chart of…"
prompts into dashboard widgets. Each widget must run, and its chart type must fit the prompt. The
target is at least 8 of 10.

The eval reuses `evals/mcp`'s client: sign-in, the OAuth flow, the MCP session, the
OpenAI-compatible model client, the tool conversion and the tool-use loop. It uses Workers AI by
default, or any OpenAI-compatible endpoint. Per ADR 0009 it never uses Claude or Anthropic and
never needs an Anthropic key. Results go to `reports/<timestamp>.md` and `.json`.

**No report has been committed.** The build session had no model credentials (no Cloudflare
account or token, and no other endpoint). So the harness has been unit-tested, with a scripted
model and an in-memory CRM, but has not been run against a model or a deployment. Once
credentials are available, commit the first real run's report to `reports/`, with a smoke run
before it.

## Two modes

- **`--mode agent`** (the default) is the MCP route. The model gets a fresh MCP connection. Its
  system prompt is the server's instructions, today's date, and the widget guidance that the
  in-app box gives its model (`describePrompt` from `@relationship-os/core`, minus the box's "answer with
  JSON only" opening line), plus the dashboard's filters. It builds the widget with the CRM's
  tools and finishes by calling `call_operation` with `widget.preview`.
- **`--mode describe`** is the in-app "Describe a widget" box (`widget.describe`), reproduced
  with the eval model. `describePrompt`'s messages go to the model with no tools. The answer is
  parsed with `extractJson` and normalised the way `widget.describe` does it, then previewed over
  MCP. One failure goes back to the model with the error, as the operation does. Only the model
  differs: the deployment's `build` role is replaced by the eval model.

In both modes the widget is built for a dashboard that has the Overview's filters (`date`, a
date range, and `owner`, a user). So `:date_from`, `:date_to` and `:owner` bind, as do `:now`,
`:today` and `:me`.

## What is graded

The widget graded is the model's final answer:

- in agent mode, the widget of its last *successful* `widget.preview` call. If no preview
  succeeded, the last one it attempted. If it never previewed, the last widget it saved with
  `dashboard.create` or `dashboard.update`.
- in describe mode, the widget from its last answer.

The grader does not take the model's word for it. It runs the widget again through
`widget.preview` on its own MCP connection, with the same dashboard filters and values and with
`refresh: true`. Then it checks:

1. **SQL** (`sql`): the preview returns columns and rows, not a validation error.
2. **Chart type** (`type`): the type is one the prompt accepts.
3. **Mapping** (`mapping`): the mapping sets the keys its type needs (kpi → `value`, bar/line →
   `x` and `y`, donut/funnel/leaderboard → `label` and `value`), and every column it names is
   one the preview returned.
4. **Expectations** (`expectation`): a few prompts add their own checks. "Top 5" must show at
   most five rows (or set `options.limit` ≤ 5). "Horizontal bars" must set
   `orientation: "horizontal"`. A trend needs an x axis. "Split by type" needs a series. A
   funnel needs at least two stages.

The harness seeds nothing. The prompts work on any seeded database. The seed sets no owners or
assignees, so no prompt groups by them. If the model saves a dashboard on the way, the harness
deletes it afterwards.

| Prompt | Asks for | Accepted types |
| --- | --- | --- |
| `tasks-by-status` | tasks by status as a bar chart | bar |
| `activity-share` | share of activities by type | donut, bar |
| `people-this-month` | people added this month vs last | kpi |
| `people-trend` | new people over time, by month | line, bar |
| `top-organisations` | top 5 organisations by current people | leaderboard, table, bar |
| `task-funnel` | a pipeline-like funnel of tasks | funnel, bar |
| `activities-by-month-and-type` | activities per month, split by type | line, bar |
| `overdue-tasks` | how many open tasks are overdue | kpi |
| `organisations-by-industry` | organisations by industry, horizontal bars | bar |
| `tasks-due-soon` | table of the 10 open tasks due soonest | table |

## Running it

`@relationship-os/core` (for `describePrompt`, `extractJson` and the Overview's filters) uses TypeScript
syntax that Node's default type stripping refuses. So the eval runs with
`--experimental-transform-types`, and the package scripts pass that flag (Node ≥ 24).

1. Start and seed the app, as for `evals/mcp`:

   ```sh
   pnpm dev
   pnpm --filter @relationship-os/db seed -- --people 300 --organisations 80 --activities 200 --tasks 60
   ```

2. Check the plumbing without a model. This step needs no credentials. The smoke script signs
   in and checks that `widget.preview` can be called over MCP. It then runs the whole harness in
   both modes with a stand-in model that answers each prompt with its reference widget (in
   `prompts.ts`). Every prompt should pass:

   ```sh
   pnpm --filter @relationship-os/evals-dashboards smoke -- --base-url http://localhost:5173
   # or: node --experimental-transform-types evals/dashboards/smoke.ts [--mode agent|describe|both] [--only id,id]
   ```

3. Set credentials and run. The environment variables are the same as for `evals/mcp`:
   `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (with optional `CF_AI_GATEWAY_ID` and
   `CF_AIG_TOKEN`), or `EVAL_BASE_URL` and `EVAL_API_KEY` for any OpenAI-compatible server. See
   [evals/mcp/README.md](../mcp/README.md#the-model).

   ```sh
   export CLOUDFLARE_ACCOUNT_ID=…  CLOUDFLARE_API_TOKEN=…
   pnpm --filter @relationship-os/evals-dashboards eval -- --base-url http://localhost:5173
   pnpm --filter @relationship-os/evals-dashboards eval -- --mode describe
   # or: node --experimental-transform-types evals/dashboards/runner.ts --base-url …
   ```

   Options:
   - `--mode agent|describe`
   - `--only id,id`: runs only those prompts, and all of them must pass.
   - `--model`: the default is `@cf/moonshotai/kimi-k2.6`. `EVAL_MODEL` also sets it.
   - `--temperature`, `--max-tokens`, `--reasoning-effort`
   - `--max-turns`: model requests per prompt in agent mode. The default is 20.
   - `--email` / `--password`, or `MCP_EVAL_EMAIL` / `MCP_EVAL_PASSWORD`, for the eval user.
     Any member will do.

   Without credentials, the runner exits with code 2 and a clear message, and writes nothing.
   This happens before `@relationship-os/core` loads, so it also works under plain `node`. The runner exits
   0 when the target is met and 1 otherwise. A describe-mode report's file name ends in
   `-describe`.

## Layout

- `prompts.ts`: the 10 prompts, each with its accepted types, its extra expectations and a
  reference widget.
- `runner.ts`: the CLI. `smoke.ts`: the plumbing check without a model.
- `lib/core.ts`: loads the `@relationship-os/core` pieces at runtime, with their types.
- `lib/grading.ts`: picks the final widget from the recorded calls, runs the grader's preview,
  and checks the type, the mapping and the expectations.
- `lib/harness.ts`: runs one prompt in either mode. It also holds the agent's building guide.
- `lib/reference.ts`: the stand-in model that the smoke script and the tests use.
- `lib/report.ts`: the Markdown and JSON report, including a failure analysis by kind.
- `test/`: unit tests in plain Node, with no network. `test/fake-crm.ts` is an in-memory
  `widget.preview`, `dashboard.create` and `dashboard.delete` that follows the operations'
  contract.
