// The packages we vendor from cloudflare/cloudflare-os and what each takes from upstream. Shared by
// scripts/vendor-gatekeepers.mjs (which copies them) and scripts/upstream-sync-check.mjs (which
// reports upstream changes since the recorded commit).

export const UPSTREAM_REPO = "https://github.com/cloudflare/cloudflare-os.git";

/**
 * What each package takes. `dirs` are replaced wholesale (minus `keep`, which holds local files
 * such as shims); `files` map an upstream path (relative to the upstream root) to a package path.
 */
export const PACKAGES = [
  {
    target: "packages/gatekeeper-interface",
    upstream: "packages/workshop-shared",
    dirs: [],
    files: [
      ["packages/workshop-shared/src/gatekeeper.ts", "src/gatekeeper.ts"],
      // Shared by every vendored package's workerd test config.
      ["scripts/assert-workerd.ts", "testing/assert-workerd.ts"],
    ],
  },
  {
    target: "packages/gatekeeper-observability",
    upstream: "packages/observability",
    dirs: [],
    files: [
      ["packages/observability/src/logger.ts", "src/logger.ts"],
      ["packages/observability/src/logger-core.ts", "src/logger-core.ts"],
      ["packages/observability/src/observability-context.ts", "src/observability-context.ts"],
      ["packages/observability/src/node-async-hooks.d.ts", "src/node-async-hooks.d.ts"],
      ["packages/observability/__tests__/logger.test.ts", "__tests__/logger.test.ts"],
    ],
  },
  {
    target: "packages/gatekeeper-configurator-ui",
    upstream: "packages/configurator-ui",
    dirs: [],
    files: [
      ["packages/configurator-ui/src/index.ts", "src/index.ts"],
      ["packages/configurator-ui/src/runtime/options.ts", "src/runtime/options.ts"],
      ["packages/configurator-ui/src/runtime/options.test.ts", "src/runtime/options.test.ts"],
    ],
  },
  {
    target: "packages/gatekeeper-kit",
    upstream: "packages/gatekeeper-kit",
    dirs: ["src", "__tests__"],
    files: [
      ["packages/gatekeeper-kit/README.md", "README.md"],
      ["packages/gatekeeper-kit/USAGE.md", "USAGE.md"],
      ["packages/gatekeeper-kit/AGENTS.md", "AGENTS.md"],
    ],
  },
  {
    target: "packages/mcp-shared",
    upstream: "packages/mcp-shared",
    dirs: ["src", "__tests__"],
    files: [
      ["packages/mcp-shared/README.md", "README.md"],
      ["packages/mcp-shared/AGENTS.md", "AGENTS.md"],
    ],
  },
  {
    target: "packages/gatekeeper-mcp",
    upstream: "packages/gatekeeper-mcp",
    dirs: ["src", "__tests__"],
    files: [["packages/gatekeeper-mcp/README.md", "README.md"]],
    keep: ["src/generated"],
  },
  {
    target: "packages/gatekeeper-google",
    upstream: "packages/gatekeeper-google",
    dirs: ["src", "__tests__"],
    files: [["packages/gatekeeper-google/README.md", "README.md"]],
    keep: ["src/generated"],
  },
  {
    target: "packages/gatekeeper-microsoft",
    upstream: "packages/gatekeeper-microsoft",
    dirs: ["src", "__tests__"],
    files: [
      ["packages/gatekeeper-microsoft/README.md", "README.md"],
      ["packages/gatekeeper-microsoft/AGENTS.md", "AGENTS.md"],
      ["packages/gatekeeper-microsoft/storage-schema.md", "storage-schema.md"],
    ],
    keep: ["src/generated"],
  },
  {
    target: "packages/gatekeeper-slack",
    upstream: "packages/gatekeeper-slack",
    // Upstream keeps Slack's tests next to the source, in src/.
    dirs: ["src"],
    files: [["packages/gatekeeper-slack/README.md", "README.md"]],
    keep: ["src/generated"],
  },
  {
    target: "packages/gatekeeper-email",
    upstream: "packages/gatekeeper-email",
    dirs: ["src"],
    files: [["packages/gatekeeper-email/README.md", "README.md"]],
    keep: ["src/generated"],
  },
  {
    target: "packages/gatekeeper-zoominfo",
    upstream: "packages/gatekeeper-zoominfo",
    dirs: ["src"],
    files: [["packages/gatekeeper-zoominfo/README.md", "README.md"]],
    keep: ["src/generated"],
  },
  {
    target: "packages/gatekeeper-websearch",
    upstream: "packages/gatekeeper-websearch",
    dirs: ["src", "__tests__"],
    files: [
      ["packages/gatekeeper-websearch/README.md", "README.md"],
      ["packages/gatekeeper-websearch/AGENTS.md", "AGENTS.md"],
    ],
  },
];
