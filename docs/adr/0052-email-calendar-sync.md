# ADR 0052: Email and calendar sync and disclosure

Status: accepted, 2026-11-04 (stage 6 interview). Context: `docs/research/gatekeeper-interface.md`.

## Decision
- A built-in, hook-driven sync service with periodic catch-up. It matches people by email address and organisations by domain, creates threaded email and meeting activities, and removes duplicates across mailboxes. Deletes and updates propagate.
- **Writing into the shared CRM is the point of disclosure.** Each connection's owner chooses a sharing level: full / metadata only / don't sync. Items can be marked private afterwards. Reads the gatekeeper flags `containsRestrictedData` are never written to CRM data.
- Unknown senders go to a **suggested contacts** inbox (emailed at least twice, grouped by domain). Nothing is auto-created.
- Notifications get per-user, per-type delivery (in-app / email / Slack DM), escalation of unread approvals, a daily digest by email, and admin-configured Slack channel notifications.

> Amended 2026-11-04: ZoomInfo has no change feed, so job changes are detected from email signals (bounces, new signature or domain) and suggested for confirmation. ZoomInfo enrichment is a manual, approved "Enrich now" action. There is no scheduled polling.

> Amended 2026-11-05 (stage 6a build): implemented as recorded in ADRs 0110 (one integration host per connection), 0111 (outbound actions, observations, simulation per facet), 0112 (sync service), 0113 (webhooks and integration events) and 0114 (own gatekeepers, native pickers, `codemode:<gatekeeper>`). Automation run-as and notification delivery follow in stage 6b, after stage 5.
