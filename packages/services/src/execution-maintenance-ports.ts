import type { PrismaClient } from "@prisma/client";
import type { MaintenancePhaseHandler } from "./execution-maintenance";
import type { ExecutionRestorePhaseHandler } from "./execution-restore";
import type { ClipSelectionStorage } from "./clip-selection-preparation";

/** Every slot is an actual bounded Tx-only domain planner. No absent adapter
 * can become a successful empty phase. Native/provider I/O is elsewhere. */
export interface ExecutionMaintenanceExternalPorts {
  maintenance: Record<"finishing_wakes" | "publication_wakes" | "publication_receipts" | "publication_captures" | "bundle_wakes" | "dubbing_wakes" | "grants" | "bundle_expiry", MaintenancePhaseHandler>;
  restore: Record<"finishing" | "publication" | "bundle" | "dubbing", ExecutionRestorePhaseHandler>;
}
export interface ExecutionMaintenanceRuntimeOptions {
  database: PrismaClient;
  register(dispatchIds: readonly string[]): Promise<void>;
  ports: ExecutionMaintenanceExternalPorts;
  /** Shared bounded If-Match JSON object reader and immutable writer. */
  storage: ClipSelectionStorage;
  toolchainFingerprint: string;
}
