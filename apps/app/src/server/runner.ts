// Typed access to ros-runner over the RUNNER service binding. `wrangler types` types the binding
// as a plain Fetcher (the runner's source is not type-checked against ros-app's Env), so the RPC
// shape comes from the runner's own exported interface, which its entrypoint implements.
import type { RunnerRpc } from "@relationship-os/runner/rpc";

export function runner(env: { RUNNER: Fetcher }): Service<RunnerRpc & Rpc.WorkerEntrypointBranded> {
  return env.RUNNER as unknown as Service<RunnerRpc & Rpc.WorkerEntrypointBranded>;
}
