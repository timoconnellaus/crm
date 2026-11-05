# ADR 0031: Policy adjudicator

Status: accepted, 2026-11-04 (stage 7 interview).

## Decision
- An optional per-org reviewer (the `review` role: Jev, or an LLM different from the actor's model) judges items the gate routes to `review` against the org's written policy. That policy is editable by human admins only.
- It returns approve / deny / escalate with confidence and a reason. It can approve only what the gate routed to it, and can never override `deny` or the floor.
- Modes are **off / shadow / active**. It starts in **shadow**, which records verdicts beside human decisions and tracks agreement rates, until an admin activates it.
- Verdicts are hidden from the actor. Every verdict is audited. The bar for auto-approve is precision of at least 0.95 on the eval.

## Amendment (2026-11-05, stage 7b, ADR 0204, ADR 0205)
Built as specified, with these decisions:
- **Deny escalates** (with its reason shown to approvers); it never rejects automatically.
- The verdict is asked for in **JSON mode** and validated with zod (one repair round); an invalid,
  empty or cut-off reply escalates with confidence 0. This lets `review` run on models with JSON
  mode but no JSON schema (DeepSeek).
- **Independence** is a warning, not a block: the settings page warns when `review` resolves to the
  same provider and model as `assistant`.
- The written policy is versioned and hashed; every verdict records the version it used.
- Verdicts are visible to people who may approve, and never returned to the assistant, MCP clients,
  automations or extensions (`approval.*`, `audit.list`).
- The eval (ADR 0205) runs core's own judgement over 30 labelled cases; it has not yet run against
  a real model.
