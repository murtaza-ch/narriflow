import { randomUUID } from "node:crypto";
import {
  defaultUploadSessionConfig,
  UploadSessionAdmissionClaimLostError,
  UploadSessionReconciliationClaimLostError,
  UploadSessionStorageProbeError,
  type UploadSessionModuleDependencies,
  type UploadSessionPersistence,
  type UploadSessionRecord,
  type UploadSessionStorage,
} from "./upload-session.service";

export function createInMemoryUploadSessionHarness() {
  const sessions: UploadSessionRecord[] = [];
  const providerInitiations: Array<{
    storageKey: string;
    providerUploadId: string;
  }> = [];
  const projects: Array<Record<string, unknown>> = [];
  const contentPacks: Array<Record<string, unknown>> = [];
  const ingestJobs: Array<Record<string, unknown>> = [];
  const uploadedParts = new Map<
    string,
    Array<{ partNumber: number; etag: string }>
  >();
  const providerUploads = new Map<
    string,
    {
      storageKey: string;
      contentType: string;
      sizeBytes: number;
      initiatedAt: Date;
    }
  >();
  const exactObjects = new Map<
    string,
    { sizeBytes: number; contentType: string }
  >();
  let sequence = 0;
  let quotaChecks = 0;
  let brandResolutions = 0;
  let providerCompletions = 0;
  let objectProbes = 0;
  let singlePuts = 0;
  let exactKeyListings = 0;
  let multipartPartListings = 0;
  let objectDeletes = 0;
  let failProviderBinding = false;
  let quotaFailure: Error | null = null;
  let providerCreationFailure: Error | null = null;
  let providerCompletionFailure: { error: Error; afterObjectCreation: boolean } | null =
    null;
  let handoffFailure: Error | null = null;
  let nextProviderIdentity: string | null = null;
  let providerAbortFailure: Error | null = null;
  let objectProbeFailure:
    | "missing"
    | "access_denied"
    | "invalid_metadata"
    | "unavailable"
    | null = null;
  const providerAborts: string[] = [];

  const persistence: UploadSessionPersistence = {
    async findByClientKey({ workspaceId, clientIdempotencyKey }) {
      return (
        sessions.find(
          (session) =>
            session.workspaceId === workspaceId &&
            session.clientIdempotencyKey === clientIdempotencyKey,
        ) ?? null
      );
    },
    async reserve(record) {
      const existing = sessions.find(
        (session) =>
          session.workspaceId === record.workspaceId &&
          session.clientIdempotencyKey === record.clientIdempotencyKey,
      );
      if (existing) return { created: false, session: existing };
      sessions.push(record);
      return { created: true, session: record };
    },
    async claimAdmission({
      sessionId,
      admissionAttemptId,
      claimExpiresAt,
      updatedAt,
    }) {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (!session) throw new Error("Upload Session reservation not found");
      const canClaim =
        session.status === "initiating" &&
        !session.providerUploadId &&
        (!session.admissionClaimExpiresAt ||
          session.admissionClaimExpiresAt.getTime() <= updatedAt.getTime());
      if (canClaim) {
        session.admissionAttemptId = admissionAttemptId;
        session.admissionClaimExpiresAt = claimExpiresAt;
        session.updatedAt = updatedAt;
      }
      return { claimed: canClaim, session };
    },
    async prepareAdmission({
      sessionId,
      admissionAttemptId,
      brandTemplateId,
      brandSnapshot,
      updatedAt,
    }) {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (!session) throw new Error("Upload Session reservation not found");
      if (
        session.status !== "initiating" ||
        session.admissionAttemptId !== admissionAttemptId
      ) {
        throw new UploadSessionAdmissionClaimLostError();
      }
      session.brandTemplateId = brandTemplateId;
      session.brandSnapshot = brandSnapshot;
      session.admissionPreparedAt = updatedAt;
      session.updatedAt = updatedAt;
      return session;
    },
    async waitForAdmission(sessionId) {
      for (let attempt = 0; attempt < 1_200; attempt += 1) {
        const session = sessions.find((candidate) => candidate.id === sessionId);
        if (!session) throw new Error("Upload Session reservation not found");
        if (session.status !== "initiating" || session.providerUploadId) {
          return session;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (!session) throw new Error("Upload Session reservation not found");
      return session;
    },
    async bindMultipartProvider({
      sessionId,
      admissionAttemptId,
      providerUploadId,
      updatedAt,
    }) {
      if (failProviderBinding) {
        failProviderBinding = false;
        throw new Error("injected provider bind loss");
      }
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (!session) throw new Error("Upload Session reservation not found");
      if (
        session.status !== "initiating" ||
        session.providerUploadId ||
        session.admissionAttemptId !== admissionAttemptId
      ) {
        if (session.providerUploadId) return session;
        throw new UploadSessionAdmissionClaimLostError();
      }
      session.providerUploadId = providerUploadId;
      session.status = "uploading";
      session.admissionAttemptId = null;
      session.admissionClaimExpiresAt = null;
      session.updatedAt = updatedAt;
      return session;
    },
    async markSingleReady({ sessionId, admissionAttemptId, updatedAt }) {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (!session) throw new Error("Upload Session reservation not found");
      if (
        session.status !== "initiating" ||
        session.admissionAttemptId !== admissionAttemptId
      ) {
        throw new UploadSessionAdmissionClaimLostError();
      }
      session.status = "uploading";
      session.admissionAttemptId = null;
      session.admissionClaimExpiresAt = null;
      session.updatedAt = updatedAt;
      return session;
    },
    async releaseAdmissionClaim({
      sessionId,
      admissionAttemptId,
      updatedAt,
    }) {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (!session) throw new Error("Upload Session reservation not found");
      if (
        session.status === "initiating" &&
        session.admissionAttemptId === admissionAttemptId
      ) {
        session.admissionClaimExpiresAt = updatedAt;
        session.updatedAt = updatedAt;
      }
    },
    async findByIdForWorkspace({ sessionId, workspaceId }) {
      return (
        sessions.find(
          (session) =>
            session.id === sessionId && session.workspaceId === workspaceId,
        ) ?? null
      );
    },
    async renewTransferActivity({ sessionId, expiresAt, updatedAt }) {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (!session) throw new Error("Upload Session reservation not found");
      if (session.status !== "uploading") {
        throw new Error("Upload Session cannot accept transfer activity");
      }
      session.expiresAt = expiresAt;
      session.updatedAt = updatedAt;
      return session;
    },
    async beginFinalization({ sessionId, parts, reconcileAt, updatedAt }) {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (!session) throw new Error("Upload Session reservation not found");
      if (session.status !== "uploading") {
        return { claimed: false, session };
      }
      session.status = "finalizing";
      session.completionParts = parts;
      session.completionIntentMalformed = false;
      session.reconcileAt = reconcileAt;
      session.updatedAt = updatedAt;
      return { claimed: true, session };
    },
    async waitForFinalization(sessionId) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const session = sessions.find((candidate) => candidate.id === sessionId);
        if (!session) throw new Error("Upload Session reservation not found");
        if (session.status !== "finalizing") return session;
        await Promise.resolve();
      }
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (!session) throw new Error("Upload Session reservation not found");
      return session;
    },
    async handoff({
      sessionId,
      queuedJobId,
      verifiedSizeBytes,
      verifiedContentType,
      reconciliationAttemptId,
      updatedAt,
    }) {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (!session) throw new Error("Upload Session reservation not found");
      if (session.status === "queued_for_ingest") return session;
      if (
        reconciliationAttemptId &&
        session.reconciliationAttemptId !== reconciliationAttemptId
      ) {
        throw new UploadSessionReconciliationClaimLostError();
      }
      if (handoffFailure) {
        const error = handoffFailure;
        handoffFailure = null;
        throw error;
      }
      const generation = session.generation as {
        languageCode: string;
        contentPack: Record<string, unknown>;
      };
      projects.push({
        id: session.preallocatedProjectId,
        userId: session.legacyOwnerUserId,
        workspaceId: session.workspaceId,
        createdByUserId: session.actorUserId,
        updatedByUserId: session.actorUserId,
        title: session.title,
        sourceInput: session.fileName,
        sourceStorageKey: session.storageKey,
        sourceMimeType: verifiedContentType,
        sourceSizeBytes: verifiedSizeBytes,
        languageCode: generation.languageCode,
        ingestStatus: "queued",
        brandTemplateId: session.brandTemplateId,
        brandSnapshot: session.brandSnapshot,
      });
      contentPacks.push({
        projectId: session.preallocatedProjectId,
        ...generation.contentPack,
      });
      ingestJobs.push({
        id: queuedJobId,
        projectId: session.preallocatedProjectId,
        jobType: "upload_finalize",
        payload: {
          storageKey: session.storageKey,
          verifiedSizeBytes,
          verifiedContentType,
          uploadSessionId: session.id,
        },
      });
      session.status = "queued_for_ingest";
      session.queuedJobId = queuedJobId;
      session.reconcileAt = null;
      session.reconciliationAttemptId = null;
      session.reconciliationLeaseExpiresAt = null;
      session.updatedAt = updatedAt;
      return session;
    },
    async recordFailure({
      sessionId,
      admissionAttemptId,
      status,
      failureCode,
      cleanupRetryAt,
      updatedAt,
    }) {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (!session) throw new Error("Upload Session reservation not found");
      if (
        admissionAttemptId &&
        session.admissionAttemptId !== admissionAttemptId
      ) {
        throw new UploadSessionAdmissionClaimLostError();
      }
      session.status = status;
      session.failureCode = failureCode;
      session.cleanupRetryAt = cleanupRetryAt ?? null;
      session.admissionAttemptId = null;
      session.admissionClaimExpiresAt = null;
      session.updatedAt = updatedAt;
      return session;
    },
    async recordCleanupRetry({
      sessionId,
      failureCode,
      cleanupRetryAt,
      updatedAt,
    }) {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (!session) throw new Error("Upload Session reservation not found");
      session.failureCode = failureCode;
      session.cleanupRetryAt = cleanupRetryAt;
      session.updatedAt = updatedAt;
      return session;
    },
    async markReconciling({
      sessionId,
      failureCode,
      reconcileAt,
      reconciliationAttemptId,
      updatedAt,
    }) {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (!session) throw new Error("Upload Session reservation not found");
      if (
        reconciliationAttemptId &&
        session.reconciliationAttemptId !== reconciliationAttemptId
      ) {
        return session;
      }
      if (session.status !== "finalizing" && session.status !== "reconciling") {
        return session;
      }
      session.status = "reconciling";
      session.failureCode = failureCode;
      session.reconcileAt = reconcileAt;
      session.reconciliationAttemptId = null;
      session.reconciliationLeaseExpiresAt = null;
      session.updatedAt = updatedAt;
      return session;
    },
    async findDueReconciliation({ now, limit }) {
      return sessions
        .filter(
          (session) =>
            ((session.status === "initiating" &&
              !!session.admissionClaimExpiresAt &&
              session.admissionClaimExpiresAt.getTime() <= now.getTime()) ||
              (session.status === "uploading" &&
              session.expiresAt.getTime() <= now.getTime()) ||
              (["finalizing", "reconciling", "compensating"] as const).includes(
                session.status as "finalizing" | "reconciling" | "compensating",
              )) &&
            (session.status === "uploading" ||
              !session.reconcileAt ||
              session.reconcileAt.getTime() <= now.getTime()) &&
            (!session.reconciliationLeaseExpiresAt ||
              session.reconciliationLeaseExpiresAt.getTime() <= now.getTime()),
        )
        .sort((left, right) => left.updatedAt.getTime() - right.updatedAt.getTime())
        .slice(0, limit);
    },
    async claimReconciliation({
      sessionId,
      reconciliationAttemptId,
      leaseExpiresAt,
      updatedAt,
    }) {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (!session) throw new Error("Upload Session reservation not found");
      const claimed =
        ((session.status === "initiating" &&
          !!session.admissionClaimExpiresAt &&
          session.admissionClaimExpiresAt.getTime() <= updatedAt.getTime()) ||
          (session.status === "uploading" &&
          session.expiresAt.getTime() <= updatedAt.getTime()) ||
          ["finalizing", "reconciling", "compensating"].includes(
            session.status,
          )) &&
        (session.status === "uploading" || !session.reconcileAt ||
          session.reconcileAt.getTime() <= updatedAt.getTime()) &&
        (!session.reconciliationLeaseExpiresAt ||
          session.reconciliationLeaseExpiresAt.getTime() <= updatedAt.getTime());
      if (claimed) {
        session.reconciliationAttemptId = reconciliationAttemptId;
        session.reconciliationLeaseExpiresAt = leaseExpiresAt;
        session.reconciliationAttemptCount += 1;
        session.updatedAt = updatedAt;
      }
      return { claimed, session };
    },
    async releaseReconciliation({
      sessionId,
      reconciliationAttemptId,
      updatedAt,
    }) {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (!session) throw new Error("Upload Session reservation not found");
      if (session.reconciliationAttemptId !== reconciliationAttemptId) {
        throw new UploadSessionReconciliationClaimLostError();
      }
      session.reconciliationAttemptId = null;
      session.reconciliationLeaseExpiresAt = null;
      session.reconcileAt = null;
      session.updatedAt = updatedAt;
      return session;
    },
    async beginCompensation({
      sessionId,
      reconciliationAttemptId,
      failureCode,
      updatedAt,
    }) {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (!session) throw new Error("Upload Session reservation not found");
      if (
        session.reconciliationAttemptId !== reconciliationAttemptId ||
        !["initiating", "uploading", "finalizing", "reconciling"].includes(
          session.status,
        )
      ) {
        throw new UploadSessionReconciliationClaimLostError();
      }
      session.status = "compensating";
      session.failureCode = failureCode;
      session.updatedAt = updatedAt;
      return session;
    },
    async settleTerminal({
      sessionId,
      reconciliationAttemptId,
      status,
      failureCode,
      updatedAt,
    }) {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (!session) throw new Error("Upload Session reservation not found");
      if (session.reconciliationAttemptId !== reconciliationAttemptId) {
        throw new UploadSessionReconciliationClaimLostError();
      }
      session.status = status;
      session.failureCode = failureCode;
      session.reconcileAt = null;
      session.reconciliationAttemptId = null;
      session.reconciliationLeaseExpiresAt = null;
      session.updatedAt = updatedAt;
      return session;
    },
    async deferReconciliation({
      sessionId,
      reconciliationAttemptId,
      failureCode,
      reconcileAt,
      updatedAt,
    }) {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (!session) throw new Error("Upload Session reservation not found");
      if (session.reconciliationAttemptId !== reconciliationAttemptId) {
        throw new UploadSessionReconciliationClaimLostError();
      }
      session.failureCode = failureCode;
      session.reconcileAt = reconcileAt;
      session.reconciliationAttemptId = null;
      session.reconciliationLeaseExpiresAt = null;
      session.updatedAt = updatedAt;
      return session;
    },
  };

  const storage: UploadSessionStorage = {
    async grantSinglePut() {
      return { url: "https://upload.invalid/single" };
    },
    async createMultipart({ storageKey, contentType, metadata }) {
      if (providerCreationFailure) {
        const error = providerCreationFailure;
        providerCreationFailure = null;
        throw error;
      }
      sequence += 1;
      const providerUploadId =
        nextProviderIdentity ?? `opaque/provider/${sequence}`;
      nextProviderIdentity = null;
      providerInitiations.push({ storageKey, providerUploadId });
      providerUploads.set(providerUploadId, {
        storageKey,
        contentType,
        sizeBytes: Number(metadata.file_size_bytes ?? 0),
        initiatedAt: new Date(
          `2026-08-27T00:00:${String(sequence).padStart(2, "0")}.000Z`,
        ),
      });
      return { providerUploadId };
    },
    async grantMultipartParts({ partNumbers }) {
      return partNumbers.map((partNumber) => ({
        partNumber,
        url: `https://upload.invalid/part/${partNumber}`,
      }));
    },
    async completeMultipart({ storageKey, providerUploadId, parts }) {
      const provider = providerUploads.get(providerUploadId);
      if (!provider || provider.storageKey !== storageKey) {
        throw new Error("NoSuchUpload");
      }
      const uploaded = uploadedParts.get(providerUploadId) ?? [];
      if (JSON.stringify(uploaded) !== JSON.stringify(parts)) {
        throw new Error("InvalidPart");
      }
      providerCompletions += 1;
      if (!providerCompletionFailure || providerCompletionFailure.afterObjectCreation) {
        exactObjects.set(storageKey, {
          sizeBytes: provider.sizeBytes,
          contentType: provider.contentType,
        });
      }
      if (providerCompletionFailure) {
        const failure = providerCompletionFailure.error;
        providerCompletionFailure = null;
        throw failure;
      }
    },
    async listMultipartParts({ storageKey, providerUploadId }) {
      multipartPartListings += 1;
      const provider = providerUploads.get(providerUploadId);
      if (!provider || provider.storageKey !== storageKey) {
        throw new Error("NoSuchUpload");
      }
      return uploadedParts.get(providerUploadId) ?? [];
    },
    async headExactObject(storageKey) {
      objectProbes += 1;
      if (objectProbeFailure) {
        const disposition = objectProbeFailure;
        objectProbeFailure = null;
        throw new UploadSessionStorageProbeError(disposition);
      }
      const object = exactObjects.get(storageKey);
      if (!object) throw new UploadSessionStorageProbeError("missing");
      return object;
    },
    async headExactObjectIfExists(storageKey) {
      objectProbes += 1;
      if (objectProbeFailure) {
        const disposition = objectProbeFailure;
        objectProbeFailure = null;
        if (disposition === "missing") return null;
        throw new UploadSessionStorageProbeError(disposition);
      }
      return exactObjects.get(storageKey) ?? null;
    },
    async listExactKeyMultipartUploads(storageKey) {
      exactKeyListings += 1;
      return Array.from(providerUploads, ([providerUploadId, upload]) => ({
        providerUploadId,
        initiatedAt: upload.initiatedAt,
        storageKey: upload.storageKey,
      }))
        .filter((upload) => upload.storageKey === storageKey)
        .map(({ providerUploadId, initiatedAt }) => ({
          providerUploadId,
          initiatedAt,
        }));
    },
    async abortMultipart({ storageKey, providerUploadId }) {
      if (providerAbortFailure) {
        const error = providerAbortFailure;
        providerAbortFailure = null;
        throw error;
      }
      const upload = providerUploads.get(providerUploadId);
      if (!upload || upload.storageKey !== storageKey) return;
      providerAborts.push(providerUploadId);
      providerUploads.delete(providerUploadId);
    },
    async deleteExactObject(storageKey) {
      objectDeletes += 1;
      exactObjects.delete(storageKey);
    },
  };

  return {
    adapters: {
      config: defaultUploadSessionConfig(),
      persistence,
      storage,
      admission: {
        async assertQuota() {
          quotaChecks += 1;
          if (quotaFailure) throw quotaFailure;
        },
        async resolveBrand() {
          brandResolutions += 1;
          return null;
        },
      },
      now: () => new Date("2026-08-27T00:00:00.000Z"),
      createId: randomUUID,
      random: () => 0.5,
    } satisfies UploadSessionModuleDependencies,
    facts: {
      sessions,
      providerInitiations,
      projects,
      get quotaChecks() {
        return quotaChecks;
      },
      get brandResolutions() {
        return brandResolutions;
      },
      contentPacks,
      ingestJobs,
      get providerCompletions() {
        return providerCompletions;
      },
      get objectProbes() {
        return objectProbes;
      },
      get singlePuts() {
        return singlePuts;
      },
      get exactKeyListings() {
        return exactKeyListings;
      },
      get multipartPartListings() {
        return multipartPartListings;
      },
      get objectDeletes() {
        return objectDeletes;
      },
      providerAborts,
      get unfinishedProviderUploads() {
        return Array.from(providerUploads.keys()).sort();
      },
    },
    uploadMultipartParts(
      sessionId: string,
      parts: Array<{ partNumber: number; etag: string }>,
    ) {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (!session?.providerUploadId) {
        throw new Error("Upload Session provider binding not found");
      }
      uploadedParts.set(session.providerUploadId, parts);
      const provider = providerUploads.get(session.providerUploadId);
      if (provider) provider.sizeBytes = session.fileSizeBytes;
    },
    putSingleObject(
      sessionId: string,
      object: { sizeBytes: number; contentType: string },
    ) {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (!session || session.transferKind !== "single") {
        throw new Error("Single-transfer Upload Session not found");
      }
      singlePuts += 1;
      exactObjects.set(session.storageKey, object);
    },
    failNextProviderBinding() {
      failProviderBinding = true;
    },
    failQuota(error: Error) {
      quotaFailure = error;
    },
    failNextProviderCreation(error: Error) {
      providerCreationFailure = error;
    },
    failNextProviderCompletion(error: Error, afterObjectCreation = false) {
      providerCompletionFailure = { error, afterObjectCreation };
    },
    failNextHandoff(error: Error) {
      handoffFailure = error;
    },
    returnNextProviderIdentity(providerUploadId: string) {
      nextProviderIdentity = providerUploadId;
    },
    failNextProviderAbort(error: Error) {
      providerAbortFailure = error;
    },
    failNextObjectProbe(
      disposition:
        | "missing"
        | "access_denied"
        | "invalid_metadata"
        | "unavailable",
    ) {
      objectProbeFailure = disposition;
    },
    createDuplicateUnfinishedUpload(sessionId: string) {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (!session) throw new Error("Upload Session not found");
      const providerUploadId = `opaque/provider/${++sequence}`;
      providerUploads.set(providerUploadId, {
        storageKey: session.storageKey,
        contentType: session.contentType,
        sizeBytes: 0,
        initiatedAt: new Date(
          `2026-08-27T00:00:${String(sequence).padStart(2, "0")}.000Z`,
        ),
      });
      providerInitiations.push({
        storageKey: session.storageKey,
        providerUploadId,
      });
    },
  };
}
