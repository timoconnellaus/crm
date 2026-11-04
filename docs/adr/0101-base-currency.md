# ADR 0101: The base currency setting

Status: accepted, 2026-11-05 (stage 4b build). Implements ADR 0026's "one base currency".

## Decision
- The deployment's base currency is the org setting `base_currency` (ISO 4217, `USD` by default,
  migration 0100), read with `settings.get` (`records:read`) and changed with `settings.update`
  (new permission `settings:manage`, admins) in Settings → General. Changes are audited.
- A currency field may still name its own `currency`; one without it (Deals' `value`) displays in
  the base currency. The field registry no longer fills in `USD` for such fields.
- Changing the base currency relabels amounts; it never converts them. Multi-currency and FX stay
  out of scope.

## Why
A deal's value must read in the org's currency without every extension hard-coding one, and a
setting is something a person (or an admin's AI client) can change in one place.
