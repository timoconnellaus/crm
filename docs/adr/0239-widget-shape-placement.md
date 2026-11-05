# ADR 0239: `widget.shape`: the shape is picked from the prompt before generation, and checked by code

Status: accepted, 2026-11-05 (stage 11 build step 9). Builds on [ADR 0230](0230-jev-as-the-typed-judge.md),
[ADR 0231](0231-judge-calibration-and-replay.md) and [ADR 0059](0059-describe-a-widget.md). The
placement guide is [`docs/jev.md`](../jev.md), placement 6.

## Context
`widget.describe` asks the `build` role for a widget and sends one failure back. The dashboards
eval's `people-this-month` ("The number of people added this month, compared with last month.")
failed with a bar chart of two months where a KPI was expected: a kpi widget already shows the
previous period. Validation cannot catch that: the bar chart is a valid widget. The user decided
on 5 November 2026: Jev picks the expected shape from the prompt before generation, from known
widget types with a way out; code compares it with the widget's type, and a mismatch goes back
through the existing retry; advice fails open.

## Decision
- **Question,** asked once per describe, before the model, about `{ prompt }` only (the person's
  words, at most 2,000 characters): one Choice over shapes, each the widget types that show it:
  `kpi` (one number, alone or against an earlier period), `categories` (bar, donut, funnel,
  leaderboard), `trend` (a line, or a bar per period), `rows` (a table of records), `text`
  (markdown), and `unclear`.
- **A confident pick** is the top shape at P ≥ 0.4, never `unclear`. It is added to the model's
  prompt as a hint ("The request asks for one number (a kpi widget; …)").
- **The check is code** (`typeFits`, `SHAPE_TYPES`): kpi → `kpi`; categories → bar, donut, funnel,
  leaderboard, table; trend → line, bar, table; rows → table, leaderboard; text → markdown. Only a
  type that cannot show the shape is a mismatch. A valid first widget that does not fit goes back
  once as "That widget failed: the request asks for one number (a kpi widget …), but the widget is
  a bar widget". The second answer stands whatever its type; if the second is invalid, the first
  (valid) widget is returned. Nothing is stored: `widget.describe` saves nothing.
- **Fail mode:** open. No pick (off, unclear, below the threshold, any non-answer) changes nothing:
  no hint, no check, the widget is described exactly as before.
- **Defaults:** the placement sends only the person's prompt, so it is on when the judge has a key
  (ADR 0232).
- **Calibration (5 November 2026, jev-1.14.0, three runs a case):** 30 prompts
  (`evals/judge/sets/widget-shape.ts`): all ten dashboards eval prompts verbatim, including
  `people-this-month` (P(kpi) 0.98), at least four per shape, four too vague to tell, and a
  comparison with a named chart type left open. One record per shape. None wrong, none close at
  0.4: the closest is `activities-by-month-and-type` (P(trend) 0.62; months split by type is also
  a fair comparison across categories); the highest wrong-shape median is 0.24.

## Consequences
- A describe costs one judge call (about 500 tokens) and up to 3 s before the model starts, and at
  most one extra model call on a mismatch.
- The dashboards eval's describe mode does not ask the judge; it measures the model alone.
