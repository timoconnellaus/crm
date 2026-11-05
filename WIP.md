# WIP: erase completeness (block L: migrations 0330–0339, ADRs 0320–0329)

Branch `erase-completeness`. Brief: close the erase audit's gaps 1–9 (see PR description).

## Status
- [ ] 1 R2 email bodies (drop shared body_ref, blob deletion queue + drain)
- [ ] 2 sync: delete suggestions/signatures/job-change; erased-address list (hashes) + ingest check + admin remove op
- [ ] 3 extension side tables, relation fields (generic), kv, runs
- [ ] 4 automation runs, run records, notifications, delivery detail
- [ ] 5 wider terms (former emails/phones from audit; org domains/website/addresses); names in about-them contexts
- [ ] 6 integration host journals (runner; vendored: upstream proposal + mitigation)
- [ ] 7 AI Gateway payload logging off; Workers Logs log ids not messages
- [ ] 8 short-lived store retention documented
- [ ] 9 beyond-use statement; erase log outside D1 + re-apply command
- [ ] tests: every-store integration, per-store units, org erase, sync re-ingest drop, rows_read budget
- [ ] docs: ADR(s), ADR 0019 amendment, architecture, CONTEXT, privacy docs
