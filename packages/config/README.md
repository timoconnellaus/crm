# @crm/config

Shared tooling presets for every workspace package:

- `tsconfig.base.json`: strict TypeScript for Workers and libraries.
- `tsconfig.react.json`: the same, plus DOM libs and JSX for React code.
- `biome-preset.json`: lint and format rules. The root `biome.json` extends it.
- `vitest.ts`: `defineWorkersTestConfig()`, which runs tests in workerd through
  `@cloudflare/vitest-plugin` so D1, Durable Objects and Workflows are real.
