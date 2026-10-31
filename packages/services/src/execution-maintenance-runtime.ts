import type { ExecutionDispatchReference } from "@narriflow/validators/execution";
import { ClipPreparationService } from "./clip-preparation";
import { clipPreparationEngineHash } from "./clip-preparation-policy";
import { ExecutionMaintenanceService,type MaintenancePhaseHandler } from "./execution-maintenance";
import { ExecutionRestoreService,type ExecutionRestorePhaseHandler } from "./execution-restore";
import type { ExecutionMaintenanceRuntimeOptions } from "./execution-maintenance-ports";
import { expireMcpTaskPage,expireExecutionInboxPage,recoverPendingDispatchPage,recoverExecutionDeadlinePage } from "./execution-maintenance-pages";
import { expireWorkflowEventPage,expireWorkspaceEventPage,expireWebhookLogPage,expireGeneratedPromptPage,expireProjectDeletionReceiptPage,recoverMediaCleanupPage,retireSourceMediaPage,planProjectExpiryWarningPage } from "./execution-retention-pages";
import { expireNativeValidationRowsPage,expireOutboundProbeRowsPage,expireGrantNotificationRowsPage,expireWebhookNotificationRowsPage } from "./execution-private-retention";
import * as safety from "./execution-safety-pages";
import { recoverBillingPage,recoverLibraryPage,restoreBillingPage,restoreLibraryPage } from "./execution-account-recovery-pages";
import { restoreIngestJobsPage,restoreWorkflowRunsPage,restoreRenderGroupsPage } from "./execution-source-recovery-pages";
import { restoreNativeValidationPage,restoreThumbnailPage,restoreGeneratedMediaPage,restoreOutboundProbePage,restoreOutboundDeliveryPage } from "./execution-native-restore";
import { recoverCallbacksPage,recoverWebhookSubscriptionsPage,restoreCallbacksPage,restoreWebhookSubscriptionsPage } from "./execution-notification-recovery";
import { revokeRestoredAttemptsPage } from "./execution-restore-pages";
import { verifyRestoredDeviceFence,verifyRestoreAuthority } from "./execution-restore-verification";
import * as redispatch from "./execution-redispatch-pages";
import { createSelectionRestorePreparation } from "./execution-selection-restore";
import { createPreparationRestorePreparation,createPreparationLinkRestore } from "./execution-preparation-restore";
import { createUploadSessionExecution,recoverUploadSessionPage,restoreUploadSessionsPage } from "./upload-session-execution";
import { createPendingWorkspaceExecution,planPendingWorkspaceExpiryPage } from "./pending-workspace-execution";
import { createProjectRetentionExecution,planProjectRetentionPage } from "./project-retention-execution";
const externalMaintenance=["finishing_wakes","publication_wakes","publication_receipts","publication_captures","bundle_wakes","dubbing_wakes","grants","bundle_expiry","autopilot_wakes","zoom_notification_wakes","notification_wakes","review_notification_wakes","grant_notification_wakes","grant_authority","webhook_notification_wakes"] as const;
const externalRestore=["finishing","publication","bundle","dubbing","autopilot","zoom_notifications","notifications","review_notifications","grant_notifications","webhook_notifications"] as const;
const externalRedispatch=["publication_receipts","publication_captures","grants","publication_guidance"] as const;
/** Fresh per DB/env invocation. No service, connection, object bytes or
 * executor permission survives a Workflow wait. Every external slot is required. */
export async function createExecutionMaintenanceRuntime(options:ExecutionMaintenanceRuntimeOptions){
 for(const name of externalMaintenance)if(typeof options.ports.maintenance[name]!=="function")throw Error(`maintenance_configuration_missing:${name}`);
 for(const name of externalRestore)if(typeof options.ports.restore[name]!=="function")throw Error(`maintenance_configuration_missing:restore.${name}`);
 for(const name of externalRedispatch)if(typeof options.ports.redispatch[name]!=="function")throw Error(`maintenance_configuration_missing:redispatch.${name}`);
 if(!/^[a-f0-9]{64}$/.test(options.toolchainFingerprint)||typeof options.upload.reconcile!=="function"||typeof options.pendingWorkspace.expire!=="function"||typeof options.retention.writeDeletionReceipt!=="function"||typeof options.retention.releaseUsage!=="function")throw Error("maintenance_configuration_invalid");
 const {database,register,ports}=options;
 const preparation=new ClipPreparationService(database,{toolchainFingerprint:options.toolchainFingerprint,engineHash:await clipPreparationEngineHash(options.toolchainFingerprint),storage:options.storage.privateJson,register});
 const upload=createUploadSessionExecution({database,register,reconcile:options.upload.reconcile}),pendingWorkspace=createPendingWorkspaceExecution({database,register,expire:options.pendingWorkspace.expire}),retention=createProjectRetentionExecution({database,register,...options.retention});
 const maintenance=new ExecutionMaintenanceService({database,register,limit:32,phases:{
 dispatches:recoverPendingDispatchPage,deadlines:recoverExecutionDeadlinePage,provider_waits:safety.recoverProviderWaitPage,domain_wakes:safety.recoverIngestWakePage,workflow_wakes:safety.recoverWorkflowWakePage,render_wakes:safety.recoverRenderGroupWakePage,selection_wakes:safety.recoverSelectionWakePage,preparation_wakes:safety.recoverPreparationWakePage,native_validation_wakes:safety.recoverNativeValidationWakePage,thumbnail_wakes:safety.recoverThumbnailWakePage,generated_media_wakes:safety.recoverGeneratedMediaWakePage,outbound_probe_wakes:safety.recoverOutboundProbeWakePage,outbound_delivery_wakes:safety.recoverOutboundDeliveryWakePage,callback_wakes:recoverCallbacksPage,subscription_wakes:recoverWebhookSubscriptionsPage,upload_wakes:recoverUploadSessionPage,billing_wakes:recoverBillingPage,library_wakes:recoverLibraryPage,
 tasks:expireMcpTaskPage,receipts:expireExecutionInboxPage,events:expireWorkflowEventPage,workspace_events:expireWorkspaceEventPage,webhook_logs:expireWebhookLogPage,generated_prompts:expireGeneratedPromptPage,validation_rows:expireNativeValidationRowsPage,probe_rows:expireOutboundProbeRowsPage,grant_notification_rows:expireGrantNotificationRowsPage,webhook_notification_rows:expireWebhookNotificationRowsPage,deletion_receipts:expireProjectDeletionReceiptPage,project_warnings:planProjectExpiryWarningPage,retention:planProjectRetentionPage,sources:retireSourceMediaPage,pending_workspaces:planPendingWorkspaceExpiryPage,cleanup:recoverMediaCleanupPage,
 ...ports.maintenance}});
 // Maintenance handlers accept these immutable restore facts structurally.
 // Their createdAt cursors include future accepted rows; due-only hourly ports
 // are used here only where the domain explicitly defines the same full range.
 const final=(handler:MaintenancePhaseHandler):ExecutionRestorePhaseHandler=>(tx,page)=>handler(tx,page);
 const restore=new ExecutionRestoreService({database,register,limit:32,prepare:{selection:createSelectionRestorePreparation({database,storage:options.storage.selection}),preparation:createPreparationRestorePreparation({database,storage:options.storage.privateJson,service:preparation})},phases:{
 attempts:revokeRestoredAttemptsPage,ingest:restoreIngestJobsPage,workflows:restoreWorkflowRunsPage,render_groups:restoreRenderGroupsPage,preparation_links:createPreparationLinkRestore(preparation),native_validation:restoreNativeValidationPage,thumbnail:restoreThumbnailPage,generated_media:restoreGeneratedMediaPage,outbound_probes:restoreOutboundProbePage,outbound_deliveries:restoreOutboundDeliveryPage,callbacks:restoreCallbacksPage,subscriptions:restoreWebhookSubscriptionsPage,uploads:restoreUploadSessionsPage,billing:restoreBillingPage,library:restoreLibraryPage,devices:verifyRestoredDeviceFence,...ports.restore,
 redispatch:verifyRestoreAuthority,redispatch_ingest:redispatch.createIngestRedispatchPage(options.toolchainFingerprint),redispatch_workflows:redispatch.redispatchWorkflowPage,redispatch_groups:redispatch.redispatchRenderGroupPage,redispatch_selection:redispatch.redispatchSelectionPage,redispatch_preparation:redispatch.redispatchPreparationPage,redispatch_validation:redispatch.redispatchNativeValidationPage,redispatch_thumbnail:redispatch.redispatchThumbnailPage,redispatch_generated:redispatch.redispatchGeneratedMediaPage,redispatch_probes:redispatch.redispatchOutboundProbePage,redispatch_delivery:redispatch.redispatchOutboundDeliveryPage,redispatch_callbacks:final(recoverCallbacksPage),redispatch_subscriptions:final(recoverWebhookSubscriptionsPage),redispatch_uploads:final(recoverUploadSessionPage),redispatch_billing:redispatch.redispatchBillingPage,redispatch_library:redispatch.redispatchLibraryPage,redispatch_finishing:final(ports.maintenance.finishing_wakes),redispatch_publication:final(ports.maintenance.publication_wakes),redispatch_pub_receipts:final(ports.redispatch.publication_receipts),redispatch_pub_captures:final(ports.redispatch.publication_captures),redispatch_grants:final(ports.redispatch.grants),redispatch_guidance:ports.redispatch.publication_guidance,redispatch_bundle:final(ports.maintenance.bundle_wakes),redispatch_dubbing:final(ports.maintenance.dubbing_wakes),redispatch_autopilot:final(ports.maintenance.autopilot_wakes),redispatch_zoom:final(ports.maintenance.zoom_notification_wakes),redispatch_notifications:final(ports.maintenance.notification_wakes),redispatch_review_mail:final(ports.maintenance.review_notification_wakes),redispatch_grant_mail:final(ports.maintenance.grant_notification_wakes),redispatch_webhook_mail:final(ports.maintenance.webhook_notification_wakes),redispatch_retention:final(planProjectRetentionPage),redispatch_cleanup:redispatch.redispatchMediaCleanupPage,redispatch_restore_cleanup:redispatch.redispatchRestoredCleanupPage
 }});
 return {maintenance,restore,
  async scheduled(input:{cadence:"hourly"|"daily";scheduledAt:Date;admissionState:"open"|"closed"|"fenced"}){if(input.admissionState==="fenced")return;await maintenance.start(input);},
  async run(reference:ExecutionDispatchReference):Promise<{kind:"complete"}|{kind:"sleep";dueAt:Date}>{
   if(reference.kind==="operation_driver"&&reference.subject.kind==="upload_session")return upload.run(reference);
   if(reference.kind!=="maintenance"||reference.subject.kind!=="maintenance")throw Error("maintenance_reference_invalid");
   if(reference.subject.id.startsWith("mt1.")){await maintenance.run(reference);return {kind:"complete"};}
   if(reference.subject.id.startsWith("rs2.")){await restore.run(reference);return {kind:"complete"};}
   if(reference.subject.id.startsWith("pr1."))return retention.run(reference);
   if(reference.subject.id.startsWith("pw1."))return pendingWorkspace.run(reference);
   throw Error("maintenance_reference_invalid");
  }
 };
}
