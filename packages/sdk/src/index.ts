// @crm/sdk: the extension contract (ADR 0005, ADR 0023). See README.md.
//
//   import { defineExtension, defineTool, z } from "@crm/sdk";
//   export default defineExtension({ id: "example", version: "1.0.0", contractVersion: 1, ... });
export { z } from "zod";
export * from "./contract.ts";
export * from "./field-types.ts";
export * from "./manifest.ts";
export * from "./permissions.ts";
export {
  buildContext,
  type RawHostModules,
  type RunRequest,
  type RunResponse,
  runExtension,
} from "./runtime.ts";
