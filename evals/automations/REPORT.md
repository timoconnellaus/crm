# Automations eval: report

**Status: not run.** There is no result to report yet.

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
