// @relationship-os/agent-a2ui (ADR 0346, ADR 0350): A2UI cards for an assistant. This entry is
// plain TypeScript with no React, so a Worker can validate and store cards: the catalogue and its
// versioning, card validation, text fallbacks and the saved producer registry. The React renderer
// is `@relationship-os/agent-a2ui/react`; a sample of every component, for hosts' tests and
// galleries, is `@relationship-os/agent-a2ui/samples`.
export * from "./catalogue.ts";
export * from "./document.ts";
export * from "./producers.ts";
export * from "./schema.ts";
