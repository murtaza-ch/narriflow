import {
  adoptHeldMediaCleanupObligations,
  admitMediaCleanupObligations,
  type HeldMediaCleanupAdoptionStore,
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
  store: HeldMediaCleanupAdoptionStore,
  plan: ExportBundleCleanupPlan,
  now: Date,
): Promise<void> {
  await adoptHeldMediaCleanupObligations(
    store,
    [publicationIdentity(plan)],
    plan.attemptId,
    now,
    EXPORT_BUNDLE_PUBLICATION_RECEIPT,
  );
}
