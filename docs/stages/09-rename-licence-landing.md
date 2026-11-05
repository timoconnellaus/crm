# Stage 9: Rename, licence and landing page

Read: ADR [0190](../adr/0190-rename-and-fsl-licence.md), ADR [0191](../adr/0191-saas-and-enterprise-model.md), `AGENTS.md`, `UPSTREAMS.md`.

Run this stage **after the in-flight PRs merge**: Stage 6b (#35) and the AI Gateway provisioning follow-up. That way the repo-wide rename doesn't collide with them.

## Scope
1. **Rename everything.**
   - Display name **Relationship OS** in the UI, emails, the MCP server name and instructions, and the setup wizard.
   - Package scope `@crm/*` becomes `@relationship-os/*`.
   - Worker names `crm-app`, `crm-runner` and `crm-gatekeeper-*` become `ros-app`, `ros-runner` and `ros-gatekeeper-*`. Also rename the queues, the Vectorize index (`ros-records`), D1 names, the release manifest and the golden file, `deploy-inputs`, and the CLI (`create-relationship-os` / the `ros` binary).
   - Update docs, the README and `CONTEXT.md`. The vendored packages' upstream names stay as they are, recorded in `UPSTREAMS.md`.
   - The user renames the GitHub repo (or Claude does it with `gh repo rename`). Update all repo URLs, the release workflow, attestation checks and the self-updater's GitHub source.
2. **Relicense.**
   - Add the `LICENSE` file with the **FSL-1.1-ALv2** text from fsl.software, naming the licensor and copyright holder.
   - Add a `NOTICE` that records the relicensing commit and says earlier code is Apache-2.0, and that keeps the vendored Apache NOTICEs.
   - Add license fields to `package.json` files, and a README licence section explaining what's allowed in plain English.
   - Add a **CLA**: `CLA.md` plus a GitHub Action bot (e.g. `contributor-assistant/github-action`) that requires a signature on PRs, and a `CONTRIBUTING.md`.
3. **Landing page** (`apps/marketing`).
   - A static site (Astro, or TanStack Start static), deployed to Workers on `relationshiposcrm.com`, using the shared brand tokens.
   - Sections: hero (AI-native CRM on your own Cloudflare), features (MCP and Claude, extensions written by AI, automations, approvals, integrations), self-host vs Cloud vs Enterprise, licence explained, docs and GitHub links, and a waitlist / "contact sales" form. The form stores submissions in D1 or sends email via the email gatekeeper, with **no third-party trackers**.
   - Screenshots come from e2e runs.
   - Gets its own CI deploy job, gated on a token secret.

## Acceptance criteria
1. No `@crm/` or `crm-app` references remain outside `UPSTREAMS.md` / history notes. Lint, typecheck, test, build and e2e pass in CI.
2. The release build and golden file use `ros-*` names. The CLI is `create-relationship-os`.
3. `LICENSE` is FSL-1.1-ALv2, and `NOTICE` and the README licence section are present. The CLA bot runs on PRs.
4. The landing page builds and deploys to `relationshiposcrm.com`, scores Lighthouse ≥ 95, has no trackers, and the form works.
