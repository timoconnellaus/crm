# Upstreams

Code and designs we take from other projects. Vendored code records the exact upstream commit it
tracks; to pick up upstream changes, review the diff since that commit and port deliberately.

| Upstream | License | What we take | Vendored? | Tracks commit |
| --- | --- | --- | --- | --- |
| [cloudflare/cloudflare-os](https://github.com/cloudflare/cloudflare-os) | Apache-2.0 | Gatekeeper interface, `gatekeeper-kit`, selected gatekeepers (stage 6); release bundle tooling pattern (stage 8) | Not yet | `e51bda9cb946973c63e58a5c14af3883fc0ee83d` (reviewed for stage 0) |
| [cloudflare/computer](https://github.com/cloudflare/computer) | MIT | `@cloudflare/computer` as an npm dependency for the extension runtime, pinned at `0.9.0` together with its optional git peer `@platformatic/vfs` `0.5.0` | No (dependency) | `b995d86503eab22793ba1feb07c3c67818e6f6b9` (reviewed for stage 0) |
| [shadcn/ui](https://ui.shadcn.com) | MIT | Components in `packages/ui/src/components` and `src/hooks`, generated with the `shadcn` CLI (4.23.0, new-york, neutral) | Generated copies | n/a (registry, 2026-11-04) |

## Local changes to vendored code

- `packages/ui` shadcn components: the CLI resolved the `cn` helper to a bare `"cn"` package; imports
  were changed to `@crm/ui/lib/utils`. Files are formatted by Biome. `noDocumentCookie` and
  `useExhaustiveDependencies` are switched off for these files (biome.json) to stay close to
  upstream. The theme in `src/styles/globals.css` is the standard neutral theme plus a `--success`
  colour.
