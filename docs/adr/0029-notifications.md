# ADR 0029: Notifications

Status: accepted, 2026-11-04 (stage 5 interview).

## Decision
- An in-app notification centre (bell plus inbox; per user; read/unread; links to records, approvals and runs), fed by a `notification.send` operation used by automations, approvals and the system.
- Notification types are typed, so that stage 6 can route each type to email or Slack through gatekeepers according to user preferences. No external delivery before then (ADR 0007).
