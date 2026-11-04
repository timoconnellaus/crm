# ADR 0001: Self-hosted, one org per deployment

Status: accepted, 2026-11-04 (stage 0 architecture interview).

## Context
The CRM is meant to be owned by the organisations that use it, running in their own Cloudflare account.
We will run our own instance, deployed exactly like anyone else's. There is no hosted multi-tenant offering.

## Decision
- One deployment serves one org. The deployment is the isolation boundary, so there is no tenant id in the data model.
- Deployments require the Workers Paid plan (dynamic workers, Workflows, Queues, CPU limits).
- The repo must stay deployable by strangers: self-contained `wrangler.jsonc` files, documented secrets, no reliance on our accounts.

## Consequences
- Simpler data layer and auth. Adding multi-tenancy later would be a significant change, accepted knowingly.
- Every external dependency (AI keys, OAuth apps) is supplied per deployment.
