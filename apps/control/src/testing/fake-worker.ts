// The entry for fake-mode runs (wrangler.e2e.jsonc, vitest.config.ts): ros-control plus the Durable
// Object class that backs the fake customer databases. Never deployed.
export { ControlRpc, default } from "../worker.ts";
export { FakeD1Database } from "./fake-d1.ts";
