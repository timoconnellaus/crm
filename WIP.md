# WIP: erase completeness (block L: migrations 0330–0339, ADRs 0320–0329)

Branch `erase-completeness`. Brief: close the erase audit's gaps 1–9 (see PR description).

## Status
- [x] 1 R2 email bodies (drop shared body_ref, blob deletion queue + drain)
- [x] 2 sync: delete suggestions/signatures/job-change; erased-address list (hashes) + ingest check + admin remove op
- [x] 3 extension side tables, relation fields (generic), kv, runs
- [x] 4 automation runs, run records, notifications, delivery detail
- [x] 5 wider terms (former emails/phones from audit; org domains/website/addresses); names in about-them contexts
- [x] 6 integration host journals (runner; vendored: upstream proposal + mitigation)
- [x] 7 AI Gateway payload logging off; Workers Logs log ids not messages
- [x] 8 short-lived store retention documented
- [x] 9 beyond-use statement; erase log outside D1 + re-apply command
- [x] tests: every-store integration, per-store units, org erase, sync re-ingest drop, rows_read budget
- [x] docs: ADR(s), ADR 0019 amendment, architecture, CONTEXT, privacy docs

## Remaining
- full lint/typecheck/test, golden, merge origin/main, PR, CI
