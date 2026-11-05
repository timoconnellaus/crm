# Automations eval: report

## Real runs (2026-11-05)

Model under test: DeepSeek `deepseek-flash` (V4.1 Flash) on api.deepseek.com, thinking at the
server default (on). A person (the dev admin) approved every proposal during each run.

| Run | Score | Summary judge | Changed before it |
| --- | --- | --- | --- |
| 05:58, the author's machine (report not committed) | 1/10 | `deepseek-flash` (self) | – |
| [07:05](reports/2026-11-05T07-05-40-793Z.md) | 4/10 | `deepseek-flash` (self) | network errors explained and retried; authoring guidance |
| [07:14](reports/2026-11-05T07-14-45-066Z.md) | 6/10 | `deepseek-flash` (self) | host summary states links; three phrasings fixed |
| [07:20](reports/2026-11-05T07-20-38-083Z.md) | **7/10** | `deepseek-v4-pro` (independent) | judge only |

**The 1/10 run.** Five cases failed with `fetch failed`. It was not a timeout: the machine went to
clamshell sleep on battery at 06:05:21Z (`pmset -g log`) and had only brief dark wakes until the
lid opened at 06:47:42Z. Every request to api.deepseek.com in those wakes failed for want of a
network (authoring `rejected-change` and `new-deal-kickoff`, then the judge for the first three
graded cases), while calls to the local dev server still worked. DeepSeek sends response headers
within about 300 ms even when the answer takes minutes, so undici's 300 s headers timeout could not
fire. Failures now name their cause and say when the machine slept (README.md). The other four
failures were the model adding what nobody asked for (an "only open deals" condition, owner
assignments, the owner's manager instead of the admins) and host summaries that never said a task
was linked to its record.

**Still failing (07:20 run).**

- `rejected-change`: test mode runs an `approvalDecided` automation with no approval in the event;
  the model's code returns when `event.approval` is missing, so test mode shows no notification.
  The summary says "a pending change" where the keyword check wants "approv".
- `lost-deal-admins`, `weekly-digest`: the judge wants the notification's content ("with the
  deal's name", "to review the pipeline"), which the host summary never states. The same
  `lost-deal-admins` summary passed in the 07:05 run: the judge is not fully consistent.

`new-deal-kickoff` passed with the independent judge and failed with the self-judge, which wanted
the task titles in the summary (the diagram shows them; the summary does not).

## Before the first run

The stage 5 build environment had no Cloudflare credentials (no `CLOUDFLARE_ACCOUNT_ID` or
`CLOUDFLARE_API_TOKEN`), no other model endpoint, and no deployment to run against. No model has
attempted the 10 cases and no pass rate is claimed. The target is **at least 8 of 10** (stage 5,
acceptance criterion 9).

Verified: the harness and graders are unit-tested (`pnpm --filter @relationship-os/evals-automations test`)
against a stand-in model and an in-memory deployment. The tests cover the three phases, every
failure kind (never proposed, check fails, not approved, wrong trigger, wrong test-mode output,
summary keywords, judge rejection), the judge's parsing and retry, the CLI and the report writer.
Each case's reference answer declares exactly the writes, notifications and waits its case expects,
and passes the SDK contract check (`validateManifest`, including the automation checks).

Not yet verified: the reference answers passing `extension_check` on a deployment (smoke.ts),
real model performance, and how well the judge agrees with a person.

## How to produce the real report

    pnpm dev    # with Deals installed, approval policy Balanced
    node evals/automations/smoke.ts --base-url http://localhost:5173
    export CLOUDFLARE_ACCOUNT_ID=…  CLOUDFLARE_API_TOKEN=…
    node evals/automations/runner.ts --base-url http://localhost:5173
    # approve the printed proposals at /approvals while the runner waits

Then commit `reports/<timestamp>.md` and `.json`, and replace this status with the result.
