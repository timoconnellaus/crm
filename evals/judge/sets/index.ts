// Every labelled set `pnpm eval:calibrate` runs (ADR 0231). A placement's questions get a set here,
// in a file of their own beside this one, before the placement ships.
import type { PlacementSet } from "../lib/calibrate.ts";
import { adjudicatorPolicySet } from "./adjudicator-policy.ts";
import { authoringIntentSet } from "./authoring-intent.ts";
import { memoryConditionSet } from "./memory-condition.ts";
import { memoryWriteSet } from "./memory-write.ts";
import { outboundMessageSet } from "./outbound-message.ts";
import { pluginPresetSet } from "./plugin-preset.ts";
import { pluginRiskSet } from "./plugin-risk.ts";
import { routineGateSet } from "./routine-gate.ts";
import { summaryStatementsSet } from "./summary-statements.ts";
import { syncJobChangeSet } from "./sync-job-change.ts";
import { widgetShapeSet } from "./widget-shape.ts";

// biome-ignore lint/suspicious/noExplicitAny: each set has its own state and answer types; the runner only passes them through.
export const SETS: PlacementSet<any, any>[] = [
  authoringIntentSet,
  summaryStatementsSet,
  outboundMessageSet,
  widgetShapeSet,
  adjudicatorPolicySet,
  syncJobChangeSet,
  memoryWriteSet,
  memoryConditionSet,
  routineGateSet,
  pluginRiskSet,
  pluginPresetSet,
];
