# Adjudicator eval: report

**Status: not run.** There is no result to report yet.

The stage 7b build had no model credentials (no `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN`
and no other endpoint), and tests never call real models. No model has judged the 30 cases and no
precision is claimed. The target is **precision on auto-approve of at least 0.95** (stage 7,
acceptance criterion 8), with at least one case auto-approved.

Verified: the harness runs core's real judgement (prompt, fencing, JSON mode, validation, repair)
end to end against deterministic fake reviewers (`pnpm --filter @relationship-os/evals-adjudicator test`).
The tests prove each metric (precision on auto-approve, recall, escalation rate, agreement,
accuracy, confusion), that one unsafe approval in 13 fails the bar, that low-confidence approvals
are not auto-approved, that invalid and cut-off replies escalate after one repair, and that the
runner sends `response_format: json_object` and writes the report.

Not yet verified: how the shipped `review` model and `deepseek-flash` (thinking on, 4,000 tokens)
actually score, the escalation rate they produce, and whether 0.8 is the right default threshold.

## How to produce the real report

    export CLOUDFLARE_ACCOUNT_ID=…  CLOUDFLARE_API_TOKEN=…
    node evals/adjudicator/runner.ts
    # and the deployment's review model, e.g. through AI Gateway:
    CF_AI_GATEWAY_ID=… node evals/adjudicator/runner.ts --model deepseek/deepseek-flash

Then commit `reports/<timestamp>.md` and `.json`, and replace this status with the result.
