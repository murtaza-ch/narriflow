import type { ProjectRetentionExecutionDependencies } from "./project-retention-execution";
import type { UploadSessionRecord } from "./upload-session.service";
import type { PrismaClient } from "@prisma/client";
import type { MaintenancePhaseHandler } from "./execution-maintenance";
import type { ExecutionRestorePhaseHandler } from "./execution-restore";
import type { PrivateJsonStorage } from "./private-json-storage";
import type { ClipSelectionStorage } from "./clip-selection-preparation";

/** Every slot is an actual bounded Tx-only domain planner. No absent adapter
 * can become a successful empty phase. Native/provider I/O is elsewhere. */
export interface ExecutionMaintenanceExternalPorts {
  maintenance: Record<"finishing_wakes" | "publication_wakes" | "publication_receipts" | "publication_captures" | "bundle_wakes" | "dubbing_wakes" | "grants" | "bundle_expiry" | "autopilot_wakes" | "zoom_notification_wakes" | "notification_wakes" | "review_notification_wakes" | "grant_notification_wakes" | "grant_authority" | "webhook_notification_wakes", MaintenancePhaseHandler>;
  redispatch: Record<"publication_receipts" | "publication_captures" | "grants", MaintenancePhaseHandler> & {publication_guidance:ExecutionRestorePhaseHandler};
  restore: Record<"finishing" | "publication" | "bundle" | "dubbing" | "autopilot" | "zoom_notifications" | "notifications" | "review_notifications" | "grant_notifications" | "webhook_notifications", ExecutionRestorePhaseHandler>;
}
export interface ExecutionMaintenanceRuntimeOptions {
  database: PrismaClient;
  register(dispatchIds: readonly string[]): Promise<void>;
  ports: ExecutionMaintenanceExternalPorts;
  /** Shared bounded If-Match JSON object reader and immutable writer. */
  storage: { selection: ClipSelectionStorage; privateJson: PrivateJsonStorage };
  toolchainFingerprint: string;
  upload: {reconcile(id:string,epoch:number,beforeProvider:(session:UploadSessionRecord)=>Promise<void>,beforeHttp:()=>Promise<void>):Promise<unknown>};
  pendingWorkspace: {expire(id:string,epoch:number):Promise<boolean>};
  retention: Pick<ProjectRetentionExecutionDependencies,"writeDeletionReceipt"|"releaseUsage">;
}
