// @crm/core: the operations registry and everything an operation needs. See README.md.

export { DEFAULT_APPROVAL_EXPIRY_DAYS } from "./approvals/queue.ts";
export { isSimulatedRead } from "./approvals/simulation.ts";
export * from "./diff.ts";
export * from "./errors.ts";
export * from "./extensions/host.ts";
export * from "./extensions/install.ts";
export * from "./extensions/naming.ts";
export * from "./extensions/proposal.ts";
export * from "./extensions/reconciler.ts";
export * from "./extensions/schema.ts";
export * from "./extensions/shipped.ts";
export * from "./extensions/tools.ts";
export * from "./fields/field-types.ts";
export * from "./fields/index.ts";
export * from "./filter.ts";
export * from "./gate.ts";
export * from "./ids.ts";
export * from "./integrations/catalogue.ts";
export * from "./integrations/events.ts";
export * from "./integrations/outbound.ts";
export * from "./integrations/runtime.ts";
export * from "./invoke.ts";
export * from "./list.ts";
export * from "./models.ts";
export * from "./operation.ts";
export * from "./operations/activity.ts";
export * from "./operations/affiliation.ts";
export * from "./operations/approval.ts";
export * from "./operations/audit.ts";
export * from "./operations/code.ts";
export * from "./operations/connected-app.ts";
export * from "./operations/export.ts";
export * from "./operations/extension.ts";
export * from "./operations/extension-authoring.ts";
export * from "./operations/import.ts";
export { coreOperations } from "./operations/index.ts";
export * from "./operations/integration.ts";
export * from "./operations/organisation.ts";
export * from "./operations/person.ts";
export * from "./operations/policy.ts";
export * from "./operations/query.ts";
export * from "./operations/record.ts";
export * from "./operations/retention.ts";
export * from "./operations/search.ts";
export * from "./operations/suggestions.ts";
export * from "./operations/task.ts";
export * from "./operations/trash.ts";
export * from "./operations/user.ts";
export * from "./operations/view.ts";
export {
  type InvocationContext,
  invokeOperation,
  operationObject,
  readCountHour,
  redactInput,
} from "./pipeline.ts";
export * from "./principals.ts";
export { runTrashPurge, type TrashPurgeOptions } from "./purge.ts";
export * from "./rate-limit.ts";
export { BATCH_MAX, jsonList, purgeCutoff, restorableUntil } from "./records/common.ts";
export {
  assertLinkTargets,
  LINK_TARGETS,
  type LinkedRecord,
  linkedRecordSchema,
  linkKeys,
  loadLinks,
  loadRecordTitles,
  recordRefSchema,
  uniqueRefs,
} from "./records/links.ts";
export * from "./records/tags.ts";
export * from "./registry.ts";
export * from "./retention.ts";
export { loadApprovalPolicy } from "./settings.ts";
export * from "./sync/ingest.ts";
export * from "./sync/signals.ts";
export { type PrincipalLike, resolveActingUser, SYSTEM_USER } from "./users.ts";
