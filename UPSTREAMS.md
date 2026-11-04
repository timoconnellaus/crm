# Upstreams

Code and designs we take from other projects. Vendored code records the exact upstream commit it
tracks; to pick up upstream changes, review the diff since that commit and port deliberately.

| Upstream | License | What we take | Vendored? | Tracks commit |
| --- | --- | --- | --- | --- |
| [cloudflare/cloudflare-os](https://github.com/cloudflare/cloudflare-os) | Apache-2.0 | Gatekeeper interface, `gatekeeper-kit`, selected gatekeepers (stage 6); release bundle tooling pattern (stage 8) | Not yet | `e51bda9cb946973c63e58a5c14af3883fc0ee83d` (reviewed for stage 0) |
| [cloudflare/computer](https://github.com/cloudflare/computer) | MIT | `@cloudflare/computer` as an npm dependency for the extension runtime | No (dependency) | `b995d86503eab22793ba1feb07c3c67818e6f6b9` (reviewed for stage 0) |

## Local changes to vendored code

_None yet._
