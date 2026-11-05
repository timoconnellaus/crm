// Bundles the CLI (and @relationship-os/release, which is not published) into one dependency-free file.
import { chmodSync } from "node:fs";
import { build } from "esbuild";

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "none",
});
chmodSync("dist/cli.js", 0o755);
