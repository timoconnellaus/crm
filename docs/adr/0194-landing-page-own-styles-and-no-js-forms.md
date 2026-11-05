# ADR 0194: The landing page has its own styles, and its forms work without JavaScript

Status: accepted, 2026-11-05 (Stage 9).

## Context
Stage 9 asked for a landing page "using the shared brand tokens". The scaffold pulled Tailwind and
`@relationship-os/ui`'s `globals.css` into `apps/marketing`. The approved design ("soft chrome",
Y2K softened) has its own palette, display type and light and dark themes; the app's tokens appear
only inside the hero demo, which replays the real app in its shadcn neutral theme. The page must
also score Lighthouse 95 or more, load nothing from another origin, and read well without
JavaScript, including both waitlist forms.

## Decision
- **`apps/marketing` has its own stylesheet** (`src/styles/base.css` tokens and shared pieces,
  `landing.css` sections), inlined into each page at build time. It no longer depends on Tailwind
  or `@relationship-os/ui`. The demo copies the app's neutral values (`--a-*`) so it looks like the
  product, and stays light in dark mode, like a screenshot.
- **Fonts are self-hosted** from `@fontsource-variable` (Unbounded, Manrope, Inter; OFL), latin
  subset only, `font-display: swap`, the two hero fonts preloaded.
- **Client code is two small vanilla modules** (`src/scripts`), no framework runtime. Without
  JavaScript, content is visible and the demo is a still.
- **Forms post normally.** Without JavaScript the Worker answers a waitlist post with a 303 to
  `/#joined-<form>`; CSS (`:target`) shows that form's "You're on the list" message. With
  JavaScript the same endpoint answers JSON and the message appears in place. A hidden `source`
  field names the form; it only picks the redirect and is not stored.
- **Motion follows the `animate` skill** (`.claude/skills/animate`, MIT, see `UPSTREAMS.md`).

## Consequences
- The site and the app can drift visually. That is intended: the site has a marketing identity,
  and the demo is the place that has to match the app.
- A change to the brand colours means editing `base.css` (and re-rendering `public/og.png` with
  `pnpm --filter @relationship-os/marketing og-image`).
- `/thanks/` remains for contact-sales posts; waitlist posts no longer go there.
