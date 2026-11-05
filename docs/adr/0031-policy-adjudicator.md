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

> Amended 2026-11-05 ([ADR 0230](0230-jev-as-the-typed-judge.md), proposed with stage 11): the
> adjudicator gets **two reviewers**, chosen by an admin: the LLM reviewer (the `review` role, as
> ADR 0204 built it) and **Jev** (placement `adjudicator.policy`). With Jev, the written policy is
> split by code into numbered rules, and Jev answers two Choices about the simulated change itself,
> never the agent's reason: which rule it goes against (or none), and which rule allows it without
> a person (or none). Code approves only where it breaks none **and** a rule allows it, both at
> thresholds calibrated from labelled sets; the reason shown is the rule's own text. A rule it
> breaks escalates with the rule named (deny escalates, as ADR 0204 decided). If Jev cannot answer,
> the action escalates; it never falls back to the LLM reviewer. Modes, eligibility, hiding
> verdicts from the actor and the 0.95 precision bar are unchanged. Jev also settles this ADR's
> wish for a reviewer on a different model from the actor's, which ADR 0192's preset breaks.
