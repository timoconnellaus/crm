# ADR 0190: Rename to Relationship OS and relicense under FSL-1.1-ALv2

Status: accepted, 2026-11-05 (rename & commercial-model interview).

## Decision
- **Name.** The product is now **Relationship OS** (`relationship-os`), with the domain **relationshiposcrm.com**.
- **Repo.** `timoconnellaus/crm` is renamed in place to `timoconnellaus/relationship-os`. History, PRs and issues are kept, and GitHub redirects the old URL.
- **Rename scope.** Everything is renamed: package scope `@relationship-os/*`, Worker names `ros-app`, `ros-runner`, `ros-gatekeeper-*`, CLI `create-relationship-os`, docs and README. No installs exist yet, so nothing needs migrating.
- **Licence.**
  - Our own code moves from Apache-2.0 to **FSL-1.1-ALv2** (Functional Source License), starting at a dated relicensing commit. Anyone may use, modify and self-host it, including in production for their own organisation. Nobody may offer it as a competing commercial product or service.
  - Each release converts to **Apache-2.0 two years** after it's published.
  - **Code published before the relicensing commit remains available under Apache-2.0.** A grant already made can't be withdrawn. `NOTICE` records the commit.
  - **Vendored third-party code** (Cloudflare OS gatekeepers etc.) keeps its own licence, Apache-2.0, along with its NOTICE files.
- **Contributions** need a CLA, checked by a bot on every PR, so contributions can be offered under commercial and enterprise terms.

## Why
The aim is to let anyone use Relationship OS for free while keeping the right to sell it as SaaS and as a hosted enterprise product. FSL is the "fair source" licence built for exactly this, and Sentry and Codecov use it. The delayed Apache conversion keeps the community's trust.

## Notes
This is not legal advice. Have the licence text, the CLA and the commercial terms reviewed by a lawyer before selling.
