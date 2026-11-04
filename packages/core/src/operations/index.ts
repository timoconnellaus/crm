// Every core operation. To add an object's operations: create `<object>.ts` next to this file
// exporting `<object>Operations = [...] as const`, then add one import and one spread line below.
// One line per object so parallel changes merge cleanly.
import { activityOperations } from "./activity.ts";
import { personOperations } from "./person.ts";
import { policyOperations } from "./policy.ts";
import { taskOperations } from "./task.ts";

// biome-ignore format: one spread per line keeps parallel additions conflict-free.
export const coreOperations = [
  ...personOperations,
  ...policyOperations,
  ...activityOperations,
  ...taskOperations,
] as const;
