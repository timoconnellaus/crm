// Every core operation. To add an object's operations: create `<object>.ts` next to this file
// exporting `<object>Operations = [...] as const`, then add one import and one spread line below.
// One line per object so parallel changes merge cleanly.

import { syncOperations } from "../sync/ingest.ts";
import { activityOperations } from "./activity.ts";
import { adjudicatorOperations } from "./adjudicator.ts";
import { affiliationOperations } from "./affiliation.ts";
import { aiOperations } from "./ai.ts";
import { aiCacheOperations } from "./ai-cache.ts";
import { approvalOperations } from "./approval.ts";
import { assignmentOperations } from "./assignment.ts";
import { assistantOperations } from "./assistant.ts";
import { auditOperations } from "./audit.ts";
import { automationOperations } from "./automation.ts";
import { automationBindingOperations } from "./automation-binding.ts";
import { codeOperations } from "./code.ts";
import { connectedAppOperations } from "./connected-app.ts";
import { countOperations } from "./count.ts";
import { dashboardOperations } from "./dashboard.ts";
import { enrichmentOperations } from "./enrichment.ts";
import { erasureOperations } from "./erasure.ts";
import { exportOperations } from "./export.ts";
import { extensionOperations } from "./extension.ts";
import { extensionAuthoringOperations } from "./extension-authoring.ts";
import { extensionUiOperations } from "./extension-ui.ts";
import { fieldOptionsOperations } from "./field-options.ts";
import { importOperations } from "./import.ts";
import { importRecordsOperations } from "./import-records.ts";
import { integrationOperations } from "./integration.ts";
import { judgeOperations } from "./judge.ts";
import { notificationOperations } from "./notification.ts";
import { notificationDeliveryOperations } from "./notification-delivery.ts";
import { organisationOperations } from "./organisation.ts";
import { personOperations } from "./person.ts";
import { planOperations } from "./plan.ts";
import { policyOperations } from "./policy.ts";
import { queryOperations } from "./query.ts";
import { recordOperations } from "./record.ts";
import { retentionOperations } from "./retention.ts";
import { searchOperations } from "./search.ts";
import { settingsOperations } from "./settings.ts";
import { setupOperations } from "./setup.ts";
import { suggestionOperations } from "./suggestions.ts";
import { summaryOperations } from "./summary.ts";
import { supportOperations } from "./support.ts";
import { taskOperations } from "./task.ts";
import { trashOperations } from "./trash.ts";
import { updateOperations } from "./update.ts";
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
  ...importRecordsOperations,
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
  ...settingsOperations,
  ...dashboardOperations,
  ...extensionUiOperations,
  ...updateOperations,
  ...setupOperations,
  ...aiOperations,
  ...adjudicatorOperations,
  ...summaryOperations,
  ...automationOperations,
  ...automationBindingOperations,
  ...notificationOperations,
  ...notificationDeliveryOperations,
  ...assistantOperations,
  ...aiCacheOperations,
  ...planOperations,
  ...supportOperations,
  ...erasureOperations,
  ...judgeOperations,
  ...assignmentOperations,
  ...fieldOptionsOperations,
] as const;
