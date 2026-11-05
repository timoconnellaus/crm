# Automations eval

Stage 5 acceptance criterion 9 ([docs/stages/05-automations.md](../../docs/stages/05-automations.md)):
an MCP client model, connected to a running deployment over MCP, turns 10 "automate this…"
prompts into extensions with an automation. Each must pass `check`, its test-mode output must be
correct, and its host summary must state the intent, judged by a rubric. The target is at least
8 of 10.

The eval reuses `evals/mcp`'s client: sign-in, the OAuth flow, the MCP session, the
OpenAI-compatible model client, tool conversion and the tool-use loop. It uses Workers AI by
default, or any OpenAI-compatible endpoint. Per ADR 0009 it never uses Claude or Anthropic. The
summary judge is the model under test unless `--judge-model` (or `EVAL_JUDGE_MODEL`) names
another; the report says which, since a model judging its own work is not independent.

See [REPORT.md](REPORT.md) for the latest real runs. The harness and graders are unit-tested with
a stand-in model and an in-memory deployment (`test/`).

## How a run goes

Installing an extension is human-only (ADR 0041): an approver must accept each proposal in the
Approvals inbox. So the runner works in three phases, and one person approves everything in one
sitting:

1. **Seed.** The grader creates each case's test record (a deal owned by the eval user in a won,
   lost or open stage, a person, an organisation). This happens before any automation exists, so
   the eval's own automations never fire on them. Deals go in the New business pipeline (else the
   first pipeline) and its first stage of the case's type. Any field that stage requires (its
   stage rules) and the case left empty is filled in: an organisation (`Eval Deals Ltd <word>`,
   one per run), a value, an expected close and so on. So the fixtures work on a fresh database
   and on one seeded with `pnpm db:seed`.
2. **Author.** For each case the model gets a fresh MCP connection (scopes `read write admin`),
   with the server's instructions as its system prompt. It writes the extension with
   `extension_write`, runs `extension_check` and calls `extension_propose`. The prompt names the
   extension id: the case's `idBase` plus the run's word, so runs never collide.
3. **Approve, then grade.** The runner prints the proposals and pauses (`--approval-minutes`,
   default 30). **A person must be at the app during this wait**, signed in as an approver (an
   admin), approving each proposal at `/approvals`. There is no auto-approve: installing an
   extension is human-only by design (ADR 0041). A proposal still unapproved when the wait ends
   fails its case as `install`. So start a run only when someone can watch it. Then, per case, the
   grader:
   1. runs `extension_check` on the working copy: it must be `ok`;
   2. finds the installed automation (`automation.list { extensionId }`). Its trigger type, from
      `automation.get`, must be one that implements the request;
   3. runs `automation.test` on the seeded record (nothing is written). The report must show the
      trigger matched, exactly the expected writes by object, the expected number of
      notifications reaching the eval user (as the deal's owner, or as an admin), and the expected
      number of waits (sleep or waitForEvent steps, skipped in test mode);
   4. reads the host summary (`automation.get` → `summary.text`, generated from the declarations
      without AI). Every keyword group of the case must match it, and the judge must pass it by
      the rubric in `lib/grading.ts`: right trigger, right actions and recipients, timing stated,
      nothing important added;
   5. disables the automation, so nothing keeps running.

The grader calls operations as their curated MCP tool when the server lists one (e.g.
`person_create`), and otherwise through `call_operation` (`automation.*`, `record.*`,
`user.list`).

| Case | Trigger | Test record | Expected test mode |
| --- | --- | --- | --- |
| `won-thank-you` | fieldChanged stage → won | won deal | task ×1, notify owner, no wait |
| `lost-deal-admins` | fieldChanged stage → lost | lost deal | notify admins |
| `new-person-welcome` | record created (person) | person | task ×1 |
| `org-check-in` | record created (organisation) | organisation | task ×1, 1 wait |
| `close-date-reminder` | dateRelative expectedClose −7 | open deal closing in 7 days | notify owner |
| `big-deal-alert` | record created + condition value > 50,000 | deal worth 100,000 | notify admins |
| `weekly-digest` | schedule (Monday 9:00) | none | notify admins |
| `manual-renewal-task` | manual button on organisations | organisation | task ×1 |
| `rejected-change` | approvalDecided rejected | none | notify admins |
| `new-deal-kickoff` | record created (deal) | open deal | task ×2, 1 wait, notify owner |

## Running it

1. Start and seed the app (`pnpm dev`, http://localhost:5173) with the Deals extension installed
   and the approval policy on Balanced (the grader's single creates must apply immediately).
2. The eval user must be an **admin** (authoring needs `extensions:manage`). On a fresh database
   the first user to sign up is the admin.
3. Check the plumbing without a model. `smoke.ts` signs in, checks the `extension_*` tools and
   `automation.list`, and writes and checks each case's reference answer (`lib/reference.ts`).
   `--propose` also proposes them:

   ```sh
   node evals/automations/smoke.ts --base-url http://localhost:5173 [--only weekly-digest] [--propose]
   ```

4. Set credentials and run:

   ```sh
   export CLOUDFLARE_ACCOUNT_ID=…  CLOUDFLARE_API_TOKEN=…
   pnpm --filter @relationship-os/evals-automations eval -- --base-url http://localhost:5173
   # or: node evals/automations/runner.ts --base-url …
   ```

   Options: `--only id,id` (all of them must pass), `--approval-minutes`, `--model` (default
   `@cf/moonshotai/kimi-k2.6`, or `EVAL_MODEL`), `--temperature`, `--max-tokens`,
   `--reasoning-effort`, `--thinking on|off` (or `EVAL_THINKING`: DeepSeek's thinking switch,
   sent only when set), `--judge-model` (or `EVAL_JUDGE_MODEL`), `--max-turns` (model requests
   per case, default 30), `--email` /
   `--password` (or `EVAL_ADMIN_EMAIL` / `EVAL_ADMIN_PASSWORD`). Without credentials it exits 2
   and writes nothing. It exits 0 when the target is met, 1 otherwise. Reports go to
   `reports/<timestamp>.md` and `.json`. Commit the first real run's report and update
   `REPORT.md`.

The environment variables are those of `evals/mcp`; see
[evals/mcp/README.md](../mcp/README.md#the-model).

**Keep the machine awake for the whole run** (plugged in, lid open; `caffeinate -ims` stops idle
sleep but not a closed lid on battery). A run takes 30 to 60 minutes, mostly waiting for the
model and for approvals. A laptop that sleeps has no network: every model or judge request made
in its brief dark wakes fails, and the case fails as `error`. The 2026-11-05 05:58 run lost 5
cases this way (see REPORT.md). Failures now name the underlying cause (DNS, refused connection,
timeout) and say when the machine slept during the failed work.

## Layout

- `prompts.ts`: the 10 cases: request, intent, accepted trigger types, test record, expected
  test-mode output and summary keywords.
- `runner.ts`: the CLI. `smoke.ts`: the plumbing check without a model.
- `lib/harness.ts`: the three phases (seed, author, grade) and waiting for approvals.
- `lib/crm.ts`: the grader's operation calls and seeding.
- `lib/grading.ts`: the test-report grader, the keyword check and the LLM judge.
- `lib/reference.ts`: a known-good extension per case, and a stand-in model that writes them.
- `lib/report.ts`: the Markdown and JSON report with a failure analysis by gate.
- `test/`: unit tests in plain Node, with no network. `test/fake-crm.ts` is an in-memory
  deployment following the tools' and operations' contracts.
