# apps/marketing

The landing page for [relationshiposcrm.com](https://relationshiposcrm.com) (ADR 0191): a static
Astro site served by the `ros-marketing` Worker, which also answers `POST /api/signup` (the
waitlist and contact-sales form) and stores submissions in its own D1 database. No trackers: the
build fails if any page loads anything from another origin or mentions a known analytics tool
(`scripts/check-static.mjs`).

This is the Stage 9 scaffold. The real design, copy and sections come in a follow-up.

```sh
pnpm --filter @relationship-os/marketing dev      # http://localhost:4321 (pages only, no form API)
pnpm --filter @relationship-os/marketing build    # dist/, then the no-tracker check
pnpm --filter @relationship-os/marketing test     # the form endpoint in workerd against local D1
pnpm --filter @relationship-os/marketing preview  # build + wrangler dev: pages and the form
```

Deploys go through `.github/workflows/marketing.yml` on pushes to `main`, once the
`MARKETING_CLOUDFLARE_API_TOKEN` and `MARKETING_CLOUDFLARE_ACCOUNT_ID` secrets exist. Read
submissions with `wrangler d1 execute ros-marketing --remote --command "SELECT * FROM marketing_signup"`.
