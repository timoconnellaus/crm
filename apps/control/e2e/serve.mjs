// Starts ros-control in fake mode for the e2e run: a fresh local state, migrations, then wrangler dev.
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const port = process.argv[2] ?? "8791";
const cwd = fileURLToPath(new URL("..", import.meta.url));
const state = ".wrangler/e2e-state";
rmSync(new URL(`../${state}`, import.meta.url), { recursive: true, force: true });

const wrangler = (args, opts = {}) => [
  "wrangler",
  [...args, "-c", "wrangler.e2e.jsonc", "--persist-to", state],
  { cwd, ...opts },
];

const [cmd, args, opts] = wrangler(["d1", "migrations", "apply", "DB", "--local"]);
const migrated = spawnSync("npx", [cmd, ...args], {
  ...opts,
  stdio: "inherit",
  env: { ...process.env, CI: "1" },
});
if (migrated.status !== 0) process.exit(migrated.status ?? 1);

const [devCmd, devArgs, devOpts] = wrangler(["dev", "--port", port, "--ip", "127.0.0.1"]);
const child = spawn("npx", [devCmd, ...devArgs], { ...devOpts, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 0));
