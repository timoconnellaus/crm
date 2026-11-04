# ADR 0031: Policy adjudicator

Status: accepted, 2026-11-04 (stage 7 interview).

## Decision
- An optional per-org reviewer (the `review` role: Jev, or an LLM different from the actor's model) judges items the gate routes to `review` against the org's written policy. That policy is editable by human admins only.
- It returns approve / deny / escalate with confidence and a reason. It can approve only what the gate routed to it, and can never override `deny` or the floor.
- Modes are **off / shadow / active**. It starts in **shadow**, which records verdicts beside human decisions and tracks agreement rates, until an admin activates it.
- Verdicts are hidden from the actor. Every verdict is audited. The bar for auto-approve is precision of at least 0.95 on the eval.
