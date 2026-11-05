# apps/marketing

The landing page for [relationshiposcrm.com](https://relationshiposcrm.com) (ADR 0191): a static
Astro site served by the `ros-marketing` Worker, which also answers `POST /api/signup` (the
waitlist and contact-sales form) and stores submissions in its own D1 database. No trackers: the
build fails if any page loads anything from another origin or mentions a known analytics tool
(`scripts/check-static.mjs`).

```sh
pnpm --filter @relationship-os/marketing dev          # http://localhost:4321 (pages only, no form API)
pnpm --filter @relationship-os/marketing build        # dist/, then the no-tracker check
pnpm --filter @relationship-os/marketing test         # the form endpoint in workerd against local D1
pnpm --filter @relationship-os/marketing preview      # build + local D1 migrations + wrangler dev
pnpm --filter @relationship-os/marketing test:e2e     # Playwright against the built site and Worker
pnpm --filter @relationship-os/marketing screenshots  # screenshots/{390,834,1280}-{light,dark}.jpg
pnpm --filter @relationship-os/marketing og-image     # re-render public/og.png and the touch icon
```

## Layout

- `src/pages/index.astro` is the landing page; each section is a component in `src/components`
  (`Hero` with the `Demo`, `HowItWorks`, `WorksWithAI`, `Features`, `Safety`, `SelfHost`,
  `Pricing`, `Enterprise`, `Faq`, `FinalCta`). `Page.astro` is the shell (metadata, fonts, the icon
  sprite, header, footer).
- `src/styles/base.css` holds the design tokens (light and dark) and shared pieces;
  `landing.css` the sections. The app demo uses the app's own shadcn neutral values.
- `src/scripts` is the only client code, two small vanilla modules: `site.ts` (header, menu,
  reveal on scroll, background form posts) and `demo.ts` (the hero demo, driven by one clock).
- Fonts (Unbounded, Manrope, Inter) are self-hosted from `@fontsource-variable`, latin only.

## Rules

- **The page works without JavaScript.** Content is visible, the demo is a still, and both forms
  post normally: the Worker redirects back to `/#joined-hero` or `/#joined-waitlist`, which CSS
  shows as the form's "You're on the list" message.
- **Motion follows `.claude/skills/animate`:** transform and opacity only, strong ease-out curves,
  short UI durations, hover effects only on `(hover: hover) and (pointer: fine)`, and reduced
  motion keeps gentle fades but no movement (the demo doesn't autoplay and shows end states).
- **Copy** follows [avoid-ai-writing](https://github.com/conorbronsdon/avoid-ai-writing): no em
  dashes, sentence-case headings.
- The self-host snippet (`SelfHost.astro`) mirrors the install commands in `docs/deploying.md`.
- The team-size options live in `src/team-size.ts`, read by both the form and the endpoint; the
  column's CHECK constraint (`migrations/0002_team_size.sql`) must match.

Deploys go through `.github/workflows/marketing.yml` on pushes to `main`, once the
`MARKETING_CLOUDFLARE_API_TOKEN` and `MARKETING_CLOUDFLARE_ACCOUNT_ID` secrets exist. Read
submissions with `wrangler d1 execute ros-marketing --remote --command "SELECT * FROM marketing_signup"`.
