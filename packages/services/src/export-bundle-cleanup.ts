import {
  adoptHeldMediaCleanupObligations,
  admitMediaCleanupObligations,
  releaseHeldMediaCleanupObligations,
  renewHeldMediaCleanupObligations,
  type HeldMediaCleanupAdoptionStore,
  type HeldMediaCleanupReleaseStore,
  type HeldMediaCleanupRenewalStore,
  type MediaCleanupAdmissionStore,
  type MediaCleanupObligationIdentity,
  type MediaCleanupObligationInput,
} from "./media-cleanup";

export const EXPORT_BUNDLE_CLEANUP_HOLD_MS = 24 * 60 * 60 * 1000;
const EXPORT_BUNDLE_PUBLICATION_RECEIPT = "export_bundle_published";

export type ExportBundleCleanupPlan = {
  attemptId: string;
  claimExpiresAt: Date;
  obligations: [
    MediaCleanupObligationInput,
    MediaCleanupObligationInput,
  ];
};

export type ExpiredExportBundle = {
  id: string;
  projectId: string;
  storageKey: string;
};

export interface ExpiredExportBundleRetirementStore {
  mediaCleanupObligation: MediaCleanupAdmissionStore;
  exportBundle: {
    updateMany(input: {
      where: {
        id: string;
        status: "completed";
        storageKey: string;
      };
      data: { status: "expired"; storageKey: null };
    }): Promise<{ count: number }>;
  };
}

export function exportBundleStorageKeys(
  projectId: string,
  operationId: string,
  attemptId: string,
) {
  const prefix = `projects/${projectId}/campaign-operations/${operationId}`;
  return {
    attemptKey: `${prefix}/attempts/${attemptId}.zip`,
    finalKey: `${prefix}/completed/${attemptId}.zip`,
  };
}

export function planExportBundleCleanup(
  projectId: string,
  operationId: string,
  attemptId: string,
  now: Date,
): ExportBundleCleanupPlan {
  const keys = exportBundleStorageKeys(projectId, operationId, attemptId);
  return {
    attemptId,
    claimExpiresAt: new Date(now.getTime() + EXPORT_BUNDLE_CLEANUP_HOLD_MS),
    obligations: [
      {
        origin: "export_bundle_attempt",
        cleanupClass: "export_bundle_attempt",
        projectId,
        objectKey: keys.attemptKey,
      },
      {
        origin: "export_bundle_attempt",
        cleanupClass: "export_bundle_unsettled_publication",
        projectId,
        objectKey: keys.finalKey,
      },
    ],
  };
}

export function planExpiredExportBundleCleanup(
  bundle: ExpiredExportBundle,
  now: Date,
): MediaCleanupObligationInput {
  return {
    origin: "export_bundle_expiry",
    cleanupClass: "expired_export_bundle",
    projectId: bundle.projectId,
    objectKey: bundle.storageKey,
    nextAttemptAt: now,
  };
}

/** Must run in the same transaction that removes ExportBundle.storageKey. */
export async function retireExpiredExportBundle(
  store: ExpiredExportBundleRetirementStore,
  bundle: ExpiredExportBundle,
  now: Date,
): Promise<number> {
  await admitMediaCleanupObligations(store.mediaCleanupObligation, [
    planExpiredExportBundleCleanup(bundle, now),
  ]);
  return (
    await store.exportBundle.updateMany({
      where: {
        id: bundle.id,
        status: "completed",
        storageKey: bundle.storageKey,
      },
      data: { status: "expired", storageKey: null },
    })
  ).count;
}

/** Must commit before either remote object can be written. */
export async function admitExportBundleCleanup(
  store: MediaCleanupAdmissionStore,
  plan: ExportBundleCleanupPlan,
): Promise<void> {
  const admitted = await admitMediaCleanupObligations(
    store,
    plan.obligations,
    {
      heldClaim: {
        claimId: plan.attemptId,
        claimExpiresAt: plan.claimExpiresAt,
      },
    },
  );
  if (admitted !== plan.obligations.length) {
    throw new Error("export_bundle_cleanup_admission_conflict");
  }
}

function publicationIdentity(
  plan: ExportBundleCleanupPlan,
): MediaCleanupObligationIdentity {
  const publication = plan.obligations[1];
  return {
    origin: publication.origin,
    cleanupClass: publication.cleanupClass,
    objectKey: publication.objectKey,
  };
}

/** Must share the transaction that publishes ExportBundle.storageKey. */
export async function adoptExportBundlePublication(
  store: HeldMediaCleanupAdoptionStore & HeldMediaCleanupRenewalStore,
  plan: ExportBundleCleanupPlan,
  now: Date,
): Promise<void> {
  await renewExportBundleCleanup(store, plan, now);
  await adoptHeldMediaCleanupObligations(
    store,
    [publicationIdentity(plan)],
    plan.attemptId,
    now,
    EXPORT_BUNDLE_PUBLICATION_RECEIPT,
  );
}

export async function releaseExportBundleCleanup(
  store: HeldMediaCleanupReleaseStore,
  plan: ExportBundleCleanupPlan,
  obligations: readonly MediaCleanupObligationInput[],
  now: Date,
): Promise<number> {
  return releaseHeldMediaCleanupObligations(
    store,
    obligations.map((obligation) => ({
      origin: obligation.origin,
      cleanupClass: obligation.cleanupClass,
      objectKey: obligation.objectKey,
    })),
    plan.attemptId,
    now,
    "export_bundle_ready_for_cleanup",
  );
}

export async function renewExportBundleCleanup(
  store: HeldMediaCleanupRenewalStore,
  plan: ExportBundleCleanupPlan,
  now: Date,
): Promise<Date> {
  const claimExpiresAt = new Date(
    now.getTime() + EXPORT_BUNDLE_CLEANUP_HOLD_MS,
  );
  await renewHeldMediaCleanupObligations(
    store,
    plan.obligations.map(({ origin, cleanupClass, objectKey }) => ({
      origin,
      cleanupClass,
      objectKey,
    })),
    plan.attemptId,
    now,
    claimExpiresAt,
  );
  return claimExpiresAt;
}
