import { getPrismaClient } from "@narriflow/db/client";
import { createExecutionMaintenanceRuntime } from "@narriflow/services/execution-maintenance-runtime";
import type { ExecutionMaintenanceExternalPorts } from "@narriflow/services/execution-maintenance-ports";
import { deliverExecutionDispatches } from "@narriflow/services/execution-dispatch-runtime";
import { readServiceEnvironment } from "@narriflow/services/runtime-environment";
import { createPrivateJsonStorage } from "@narriflow/services/private-json-storage";
import { createClipSelectionStorage } from "@narriflow/services/clip-selection-storage";
import { createProjectDeletionReceiptStorage } from "@narriflow/services/project-retention-storage";
import { getProcessingUsage } from "@narriflow/services/processing-usage-runtime";
import { uploadSessionService } from "@narriflow/services/upload-session.service";
import { billingService } from "@narriflow/services/billing.service";
import { planFinishingRecoveryPage, planFinishingRestorePage } from "@narriflow/services/generation-finishing-maintenance";
import { planProjectNotificationRecoveryPage, planProjectNotificationRestorePage,planGrantNotificationRecoveryPage,planGrantNotificationRestorePage, planReviewNotificationRecoveryPage, planReviewNotificationRestorePage } from "@narriflow/services/notification-maintenance";
import { planPublicationRecoveryPage, planPublicationRestorePage, planPublicationReceiptRecoveryPage, planPublicationReceiptRedispatchPage, planPerformanceCaptureRecoveryPage, planPerformanceCaptureRedispatchPage, planStandingGrantExpiryPage,planStandingGrantAuthorityPage, planStandingGrantRedispatchPage, planPublicationGuidanceRedispatchPage } from "@narriflow/services/publication-maintenance";
import { recoverExportBundleWakesPage, expireExportBundlesPage, restoreExportBundlesPage } from "@narriflow/services/export-bundle-recovery";
import { recoverDubbingWakesPage, restoreDubbingPage } from "@narriflow/services/dubbing-recovery";
import { planAutopilotRecoveryPage, planAutopilotRestorePage, planZoomNotificationRecoveryPage, planZoomNotificationRestorePage } from "@narriflow/services/autopilot-maintenance";

const ports = {
  maintenance: {
    finishing_wakes: planFinishingRecoveryPage,
    publication_wakes: planPublicationRecoveryPage,
    publication_receipts: planPublicationReceiptRecoveryPage,
    publication_captures: planPerformanceCaptureRecoveryPage,
    bundle_wakes: recoverExportBundleWakesPage,
    dubbing_wakes: recoverDubbingWakesPage,
    grants: planStandingGrantExpiryPage,
    grant_authority:planStandingGrantAuthorityPage,
    bundle_expiry: expireExportBundlesPage,
    autopilot_wakes: planAutopilotRecoveryPage,
    zoom_notification_wakes: planZoomNotificationRecoveryPage,
    notification_wakes: planProjectNotificationRecoveryPage,
    review_notification_wakes: planReviewNotificationRecoveryPage,
    grant_notification_wakes:planGrantNotificationRecoveryPage,
  },
  restore: {
    finishing: planFinishingRestorePage,
    publication: planPublicationRestorePage,
    bundle: restoreExportBundlesPage,
    dubbing: restoreDubbingPage,
    autopilot: planAutopilotRestorePage,
    zoom_notifications: planZoomNotificationRestorePage,
    notifications: planProjectNotificationRestorePage,
    review_notifications: planReviewNotificationRestorePage,
    grant_notifications:planGrantNotificationRestorePage,
  },
  redispatch: {
    publication_receipts: planPublicationReceiptRedispatchPage,
    publication_captures: planPerformanceCaptureRedispatchPage,
    grants: planStandingGrantRedispatchPage,
    publication_guidance: planPublicationGuidanceRedispatchPage,
  },
} satisfies ExecutionMaintenanceExternalPorts;

/** Resolve once inside this request or Workflow command's fresh DB/env scope.
 * The module retains only stateless Tx planners, never a Prisma or S3 client. */
export async function getWorkerMaintenanceRuntime() {
  const database = getPrismaClient();
  if (!database) throw Error("Maintenance requires a database scope");
  const environment = readServiceEnvironment();
  const config = { accountId: environment.R2_ACCOUNT_ID ?? "", bucket: environment.R2_BUCKET ?? "",
    accessKeyId: environment.R2_ACCESS_KEY_ID ?? "", secretAccessKey: environment.R2_SECRET_ACCESS_KEY ?? "" };
  return createExecutionMaintenanceRuntime({ database, ports, register: deliverExecutionDispatches,
    toolchainFingerprint: environment.MEDIA_RENDER_TOOLCHAIN_FINGERPRINT ?? "",
    storage: { selection: createClipSelectionStorage(config), privateJson: createPrivateJsonStorage(config) },
    upload: { reconcile: (id, epoch, beforeProvider, beforeHttp) => uploadSessionService.reconcileSession(id, epoch, beforeProvider, beforeHttp) },
    pendingWorkspace: { expire: (id, epoch) => billingService.expirePendingBusinessWorkspace(id, epoch) },
    retention: { ...createProjectDeletionReceiptStorage(config),
      releaseUsage: async (tx, projectId) => { await getProcessingUsage().release(tx, { projectId, reason: "project_retention_purged" }); },
    },
  });
}
