// Browser-safe subset of @crm/core for UI code: the field registry, filter JSON, sort, and the
// approval-policy presets. It never pulls in operation handlers or the database package, so the
// UI bundle stays small and cannot reach D1. Import it as `@crm/core/client`.
export { COMMON_CURRENCIES } from "./currencies.ts";
export { type Row, resolveClickThrough } from "./dashboards/click-through.ts";
export * from "./dashboards/spec.ts";
export type { FieldDiff } from "./diff.ts";
export * from "./fields/field-types.ts";
export * from "./fields/index.ts";
export {
  FILTER_LIMITS,
  FILTER_OPS,
  type Filter,
  type FilterCondition,
  type FilterOp,
  filterSchema,
  OPS_BY_TYPE,
  RELATED_OPS,
} from "./filter.ts";
export {
  GATE_DECISIONS,
  type GateDecision,
  type GateFloor,
  type GateMatrix,
  type GateRule,
  isLoosening,
  POLICY_PRESETS,
  type PolicyPreset,
  PRESET_MATRICES,
} from "./gate.ts";
export { LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT, type Sort, sortSchema } from "./list.ts";
export {
  ACTORS,
  type Actor,
  RISK_CLASSES,
  type RiskClass,
  ROLES,
  type Role,
} from "./principals.ts";
export {
  type BoardViewSpec,
  boardViewSpecSchema,
  CALENDAR_MODES,
  type CalendarViewSpec,
  calendarViewSpecSchema,
  type GalleryViewSpec,
  galleryViewSpecSchema,
  groupValues,
  isDateField,
  isGroupable,
  isSummable,
  OBJECT_VIEW_TYPES,
  type ObjectViewSpec,
  type ObjectViewType,
  objectViewSpecSchema,
  type TableViewSpec,
  tableViewSpecSchema,
  VIEW_TYPES,
  type ViewSpec,
  type ViewType,
} from "./views/spec.ts";
