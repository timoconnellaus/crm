// @relationship-os/sdk: the extension contract (ADR 0005, ADR 0023). See README.md.
//
//   import { defineExtension, defineTool, z } from "@relationship-os/sdk";
//   export default defineExtension({ id: "example", version: "1.0.0", contractVersion: 1, ... });
export { z } from "zod";
export * from "./automation.ts";
export * from "./automation-check.ts";
export * from "./contract.ts";
export * from "./field-types.ts";
export * from "./manifest.ts";
export * from "./permissions.ts";
export {
  type AutomationRunValue,
  AutomationStepError,
  buildAutomationContext,
  buildContext,
  CrmCallError,
  type CrmReply,
  type RawHostModules,
  type RunRequest,
  type RunResponse,
  runAutomation,
  runExtension,
} from "./runtime.ts";
