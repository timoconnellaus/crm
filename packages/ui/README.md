# @crm/ui

Shared [shadcn/ui](https://ui.shadcn.com) components (new-york style, neutral palette) and the
Tailwind v4 theme for every app UI. Later it also holds the view-spec renderer (ADR 0010).

Add a component from this directory with `pnpm dlx shadcn@latest add <name>`; `components.json`
points the generated imports at `@crm/ui/*`. Check the generated imports: the CLI can resolve the
`cn` helper to a bare `"cn"` package; it must be `@crm/ui/lib/utils`.

Import components as `@crm/ui/components/<name>` and the theme as `@crm/ui/globals.css`.
