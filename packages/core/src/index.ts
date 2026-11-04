// @crm/core: the operations registry and everything an operation needs. See README.md.

export * from "./diff.ts";
export * from "./errors.ts";
export * from "./fields/index.ts";
export * from "./filter.ts";
export * from "./gate.ts";
export * from "./ids.ts";
export * from "./invoke.ts";
export * from "./list.ts";
export * from "./operation.ts";
export * from "./operations/affiliation.ts";
export { coreOperations } from "./operations/index.ts";
export * from "./operations/organisation.ts";
export * from "./operations/person.ts";
export * from "./operations/policy.ts";
export * from "./operations/trash.ts";
export * from "./operations/user.ts";
export { type InvocationContext, invokeOperation, redactInput } from "./pipeline.ts";
export * from "./principals.ts";
export { runTrashPurge, type TrashPurgeOptions } from "./purge.ts";
export * from "./records/tags.ts";
export * from "./registry.ts";
export { loadApprovalPolicy } from "./settings.ts";
export { type PrincipalLike, resolveActingUser, SYSTEM_USER } from "./users.ts";
