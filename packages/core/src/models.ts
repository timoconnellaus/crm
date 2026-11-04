// Model roles (ADR 0009, ADR 0150): code asks for a role, never a model. The registry lives in
// ai/roles.ts (roles, capabilities, shipped defaults, layering) and ai/client.ts (running a role
// through the AI SDK and AI Gateway); this module is the stable import path for the rest of core.
export * from "./ai/client.ts";
export * from "./ai/fake.ts";
export * from "./ai/roles.ts";
