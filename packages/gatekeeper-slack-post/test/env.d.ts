import type { TestHost } from "./worker";

declare global {
  namespace Cloudflare {
    interface Env {
      // Declared only in vitest.config.ts: the host-like harness the tests drive.
      TEST_HOST: DurableObjectNamespace<TestHost>;
    }
  }
}
