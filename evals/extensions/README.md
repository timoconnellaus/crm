# Extensions authoring eval

Stage 3 acceptance criterion 9 ([docs/stages/03-extensions.md](../../docs/stages/03-extensions.md)):
an MCP client model, connected to a running deployment over MCP, writes a CRM extension for each
of 10 natural-language prompts. Each must end with the model's extension passing `check` and
proposed for approval. The target is at least 8 of 10. The report's failure analysis, especially
the check issues the model hit on the way, feeds improvements to the SDK docs
([packages/sdk/README.md](../../packages/sdk/README.md)) and the server's instructions.

**No report has been committed yet.** The harness is unit-tested against a scripted model and a
fake extension workspace. The first real run, with Workers AI credentials against a deployment
that has the `extension_*` MCP tools, should commit its report to `reports/`.

## What it measures

For each prompt the runner:

1. picks the extension id: the prompt's `idBase` plus the run's generated word
   (`renewal` + `varodin` → `renewalvarodin`), so runs never collide in the extension workspace.
   The prompt tells the model to use that id;
2. opens a fresh MCP connection for the model (a new OAuth client, scopes `read write admin`) and
   runs the tool-use loop with the server's instructions as the system message, until the model
   replies without tool calls or hits `--max-turns`;
3. grades the run. A prompt **passes** when all of these hold:
   - an `extension_propose` (curated, or `call_operation` with `extension.propose`) came back
     `status: "pending_approval"`. A `check_failed` answer does not count;
   - `extension_check { id }` on the extension's working copy, called by the grader on its own
     connection after the run, is `ok`;
   - the manifest from that check has what the prompt asked for (`expect` in `prompts.ts`, such
     as "organisation has a `date` field whose name or label mentions renewal").

The report records, per prompt, the turns, tool calls, `extension_write` / `check` / `propose`
counts, the proposal (action, change set, commit), and every check issue the model saw along the
way (from its own `extension_check` calls and from `check_failed` proposals), with stage, code,
path and message. The summary tallies failures by kind (never proposed, working copy fails check,
expectation unmet, harness error) and the check issues by `stage/code` across all prompts.

Proposals are left pending in the Approvals inbox; the eval does not approve or reject them.

| Prompt | Asks for | Expectations |
| --- | --- | --- |
| `renewal-date` | a renewal date on organisations | organisation `date` mentioning renewal |
| `projects` | a Projects object linked to organisations, with status, budget, spent and remaining-budget formula | object with `relation` to `organisation`, a `select`, a `currency` and a `formula` using it |
| `days-until-renewal` | a contract renewal date and a days-until-renewal formula | `date` + `formula` that uses it and `today()` |
| `task-priority` | priority on tasks: low, medium, high, urgent | task `select` mentioning priority, with those options |
| `lead-source` | lead source on people with five options | person `select` mentioning source, with those options |
| `vendors` | a Vendors object: name, website, email, phone, contract end | object with a text title field, `url`, `email`, `phone`, `date` |
| `interests` | interests on people, several allowed | person `multiSelect` mentioning interests, with the four options |
| `ticket-tool` | a Tickets object and a read-only tool counting open tickets per organisation | object with status `select` (open, closed) and `relation` to organisation; a counting tool with risk `read` and an organisation input; the `crm` module |
| `linkedin-url` | a LinkedIn URL on people | person `url` mentioning LinkedIn |
| `discount` | annual contract value, discount percent, discounted-value formula on organisations | `currency`, `percent`, and a `formula` using both |

Option and name matching is loose (case, spaces, `camelCase` or `snake_case`); the predicates
only check what the user actually asked for.

## Running it against `pnpm dev`

1. Start the app (`pnpm dev`, http://localhost:5173). The deployment must have the stage 3
   extension MCP tools (`extension_list`, `extension_read`, `extension_write`, `extension_check`,
   `extension_propose`).
2. The eval user must be an **admin**: authoring needs the `extensions:manage` permission, which
   MCP grants only with the `admin` scope to an admin. On a fresh database the first user to sign
   up is the admin, so either run this (or the MCP eval, which uses the same default user) first,
   or pass an admin's credentials. The runner checks this before calling the model and stops with
   a clear message if the tools are missing.
3. Set model credentials (see below) and run:

   ```sh
   export CLOUDFLARE_ACCOUNT_ID=…  CLOUDFLARE_API_TOKEN=…
   node evals/extensions/runner.ts --base-url http://localhost:5173
   # or: pnpm --filter @relationship-os/evals-extensions eval -- --base-url http://localhost:5173
   ```

   Options: `--only id,id` (all of them must pass), `--model`, `--temperature`, `--max-tokens`,
   `--reasoning-effort`, `--max-turns` (model requests per prompt, default 30), `--email` /
   `--password`. Without credentials it exits 2 and writes nothing. It exits 0 when the target is
   met, 1 otherwise. Reports go to `reports/<timestamp>.md` and `.json`.

`node evals/extensions/smoke.ts --base-url …` checks the plumbing without a model: OAuth with the
admin scope, the `extension_*` tools, and each prompt's reference answer (`reference/<idBase>.ts`)
written to the workspace, checked by the server and graded by the prompt's expectations. Add
`--propose` to also propose them (they then wait in the Approvals inbox) and confirm the harness
recognises the proposal. `--only` works here too.

## Environment

| Variable | Use |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | Workers AI (the default endpoint); the token needs the Workers AI permission |
| `CF_AI_GATEWAY_ID`, `CF_AIG_TOKEN` | optional: route through AI Gateway's OpenAI-compatible endpoint (`CF_AIG_TOKEN` for an authenticated gateway) |
| `EVAL_BASE_URL`, `EVAL_API_KEY` | optional: any other OpenAI-compatible chat-completions server instead |
| `EVAL_MODEL` | model id when `--model` is not given (default `@cf/moonshotai/kimi-k2.6`) |
| `EVAL_ADMIN_EMAIL`, `EVAL_ADMIN_PASSWORD` | the admin eval user; fall back to `MCP_EVAL_EMAIL` / `MCP_EVAL_PASSWORD`, then `mcp-eval@example.com` |

The model client, provider selection and the default model are shared with the MCP eval; see
[evals/mcp/README.md](../mcp/README.md#the-model).

## Layout

- `prompts.ts`: the 10 prompts, their id bases and their `expect` predicates.
- `reference/`: a known-good extension per prompt. The unit tests run each through the SDK's
  `createTestHost` (no issues) and the prompt's predicates (no failures); `smoke.ts` writes them
  to a real deployment.
- `runner.ts`, `smoke.ts`: the CLI and the plumbing check.
- `lib/harness.ts`: running and grading one prompt; `lib/manifest.ts`: manifest helpers for the
  predicates; `lib/report.ts`: the report; `lib/reference.ts`: reference sources.
- `test/`: unit tests (plain Node, no network): the prompts file, the predicates on sample
  manifests, the harness flow against a scripted model and a fake workspace, the CLI and report.

Sign-in, OAuth, the MCP session, the OpenAI-compatible model client, tool conversion and the
tool-use loop come from `@relationship-os/evals-mcp/lib/*`.
