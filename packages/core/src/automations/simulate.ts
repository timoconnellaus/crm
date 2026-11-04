// Test mode (ADR 0133): an automation run against a real record with nothing written. Every
// operation the run calls goes through the pipeline with `InvocationContext.simulate`: the gate
// is evaluated and recorded, writes are dry-run exactly as the approval queue dry-runs them
// (approvals/queue.ts), and the records they would create or change join an in-memory overlay
// that the run's later reads see (approvals/simulation.ts). No statement, audit row or event
// leaves the pipeline.
import { Overlay } from "../approvals/simulation.ts";
import type { RunOperationRecord, TestNotification } from "./types.ts";

export interface TestGateRecord {
  operation: string;
  gate: "auto" | "review" | "deny";
  bulkSize: number;
  reason: string;
}

export interface TestWrite {
  object: string;
  id: string;
  action: string;
  title: string | null;
  operation: string;
}

/** The state of one test run: its overlay and what the pipeline recorded. */
export interface TestSimulation {
  overlay: Overlay;
  gates: TestGateRecord[];
  writes: TestWrite[];
  notifications: TestNotification[];
  /** Per-call records, in order (the run host also keeps its own). */
  operations: RunOperationRecord[];
}

export function createTestSimulation(): TestSimulation {
  return { overlay: new Overlay(), gates: [], writes: [], notifications: [], operations: [] };
}
