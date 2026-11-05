// Vendored from cloudflare/cloudflare-os@a3ba4746b58f packages/gatekeeper-email/src/observability.ts (Apache-2.0). Modified locally: see UPSTREAM.md in this package.
import { createObservabilityContext } from "@relationship-os/gatekeeper-observability/observability-context";

/** Observability fields emitted by the Email gatekeeper. */
export type EmailObservabilityFields = { vendorId: string };

/** Ambient observability fields for one Email gatekeeper operation. */
export const obsContext = createObservabilityContext<EmailObservabilityFields>();
