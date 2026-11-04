// Every core operation. To add an object's operations: create `<object>.ts` next to this file
// exporting `<object>Operations = [...] as const`, then add one import and one spread line below.
// One line per object so parallel changes merge cleanly.

import { syncOperations } from "../sync/ingest.ts";
import { activityOperations } from "./activity.ts";
import { affiliationOperations } from "./affiliation.ts";
import { approvalOperations } from "./approval.ts";
import { auditOperations } from "./audit.ts";
import { codeOperations } from "./code.ts";
import { connectedAppOperations } from "./connected-app.ts";
import { countOperations } from "./count.ts";
import { dashboardOperations } from "./dashboard.ts";
import { enrichmentOperations } from "./enrichment.ts";
import { exportOperations } from "./export.ts";
import { extensionOperations } from "./extension.ts";
import { extensionAuthoringOperations } from "./extension-authoring.ts";
import { extensionUiOperations } from "./extension-ui.ts";
import { importOperations } from "./import.ts";
import { integrationOperations } from "./integration.ts";
import { organisationOperations } from "./organisation.ts";
import { personOperations } from "./person.ts";
import { policyOperations } from "./policy.ts";
import { queryOperations } from "./query.ts";
import { recordOperations } from "./record.ts";
import { retentionOperations } from "./retention.ts";
import { searchOperations } from "./search.ts";
import { suggestionOperations } from "./suggestions.ts";
import { taskOperations } from "./task.ts";
import { trashOperations } from "./trash.ts";
import { userOperations } from "./user.ts";
import { viewOperations } from "./view.ts";

// biome-ignore format: one spread per line keeps parallel additions conflict-free.
export const coreOperations = [
  ...personOperations,
  ...policyOperations,
  ...organisationOperations,
  ...affiliationOperations,
  ...trashOperations,
  ...userOperations,
  ...activityOperations,
  ...taskOperations,
  ...viewOperations,
  ...auditOperations,
  ...searchOperations,
  ...queryOperations,
  ...importOperations,
  ...exportOperations,
  ...recordOperations,
  ...extensionOperations,
  ...extensionAuthoringOperations,
  ...codeOperations,
  ...approvalOperations,
  ...connectedAppOperations,
  ...retentionOperations,
  ...countOperations,
  ...integrationOperations,
  ...enrichmentOperations,
  ...syncOperations,
  ...suggestionOperations,
  ...dashboardOperations,
  ...extensionUiOperations,
] as const;
