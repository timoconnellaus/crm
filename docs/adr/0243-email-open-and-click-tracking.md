# ADR 0243: Open and click tracking, opt-in and labelled approximate

Status: proposed, 2026-11-05 (stage 13 spec).

## Context

The user decided that open and click tracking is optional per user, off by default, and labelled
approximate, because Apple Mail Privacy Protection and security scanners fetch images and follow
links automatically. Reply detection always works and is what sequences rely on.

Tracking needs routes reachable without sign-in. Today the only general public prefix on ros-app is
`/gatekeeper/*`, and the cost rules forbid a D1 write per request on hot paths.

## Decision

1. **A per-user setting**, `off | opens | opensAndClicks`, default `off`.
2. **Public routes on ros-app**, `/e/o/<token>` (a 1×1 GIF) and `/e/c/<token>` (a 302 redirect),
   plus `/e/u/<token>` (unsubscribe, which sets the person's `emailOptOut` after a confirmation
   page). Tokens are HMAC-SHA256 over the send id, the link index and the target URL, keyed by the
   env-only secret `EMAIL_TRACKING_SECRET`. The redirect target is inside the signed token, so the
   route reads no database and cannot be used as an open redirect.
3. **Hits are queued, not written per request.** The route sends a message to a queue; the consumer
   writes counts and first/last times on `core_email_send` in batches, and one timeline entry for
   the first open and first click of each email.
4. **Likely automated hits are separated:** hits within 60 seconds of sending and from known
   scanner user agents are counted as "likely automated" and not shown as opens.
5. **Everything is labelled approximate** in the UI, the API description and the assistant's tool
   descriptions. Tracking is never a stop condition and never feeds a score.

## Why

- Off by default and labelled approximate is the honest version of a feature mainstream CRMs ship.
- Signed tokens and a queue keep the public routes free of database reads and per-request writes.

## Consequences

- `EMAIL_TRACKING_SECRET` is created at install like other generated secrets; rotating it breaks
  the links in mail already sent.
- Outlook bodies are Markdown, so whether the pixel renders depends on Outlook's Markdown to HTML;
  if it does not, open tracking is unavailable for Outlook.
