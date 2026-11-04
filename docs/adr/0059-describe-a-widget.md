# ADR 0059: "Describe a widget" and the build role in crm-app

Status: accepted, 2026-11-05 (stage 4a build). Applies ADR 0009.

## Decision
- **`widget.describe { prompt, dashboardFilters?, filters? }`** sends the prompt plus a schema
  summary (every `crm_*` view and its columns from the field registry, the allowed named
  params and the widget JSON shape; `describePrompt` in `dashboards/describe.ts`) to the
  **`build` model role**. The answer's first JSON object is parsed into a widget spec, validated
  like a saved widget and previewed. One failure (bad JSON, invalid spec, SQL refused or failing)
  is sent back once with the error. It returns `ok` (widget + preview), `invalid` (message and
  the last widget, for the manual editor) or `unavailable`. Nothing is saved.
- **Minimal role mapping, Workers AI by default.** `ModelRunner` in `packages/core/src/models.ts`
  resolves roles through the existing `modelFor` defaults (build: Llama 3.3 70B on Workers AI) via
  the `AI` binding, through AI Gateway when `AI_GATEWAY_ID` is set. Operations receive it as
  `ctx.models` (new on `InvocationContext` / `HandlerContext`). crm-app gets the binding the same
  optional way crm-runner does; without it the operation answers `unavailable` ("AI is not
  configured") and the manual editor (type, SQL with a schema sidebar, column mapping, options,
  click-through, preview) still works. No third-party or Anthropic key is ever required.
- **A local stand-in.** `AI_FAKE_MODEL=true` (in `.dev.vars`, written by `pnpm dev`; empty in
  `wrangler.jsonc`) answers the build role with a deterministic, keyword-picked widget when there
  is no `AI` binding, so local development and the e2e suite exercise the whole box.
- `widget.describe` is not exposed to MCP: an MCP client is itself a model and writes widgets
  with `widget.preview`. The eval harness (`evals/dashboards/`) runs the same prompts both ways.

## Consequences
- The stage-7 registry replaces `modelRunnerFromEnv` with per-role providers and admin overrides;
  callers keep asking for the `build` role.
