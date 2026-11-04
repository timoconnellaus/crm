// The test host is declared only in vitest.config.ts; production has no such binding.

import type { TestHost } from "./worker.js";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_HOST: DurableObjectNamespace<TestHost>;
    }
  }
}
