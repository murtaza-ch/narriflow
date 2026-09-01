import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  createReviewRoundSchema,
  internalReviewCommentSchema,
  reviewCommentEditSchema,
  reviewCommentSchema,
  reviewDecisionSchema,
  reviewGuestAccessSchema,
  reviewSelectedVariantIdsSchema,
  type CreateReviewRoundInput,
  type PricingTier,
} from "@narriflow/validators";
import { hasFeature } from "./plan-features";
import { ProgramWriteDisabledError } from "./program-rollout";
import { checkRateLimit } from "./rate-limit";
import { presignDownloadUrl } from "./r2-storage";
import { frozenProjectApprovalRequired } from "./review-project-policy";
import {
  reviewRolloutPolicy,
  type ReviewRolloutPolicy,
} from "./review-rollout";

const REVIEW_SESSION_TTL_SEC = 12 * 60 * 60;
const REVIEW_COMMENT_EDIT_WINDOW_MS = 15 * 60_000;
const REVIEW_ACCESS_WINDOW_MS = 15 * 60_000;
const REVIEW_ACCESS_LIMIT = 8;
const ARGON2ID_ALGORITHM = 2 as const;
const localAccessAttempts = new Map<string, { count: number; resetAt: number }>();

export class ReviewServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ReviewServiceError";
  }
}

type ReviewNotificationRetrySourceRow = {
  id: string;
  reviewRoundId: string;
  recipientId: string;
  kind: string;
  status: string;
};

type ReviewNotificationRetryStore = {
  readSource(input: {
    workspaceId: string;
    projectId: string;
    roundId: string;
    notificationId: string;
  }): Promise<ReviewNotificationRetrySourceRow | null>;
  findRetry(input: {
    reviewRoundId: string;
    recipientId: string;
    kind: string;
    sourceKey: string;
  }): Promise<{ id: string; status: string } | null>;
  reserveRetry(input: {
    id: string;
    source: ReviewNotificationRetrySourceRow;
    sourceKey: string;
  }): Promise<{
    notification: { id: string; status: string };
    created: boolean;
  }>;
  recordRetryAudit(input: {
    actorUserId: string;
    reviewRoundId: string;
    sourceNotificationId: string;
    retryNotificationId: string;
  }): Promise<void>;
};

export function reviewNotificationRetrySource(
  notificationId: string,
  idempotencyKey: string,
) {
  return `review-retry:${notificationId}:${idempotencyKey}`;
}

export function reviewNotificationRetrySourceId(sourceKey: string) {
  const [prefix, notificationId, idempotencyKey, ...extra] =
    sourceKey.split(":");
  return prefix === "review-retry" &&
    notificationId &&
    idempotencyKey &&
    extra.length === 0
    ? notificationId
    : null;
}

export async function retryReviewNotification(
  store: ReviewNotificationRetryStore,
  input: {
    scope: {
      actorUserId: string;
      workspaceId: string;
      projectId: string;
    };
    roundId: string;
    notificationId: string;
    idempotencyKey: string;
    createId(): string;
  },
) {
  const source = await store.readSource({
    workspaceId: input.scope.workspaceId,
    projectId: input.scope.projectId,
    roundId: input.roundId,
    notificationId: input.notificationId,
  });
  if (!source || source.reviewRoundId !== input.roundId) {
    throw new ReviewServiceError(
      "review_notification_not_retryable",
      "Review notification is not retryable",
    );
  }
  const sourceKey = reviewNotificationRetrySource(
    source.id,
    input.idempotencyKey,
  );
  const replay = await store.findRetry({
    reviewRoundId: source.reviewRoundId,
    recipientId: source.recipientId,
    kind: source.kind,
    sourceKey,
  });
  if (replay) return { notificationId: replay.id, replayed: true };
  if (source.status !== "failed") {
    throw new ReviewServiceError(
      "review_notification_not_retryable",
      "Review notification is not retryable",
    );
  }
  const reservation = await store.reserveRetry({
    id: input.createId(),
    source,
    sourceKey,
  });
  if (reservation.created) {
    await store.recordRetryAudit({
      actorUserId: input.scope.actorUserId,
      reviewRoundId: source.reviewRoundId,
      sourceNotificationId: source.id,
      retryNotificationId: reservation.notification.id,
    });
  }
  return {
    notificationId: reservation.notification.id,
    replayed: !reservation.created,
  };
}

export function deriveReviewRoundStatus(round: {
  status: string;
  revokedAt: Date | null;
  expiresAt: Date | null;
  decision: string | null;
  items: Array<{ currentDecision: string | null }>;
}, now = new Date()) {
  if (round.revokedAt) return "revoked";
  if (round.status === "superseded") return "superseded";
  if (round.expiresAt && round.expiresAt <= now) return "expired";
  if (round.decision === "approved") return "approved";
  if (round.decision === "changes_requested" || round.items.some((item) => item.currentDecision === "changes_requested")) return "changes_requested";
  return round.status;
}

export function reviewRoundAutomationFingerprint(input: {
  workspaceId: string;
  projectId: string;
  request: CreateReviewRoundInput;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        contract: "review-round-automation-v1",
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        request: input.request,
      }),
    )
    .digest("hex");
}

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  return prisma;
}

export function hashReviewAccessToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function deriveReviewAccessToken(roundId: string, secret: string) {
  if (secret.length < 32) {
    throw new ReviewServiceError(
      "review_access_configuration_invalid",
      "Review access secret is not configured",
    );
  }
  return createHmac("sha256", secret)
    .update(`narriflow-review-round-v1:${roundId}`)
    .digest("base64url");
}

export function hashReviewPasscode(passcode: string) {
  return argon2Hash(passcode, {
    algorithm: ARGON2ID_ALGORITHM,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 1,
    outputLen: 32,
  });
}

export function verifyReviewPasscode(passcode: string, hash: string) {
  return argon2Verify(hash, passcode);
}

type ReviewSessionClaims = { roundId: string; guestId: string; grant: string; identity: string; subject: string; exp: number };

export function hashReviewSessionGrant(subject: string) {
  return createHash("sha256").update(subject).digest("hex");
}

function encryptReviewEmail(email: string, secret: string) {
  const key = createHash("sha256").update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(email, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((value) => value.toString("base64url")).join(".");
}

export function decryptReviewEmail(value: string, secret: string) {
  const [ivPart, tagPart, encryptedPart, extra] = value.split(".");
  if (!ivPart || !tagPart || !encryptedPart || extra) {
    throw new ReviewServiceError(
      "review_recipient_invalid",
      "Review recipient data is invalid",
    );
  }
  try {
    const key = createHash("sha256").update(secret).digest();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(ivPart, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedPart, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new ReviewServiceError(
      "review_recipient_invalid",
      "Review recipient data is invalid",
    );
  }
}

function reviewEmailHash(email: string, secret: string) {
  return createHmac("sha256", secret)
    .update(email.trim().toLowerCase())
    .digest("hex");
}

function enforceLocalRateLimit(key: string, limit: number, windowMs: number, now = Date.now()) {
  const current = localAccessAttempts.get(key);
  if (!current || current.resetAt <= now) {
    if (localAccessAttempts.size >= 5_000) {
      const oldest = localAccessAttempts.keys().next().value;
      if (oldest) localAccessAttempts.delete(oldest);
    }
    localAccessAttempts.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  current.count += 1;
  if (current.count > limit) {
    throw new ReviewServiceError("review_access_rate_limited", "Too many review access attempts");
  }
}

async function enforceReviewRateLimit(key: string, limit: number, windowMs: number) {
  enforceLocalRateLimit(key, limit, windowMs);
  const distributed = await checkRateLimit(key, limit, windowMs / 1_000);
  if (!distributed.allowed) throw new ReviewServiceError("review_access_rate_limited", "Too many review requests");
}

async function withSerializableRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const retryable = error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === "P2034" || error.code === "P2002");
      if (!retryable || attempt === 2) throw error;
    }
  }
  throw lastError;
}

async function assertReviewRoundWritable(tx: Prisma.TransactionClient, roundId: string, now = new Date()) {
  const live = await tx.reviewRound.updateMany({
    where: {
      id: roundId,
      status: "open",
      revokedAt: null,
      AND: [
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        { OR: [{ decision: null }, { decision: { not: "approved" } }] },
      ],
    },
    data: { updatedAt: now },
  });
  if (live.count !== 1) {
    throw new ReviewServiceError("review_round_closed", "This review round is no longer open");
  }
}

async function recordNotificationAdmissionSuppressed(
  tx: Prisma.TransactionClient,
  input: {
    reviewRoundId: string;
    sourceId: string;
    sourceKind: string;
    recipientCount: number;
  },
) {
  await tx.reviewAuditEvent.create({
    data: {
      reviewRoundId: input.reviewRoundId,
      kind: "notification_admission_suppressed",
      targetId: input.sourceId,
      metadata: {
        sourceKind: input.sourceKind,
        recipientCount: input.recipientCount,
      },
    },
  });
}

function encodeClaims(claims: ReviewSessionClaims) {
  return Buffer.from(JSON.stringify(claims)).toString("base64url");
}

export function issueReviewSession(claims: Omit<ReviewSessionClaims, "exp">, secret: string, now = new Date()) {
  if (secret.length < 32) throw new ReviewServiceError("review_session_configuration_invalid", "Review session secret is not configured");
  const body = encodeClaims({ ...claims, exp: Math.floor(now.getTime() / 1000) + REVIEW_SESSION_TTL_SEC });
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifyReviewSession(value: string, secret: string, now = new Date()): ReviewSessionClaims {
  const [body, signature, extra] = value.split(".");
  if (!body || !signature || extra) throw new ReviewServiceError("review_session_invalid", "Review session is invalid");
  const expected = createHmac("sha256", secret).update(body).digest();
  const actual = Buffer.from(signature, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new ReviewServiceError("review_session_invalid", "Review session is invalid");
  }
  let claims: unknown;
  try { claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); }
  catch { throw new ReviewServiceError("review_session_invalid", "Review session is invalid"); }
  if (!claims || typeof claims !== "object") throw new ReviewServiceError("review_session_invalid", "Review session is invalid");
  const parsed = claims as Partial<ReviewSessionClaims>;
  if (typeof parsed.roundId !== "string" || typeof parsed.guestId !== "string" || typeof parsed.grant !== "string" || typeof parsed.identity !== "string" || typeof parsed.subject !== "string" || typeof parsed.exp !== "number" || parsed.exp < now.getTime() / 1000) {
    throw new ReviewServiceError("review_session_invalid", "Review session is invalid or expired");
  }
  return parsed as ReviewSessionClaims;
}

export class ReviewService {
  constructor(
    private readonly rolloutPolicy: ReviewRolloutPolicy = reviewRolloutPolicy,
  ) {}

  private assertCreationEnabled() {
    if (!this.rolloutPolicy.isEnabled("creation")) {
      throw new ProgramWriteDisabledError("review_rooms");
    }
  }

  private assertGuestReadEnabled() {
    if (!this.rolloutPolicy.isEnabled("guest_read")) {
      throw new ReviewServiceError(
        "review_access_temporarily_unavailable",
        "Review access is temporarily unavailable",
      );
    }
  }

  private assertFeedbackMutationEnabled() {
    if (!this.rolloutPolicy.isEnabled("feedback_mutation")) {
      throw new ReviewServiceError(
        "review_feedback_temporarily_unavailable",
        "Review feedback is temporarily unavailable",
      );
    }
  }

  private assertNotificationAdmissionEnabled() {
    if (!this.rolloutPolicy.isEnabled("notification_admission")) {
      throw new ReviewServiceError(
        "review_notifications_temporarily_unavailable",
        "Review notifications are temporarily paused",
      );
    }
  }

  async createRound(
    scope: {
      actorUserId: string;
      workspaceId: string;
      projectId: string;
      pricingTier: PricingTier;
      idempotencyKey?: string;
    },
    input: unknown,
    secrets?: { accessSecret: string; dataSecret: string },
  ) {
    this.assertCreationEnabled();
    const notificationAdmissionEnabled = this.rolloutPolicy.isEnabled(
      "notification_admission",
    );
    if (!hasFeature(scope.pricingTier, "review.rooms")) {
      throw new ReviewServiceError("review_feature_unavailable", "Review rooms are not available on this plan");
    }
    const parsed = createReviewRoundSchema.parse(input);
    const automationFingerprint = scope.idempotencyKey
      ? reviewRoundAutomationFingerprint({
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          request: parsed,
        })
      : null;
    if (scope.idempotencyKey && !secrets) {
      throw new ReviewServiceError(
        "review_automation_configuration_invalid",
        "Review automation requires deterministic access-token configuration",
      );
    }
    const prisma = requirePrisma();
    const readAutomationReplay = async () => {
      if (!scope.idempotencyKey || !automationFingerprint || !secrets) return null;
      const existing = await prisma.reviewRound.findUnique({
        where: { id: scope.idempotencyKey },
        select: {
          id: true,
          workspaceId: true,
          projectId: true,
          revision: true,
          createdAt: true,
          auditEvents: {
            where: { kind: "round_sent", targetId: scope.idempotencyKey },
            orderBy: { createdAt: "asc" },
            take: 1,
            select: { metadata: true },
          },
          notifications: {
            where: { kind: "round_sent" },
            select: { id: true },
          },
        },
      });
      if (!existing) return null;
      const metadata = existing.auditEvents[0]?.metadata;
      const recordedFingerprint =
        metadata &&
        typeof metadata === "object" &&
        !Array.isArray(metadata) &&
        typeof metadata.automationIdempotencyFingerprint === "string"
          ? metadata.automationIdempotencyFingerprint
          : null;
      if (
        existing.workspaceId !== scope.workspaceId ||
        existing.projectId !== scope.projectId ||
        recordedFingerprint !== automationFingerprint
      ) {
        throw new ReviewServiceError(
          "review_idempotency_conflict",
          "The idempotency key was already used for a different review request",
        );
      }
      const token = deriveReviewAccessToken(existing.id, secrets.accessSecret);
      return {
        id: existing.id,
        revision: existing.revision,
        createdAt: existing.createdAt,
        token,
        path: `/review/${token}`,
        notificationIds: existing.notifications.map((entry) => entry.id),
        replayed: true,
      };
    };
    const replay = await readAutomationReplay();
    if (replay) return replay;
    if (parsed.expiresAt && new Date(parsed.expiresAt) <= new Date()) {
      throw new ReviewServiceError("review_expiry_invalid", "Review expiry must be in the future");
    }
    if (new Set(parsed.items.map((item) => item.clipId)).size !== parsed.items.length) {
      throw new ReviewServiceError("review_items_duplicate", "A clip can appear only once in a review round");
    }
    const project = await prisma.project.findFirst({
      where: { id: scope.projectId, workspaceId: scope.workspaceId },
      select: {
        id: true,
        brandProfileId: true,
        brandProfileSnapshot: true,
      },
    });
    if (!project) throw new ReviewServiceError("review_project_not_found", "Project was not found");
    const exports = await prisma.clipExport.findMany({
      where: { projectId: scope.projectId, id: { in: parsed.items.map((item) => item.exportId) }, status: "ready" },
      select: { id: true, clipId: true, editorRevision: true, variants: { where: { status: "completed" }, select: { id: true } } },
    });
    const exportById = new Map(exports.map((item) => [item.id, item]));
    for (const item of parsed.items) {
      const frozen = exportById.get(item.exportId);
      const availableVariants = new Set(frozen?.variants.map((variant) => variant.id) ?? []);
      if (!frozen || frozen.clipId !== item.clipId || frozen.editorRevision !== item.expectedEditorRevision || new Set(item.variantIds).size !== item.variantIds.length || item.variantIds.some((id) => !availableVariants.has(id))) {
        throw new ReviewServiceError("review_item_stale", "A selected clip no longer matches its frozen export");
      }
    }
    const roundId = scope.idempotencyKey ?? randomUUID();
    const rawToken = secrets
      ? deriveReviewAccessToken(roundId, secrets.accessSecret)
      : randomBytes(32).toString("base64url");
    const tokenHash = hashReviewAccessToken(rawToken);
    const passcodeHash = parsed.passcode
      ? await hashReviewPasscode(parsed.passcode)
      : null;
    const reviewerEmails = [
      ...new Set(parsed.recipientEmails.map((email) => email.toLowerCase())),
    ];
    if (reviewerEmails.length > 0 && !secrets) {
      throw new ReviewServiceError(
        "review_delivery_configuration_invalid",
        "Review delivery is not configured",
      );
    }
    const actor = secrets
      ? await prisma.user.findUnique({
          where: { id: scope.actorUserId },
          select: { primaryEmail: true, emailVerifiedAt: true },
        })
      : null;
    const internalEmail =
      actor?.primaryEmail && actor.emailVerifiedAt
        ? actor.primaryEmail.trim().toLowerCase()
        : null;
    const recipientSeeds = [
      ...reviewerEmails.map((email) => ({
        id: randomUUID(),
        role: "reviewer" as const,
        email,
      })),
      ...(internalEmail
        ? [
            {
              id: randomUUID(),
              role: "internal" as const,
              email: internalEmail,
            },
          ]
        : []),
    ];
    const snapshotApprovalRequired = frozenProjectApprovalRequired(project);
    const approvalRequired =
      parsed.approvalRequired ?? snapshotApprovalRequired;
    const now = new Date();
    let round: { id: string; revision: number; createdAt: Date };
    try {
      round = await withSerializableRetry(
        () =>
          prisma.$transaction(
          async (tx) => {
            const latest = await tx.reviewRound.findFirst({
              where: { projectId: scope.projectId },
              orderBy: { revision: "desc" },
              select: { id: true, revision: true },
            });
            if (parsed.sourceRoundId) {
              const source = await tx.reviewRound.findFirst({
                where: {
                  id: parsed.sourceRoundId,
                  projectId: scope.projectId,
                  workspaceId: scope.workspaceId,
                },
                select: {
                  id: true,
                  nextRound: { select: { id: true } },
                },
              });
              if (!source) {
                throw new ReviewServiceError(
                  "review_source_round_not_found",
                  "The source review round was not found",
                );
              }
              if (source.nextRound || source.id !== latest?.id) {
                throw new ReviewServiceError(
                  "review_source_round_superseded",
                  "A newer review round already exists",
                );
              }
            }
            const previousRoundId = parsed.sourceRoundId ?? latest?.id ?? null;
            await tx.reviewRound.updateMany({
              where: { projectId: scope.projectId, status: "open" },
              data: { status: "superseded", supersededAt: now },
            });
            const created = await tx.reviewRound.create({
              data: {
                id: roundId,
                workspaceId: scope.workspaceId,
                projectId: scope.projectId,
                createdByUserId: scope.actorUserId,
                previousRoundId,
                revision: (latest?.revision ?? 0) + 1,
                title: parsed.title,
                message: parsed.message,
                allowDownloads: parsed.allowDownloads,
                approvalRequired,
                accessTokenHash: tokenHash,
                passcodeHash,
                expiresAt: parsed.expiresAt
                  ? new Date(parsed.expiresAt)
                  : null,
                items: {
                  create: parsed.items.map((item, position) => ({
                    clipId: item.clipId,
                    exportId: item.exportId,
                    editorRevision: item.expectedEditorRevision,
                    position,
                    selectedVariantIds: item.variantIds,
                    required: item.required,
                  })),
                },
                recipients:
                  secrets && recipientSeeds.length > 0
                    ? {
                        create: recipientSeeds.map((recipient) => ({
                          id: recipient.id,
                          role: recipient.role,
                          emailHash: reviewEmailHash(
                            recipient.email,
                            secrets.dataSecret,
                          ),
                          emailEncrypted: encryptReviewEmail(
                            recipient.email,
                            secrets.dataSecret,
                          ),
                        })),
                      }
                    : undefined,
              },
              select: { id: true, revision: true, createdAt: true },
            });
            const reviewerRecipients = recipientSeeds.filter(
              (recipient) => recipient.role === "reviewer",
            );
            if (
              notificationAdmissionEnabled &&
              reviewerRecipients.length > 0
            ) {
              await tx.reviewNotification.createMany({
                data: reviewerRecipients.map((recipient) => ({
                  id: randomUUID(),
                  reviewRoundId: created.id,
                  recipientId: recipient.id,
                  kind: "round_sent",
                  sourceKey: created.id,
                  nextAttemptAt: now,
                })),
              });
            } else if (reviewerRecipients.length > 0) {
              await recordNotificationAdmissionSuppressed(tx, {
                reviewRoundId: created.id,
                sourceId: created.id,
                sourceKind: "round_sent",
                recipientCount: reviewerRecipients.length,
              });
            }
            await tx.reviewAuditEvent.create({
              data: {
                reviewRoundId: created.id,
                kind: "round_sent",
                targetId: created.id,
                metadata: {
                  actorUserId: scope.actorUserId,
                  recipientCount: reviewerRecipients.length,
                  notificationCount: notificationAdmissionEnabled
                    ? reviewerRecipients.length
                    : 0,
                  approvalRequired,
                  ...(automationFingerprint
                    ? { automationIdempotencyFingerprint: automationFingerprint }
                    : {}),
                },
              },
            });
            await tx.projectAnalyticsEvent.create({
              data: {
                projectId: scope.projectId,
                type: "review_sent",
                metadata: {
                  reviewRoundId: created.id,
                  revision: created.revision,
                },
              },
            });
            return created;
          },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          ),
      );
    } catch (error) {
      if (
        scope.idempotencyKey &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const racedReplay = await readAutomationReplay();
        if (racedReplay) return racedReplay;
      }
      throw error;
    }
    const notifications = await prisma.reviewNotification.findMany({
      where: { reviewRoundId: round.id, kind: "round_sent" },
      select: { id: true },
    });
    return {
      ...round,
      token: rawToken,
      path: `/review/${rawToken}`,
      notificationIds: notifications.map((entry) => entry.id),
      replayed: false,
    };
  }

  async authenticate(rawToken: string, input: unknown, rateLimitKey: string, secret: string) {
    this.assertGuestReadEnabled();
    const parsed = reviewGuestAccessSchema.parse(input);
    const tokenHash = hashReviewAccessToken(rawToken);
    const sourceHash = createHash("sha256").update(rateLimitKey).digest("hex");
    const rejectAccess = async () => {
      await enforceReviewRateLimit(`review-access-source:${tokenHash}:${sourceHash}`, REVIEW_ACCESS_LIMIT, REVIEW_ACCESS_WINDOW_MS);
      await enforceReviewRateLimit(`review-access-token:${tokenHash}`, REVIEW_ACCESS_LIMIT, REVIEW_ACCESS_WINDOW_MS);
      throw new ReviewServiceError("review_access_invalid", "Review access is invalid or expired");
    };
    const round = await requirePrisma().reviewRound.findUnique({ where: { accessTokenHash: tokenHash }, select: { id: true, projectId: true, accessTokenHash: true, passcodeHash: true, status: true, expiresAt: true, revokedAt: true } });
    if (!round || round.revokedAt || round.status !== "open" || (round.expiresAt && round.expiresAt <= new Date())) {
			return rejectAccess();
    }
    const expectedToken = Buffer.from(round.accessTokenHash, "hex");
    const actualToken = Buffer.from(tokenHash, "hex");
    if (expectedToken.length !== actualToken.length || !timingSafeEqual(expectedToken, actualToken)) {
			return rejectAccess();
    }
    if (round.passcodeHash && (!parsed.passcode || !(await verifyReviewPasscode(parsed.passcode, round.passcodeHash)))) {
			return rejectAccess();
    }
    const normalizedEmail = parsed.email.trim().toLowerCase();
    const emailHash = createHmac("sha256", secret).update(normalizedEmail).digest("hex");
    const subject = randomBytes(32).toString("base64url");
    const guest = await withSerializableRetry(() => requirePrisma().$transaction(async (tx) => {
      const row = await tx.reviewGuest.upsert({
        where: { reviewRoundId_emailHash: { reviewRoundId: round.id, emailHash } },
        create: { reviewRoundId: round.id, displayName: parsed.identity, emailHash, emailEncrypted: encryptReviewEmail(normalizedEmail, secret), sessionGrantHash: hashReviewSessionGrant(subject) },
        update: { displayName: parsed.identity, emailEncrypted: encryptReviewEmail(normalizedEmail, secret), sessionGrantHash: hashReviewSessionGrant(subject), lastSeenAt: new Date() },
      });
      const alreadyOpened = await tx.reviewAuditEvent.findFirst({
        where: {
          reviewRoundId: round.id,
          guestId: row.id,
          kind: "guest_authenticated",
        },
        select: { id: true },
      });
      if (!alreadyOpened) {
        await tx.reviewAuditEvent.create({ data: { reviewRoundId: round.id, guestId: row.id, kind: "guest_authenticated" } });
        await tx.projectAnalyticsEvent.create({
          data: {
            projectId: round.projectId,
            type: "review_opened",
            metadata: { reviewRoundId: round.id },
          },
        });
      }
      return row;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
    return issueReviewSession({ roundId: round.id, guestId: guest.id, grant: round.accessTokenHash.slice(0, 32), identity: guest.displayName, subject }, secret);
  }

  async readRound(session: string, secret: string) {
    this.assertGuestReadEnabled();
    const claims = verifyReviewSession(session, secret);
    const round = await requirePrisma().reviewRound.findUnique({
      where: { id: claims.roundId },
      include: {
        project: {
          select: {
            title: true,
            workspace: { select: { name: true } },
          },
        },
        items: {
          orderBy: { position: "asc" },
          include: {
            clip: { select: { title: true, index: true } },
            export: {
              select: {
                id: true,
                editorRevision: true,
                variants: {
                  select: {
                    id: true,
                    aspectRatio: true,
                    resolution: true,
                    durationSec: true,
                    status: true,
                  },
                },
              },
            },
          },
        },
        comments: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!round || round.accessTokenHash.slice(0, 32) !== claims.grant || round.revokedAt || round.status !== "open" || (round.expiresAt && round.expiresAt <= new Date())) {
      throw new ReviewServiceError("review_session_invalid", "Review session is invalid or expired");
    }
    const guest = await requirePrisma().reviewGuest.findFirst({ where: { id: claims.guestId, reviewRoundId: round.id, sessionGrantHash: hashReviewSessionGrant(claims.subject) }, select: { id: true } });
    if (!guest) throw new ReviewServiceError("review_session_invalid", "Review session is invalid or expired");
    return { round, claims };
  }

  async resolveMedia(session: string, secret: string, itemId: string, variantId: string, mode: "playback" | "download" = "playback") {
    const { round } = await this.readRound(session, secret);
    if (mode === "download" && !round.allowDownloads) {
      throw new ReviewServiceError("review_download_forbidden", "Downloads are disabled for this review round");
    }
    const item = round.items.find((candidate) => candidate.id === itemId);
    const selectedVariantIds = item
      ? new Set(reviewSelectedVariantIdsSchema.parse(item.selectedVariantIds))
      : new Set<string>();
    const variant = item?.export.variants.find((candidate) => candidate.id === variantId && selectedVariantIds.has(candidate.id));
    if (!item || !variant || variant.status !== "completed") throw new ReviewServiceError("review_media_not_found", "Review media was not found");
    const stored = await requirePrisma().clipExportVariant.findUnique({ where: { id: variant.id }, select: { storageKey: true } });
    if (!stored?.storageKey) throw new ReviewServiceError("review_media_not_found", "Review media was not found");
    return presignDownloadUrl({
      key: stored.storageKey,
      expiresIn: 60,
      ...(mode === "download" ? { fileName: `review-${item.id}-${variant.id}.mp4` } : {}),
    });
  }

  async addComment(session: string, secret: string, input: unknown) {
    this.assertFeedbackMutationEnabled();
    const parsed = reviewCommentSchema.parse(input);
    const { round, claims } = await this.readRound(session, secret);
    await enforceReviewRateLimit(`review-comment:${round.id}:${claims.guestId}`, 60, 15 * 60_000);
    if (round.status !== "open") throw new ReviewServiceError("review_round_closed", "This review round is closed");
    if (parsed.itemId && !round.items.some((item) => item.id === parsed.itemId)) throw new ReviewServiceError("review_item_not_found", "Review item was not found");
    if (parsed.timestampSec !== null) {
      if (!parsed.itemId) {
        throw new ReviewServiceError("review_timecode_requires_item", "A timecoded comment must target a review item");
      }
      const item = round.items.find((candidate) => candidate.id === parsed.itemId)!;
      const selected = new Set(reviewSelectedVariantIdsSchema.parse(item.selectedVariantIds));
      const durations = item.export.variants
        .filter((variant) => selected.has(variant.id) && variant.status === "completed" && variant.durationSec !== null)
        .map((variant) => variant.durationSec!);
      const durationSec = durations.length > 0 ? Math.max(...durations) : null;
      if (durationSec === null || parsed.timestampSec > durationSec + 0.001) {
        throw new ReviewServiceError("review_timecode_out_of_range", "The comment timecode is outside the frozen review media");
      }
    }
    if (parsed.parentId) {
      const parent = round.comments.find((comment) => comment.id === parsed.parentId);
      if (!parent || parent.parentId || parent.itemId !== parsed.itemId) throw new ReviewServiceError("review_thread_invalid", "Replies can only be one level deep within the same review item");
    }
    return requirePrisma().$transaction(async (tx) => {
      await assertReviewRoundWritable(tx, round.id);
      const comment = await tx.reviewComment.create({ data: { reviewRoundId: round.id, itemId: parsed.itemId, parentId: parsed.parentId, authorKind: "guest", authorName: claims.identity, authorGuestId: claims.guestId, authorGrantHash: hashReviewSessionGrant(claims.subject), body: parsed.body, timestampSec: parsed.timestampSec } });
      await tx.reviewAuditEvent.create({ data: { reviewRoundId: round.id, guestId: claims.guestId, kind: "comment_created", targetId: comment.id, metadata: { itemId: parsed.itemId, timecoded: parsed.timestampSec !== null } } });
      return comment;
    });
  }

  async editComment(session: string, secret: string, commentId: string, input: unknown) {
    this.assertFeedbackMutationEnabled();
    const parsed = reviewCommentEditSchema.parse(input);
    const { round, claims } = await this.readRound(session, secret);
    await enforceReviewRateLimit(`review-comment-edit:${round.id}:${claims.guestId}`, 30, 15 * 60_000);
    const comment = round.comments.find((candidate) => candidate.id === commentId);
    if (!comment || comment.authorKind !== "guest" || comment.authorGrantHash !== hashReviewSessionGrant(claims.subject) || Date.now() - comment.createdAt.getTime() > REVIEW_COMMENT_EDIT_WINDOW_MS) {
      throw new ReviewServiceError("review_comment_edit_forbidden", "This comment can no longer be edited");
    }
    return requirePrisma().$transaction(async (tx) => {
      await assertReviewRoundWritable(tx, round.id);
      const eligible = await tx.reviewComment.updateMany({
        where: {
          id: comment.id,
          authorGrantHash: hashReviewSessionGrant(claims.subject),
          createdAt: { gte: new Date(Date.now() - REVIEW_COMMENT_EDIT_WINDOW_MS) },
        },
        data: { body: parsed.body, editedAt: new Date() },
      });
      if (eligible.count !== 1) throw new ReviewServiceError("review_comment_edit_forbidden", "This comment can no longer be edited");
      const updated = await tx.reviewComment.findUniqueOrThrow({ where: { id: comment.id } });
      await tx.reviewAuditEvent.create({ data: { reviewRoundId: round.id, guestId: claims.guestId, kind: "comment_edited", targetId: comment.id } });
      return updated;
    });
  }

  async deleteComment(session: string, secret: string, commentId: string) {
    this.assertFeedbackMutationEnabled();
    const { round, claims } = await this.readRound(session, secret);
    await enforceReviewRateLimit(`review-comment-delete:${round.id}:${claims.guestId}`, 30, 15 * 60_000);
    const grantHash = hashReviewSessionGrant(claims.subject);
    const comment = round.comments.find((candidate) => candidate.id === commentId);
    if (!comment || comment.authorKind !== "guest" || comment.authorGrantHash !== grantHash || Date.now() - comment.createdAt.getTime() > REVIEW_COMMENT_EDIT_WINDOW_MS) {
      throw new ReviewServiceError("review_comment_delete_forbidden", "This comment can no longer be deleted");
    }
    return withSerializableRetry(() => requirePrisma().$transaction(async (tx) => {
      await assertReviewRoundWritable(tx, round.id);
      if (await tx.reviewComment.count({ where: { parentId: comment.id } }) > 0) {
        throw new ReviewServiceError("review_comment_has_replies", "A comment with replies cannot be deleted");
      }
      const eligible = await tx.reviewComment.deleteMany({
        where: { id: comment.id, authorGrantHash: grantHash, createdAt: { gte: new Date(Date.now() - REVIEW_COMMENT_EDIT_WINDOW_MS) } },
      });
      if (eligible.count !== 1) throw new ReviewServiceError("review_comment_delete_forbidden", "This comment can no longer be deleted");
      await tx.reviewAuditEvent.create({ data: { reviewRoundId: round.id, guestId: claims.guestId, kind: "comment_deleted", targetId: comment.id } });
      return { deleted: true };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  async decide(session: string, secret: string, input: unknown) {
    this.assertFeedbackMutationEnabled();
    const notificationAdmissionEnabled = this.rolloutPolicy.isEnabled(
      "notification_admission",
    );
    const parsed = reviewDecisionSchema.parse(input);
    const { round, claims } = await this.readRound(session, secret);
    await enforceReviewRateLimit(`review-decision:${round.id}:${claims.guestId}`, 30, 15 * 60_000);
    return withSerializableRetry(() => requirePrisma().$transaction(async (tx) => {
      await assertReviewRoundWritable(tx, round.id);
      const currentItems = await tx.reviewRoundItem.findMany({ where: { reviewRoundId: round.id } });
      const item = parsed.itemId ? currentItems.find((candidate) => candidate.id === parsed.itemId) : null;
      if (parsed.itemId && !item) throw new ReviewServiceError("review_item_not_found", "Review item was not found");
      if (!parsed.itemId && parsed.decision === "approved") {
        const requiredItems = currentItems.filter((candidate) => candidate.required);
        if (round.approvalRequired && requiredItems.some((candidate) => candidate.currentDecision !== "approved")) {
          throw new ReviewServiceError("review_campaign_not_ready", "Every required item must be approved first");
        }
      }
      const decidedAt = new Date();
      await tx.reviewDecision.updateMany({ where: { reviewRoundId: round.id, itemId: parsed.itemId, supersededAt: null }, data: { supersededAt: decidedAt } });
      const decision = await tx.reviewDecision.create({ data: { reviewRoundId: round.id, itemId: parsed.itemId, actorGuestId: claims.guestId, decision: parsed.decision, actorKind: "guest", actorName: claims.identity, reason: parsed.reason } });
      if (item) {
        await tx.reviewRoundItem.update({ where: { id: item.id }, data: { currentDecision: parsed.decision } });
        if (parsed.decision === "changes_requested") await tx.reviewRound.update({ where: { id: round.id }, data: { decision: null, decidedAt: null } });
      } else {
        await tx.reviewRound.update({ where: { id: round.id }, data: { decision: parsed.decision, decidedAt } });
      }
      await tx.reviewAuditEvent.create({ data: { reviewRoundId: round.id, guestId: claims.guestId, kind: item ? "item_decided" : "campaign_decided", targetId: item?.id ?? round.id, metadata: { decision: parsed.decision } } });
      if (
        parsed.decision === "changes_requested" ||
        (!item && parsed.decision === "approved")
      ) {
        const kind =
          parsed.decision === "changes_requested"
            ? "first_changes_requested"
            : "all_approved";
        const internalRecipients = await tx.reviewRecipient.findMany({
          where: { reviewRoundId: round.id, role: "internal" },
          select: { id: true },
        });
        let admittedNotificationCount = 0;
        if (notificationAdmissionEnabled && internalRecipients.length > 0) {
          const admitted = await tx.reviewNotification.createMany({
            data: internalRecipients.map((recipient) => ({
              id: randomUUID(),
              reviewRoundId: round.id,
              recipientId: recipient.id,
              kind,
              sourceKey: round.id,
            })),
            skipDuplicates: true,
          });
          admittedNotificationCount = admitted.count;
        } else if (internalRecipients.length > 0) {
          await recordNotificationAdmissionSuppressed(tx, {
            reviewRoundId: round.id,
            sourceId: decision.id,
            sourceKind: kind,
            recipientCount: internalRecipients.length,
          });
        }
        if (kind === "first_changes_requested") {
          if (admittedNotificationCount > 0) {
            await tx.reviewAuditEvent.create({
              data: {
                reviewRoundId: round.id,
                kind: "changes_notification_enqueued",
                targetId: decision.id,
              },
            });
          }
          const changesDecisionCount = await tx.reviewDecision.count({
            where: {
              reviewRoundId: round.id,
              decision: "changes_requested",
            },
          });
          if (changesDecisionCount === 1) {
            await tx.projectAnalyticsEvent.create({
              data: {
                projectId: round.projectId,
                type: "review_changes_requested",
                metadata: { reviewRoundId: round.id },
              },
            });
          }
        } else {
          await tx.projectAnalyticsEvent.create({
            data: {
              projectId: round.projectId,
              type: "campaign_approved",
              metadata: { reviewRoundId: round.id },
            },
          });
        }
      }
      return decision;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  async addInternalComment(
    scope: { workspaceId: string; projectId: string; actorUserId: string },
    roundId: string,
    input: unknown,
  ) {
    this.assertFeedbackMutationEnabled();
    const notificationAdmissionEnabled = this.rolloutPolicy.isEnabled(
      "notification_admission",
    );
    const parsed = internalReviewCommentSchema.parse(input);
    const prisma = requirePrisma();
    const [round, actor] = await Promise.all([
      prisma.reviewRound.findFirst({
        where: {
          id: roundId,
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
        },
        include: {
          items: {
            include: {
              export: {
                select: {
                  variants: {
                    where: { status: "completed" },
                    select: { id: true, durationSec: true },
                  },
                },
              },
            },
          },
          comments: { select: { id: true, itemId: true, parentId: true } },
          recipients: { select: { id: true } },
        },
      }),
      prisma.user.findUnique({
        where: { id: scope.actorUserId },
        select: { firstName: true, lastName: true },
      }),
    ]);
    if (!round) {
      throw new ReviewServiceError(
        "review_round_not_found",
        "Review round was not found",
      );
    }
    const item = parsed.itemId
      ? round.items.find((candidate) => candidate.id === parsed.itemId)
      : null;
    if (parsed.itemId && !item) {
      throw new ReviewServiceError(
        "review_item_not_found",
        "Review item was not found",
      );
    }
    if (parsed.timestampSec !== null) {
      if (!item) {
        throw new ReviewServiceError(
          "review_timecode_requires_item",
          "A timecoded comment must target a review item",
        );
      }
      const selected = new Set(
        reviewSelectedVariantIdsSchema.parse(item.selectedVariantIds),
      );
      const durations = item.export.variants
        .filter(
          (variant) =>
            selected.has(variant.id) && variant.durationSec !== null,
        )
        .map((variant) => variant.durationSec!);
      if (
        durations.length === 0 ||
        parsed.timestampSec > Math.max(...durations) + 0.001
      ) {
        throw new ReviewServiceError(
          "review_timecode_out_of_range",
          "The comment timecode is outside the frozen review media",
        );
      }
    }
    if (parsed.parentId) {
      const parent = round.comments.find(
        (comment) => comment.id === parsed.parentId,
      );
      if (!parent || parent.parentId || parent.itemId !== parsed.itemId) {
        throw new ReviewServiceError(
          "review_thread_invalid",
          "Replies can only be one level deep within the same review item",
        );
      }
    }
    const recipientIds = new Set(
      round.recipients.map((recipient) => recipient.id),
    );
    if (
      new Set(parsed.mentionRecipientIds).size !==
        parsed.mentionRecipientIds.length ||
      parsed.mentionRecipientIds.some((id) => !recipientIds.has(id))
    ) {
      throw new ReviewServiceError(
        "review_mention_invalid",
        "A mentioned reviewer does not belong to this round",
      );
    }
    const authorName =
      [actor?.firstName, actor?.lastName].filter(Boolean).join(" ").trim() ||
      "Narriflow teammate";
    return prisma.$transaction(async (tx) => {
      await assertReviewRoundWritable(tx, round.id);
      const comment = await tx.reviewComment.create({
        data: {
          reviewRoundId: round.id,
          itemId: parsed.itemId,
          parentId: parsed.parentId,
          authorKind: "internal",
          authorName,
          authorGrantHash: createHash("sha256")
            .update(`internal:${scope.actorUserId}`)
            .digest("hex"),
          body: parsed.body,
          timestampSec: parsed.timestampSec,
        },
      });
      const notificationIds = notificationAdmissionEnabled
        ? parsed.mentionRecipientIds.map(() => randomUUID())
        : [];
      if (
        notificationAdmissionEnabled &&
        parsed.mentionRecipientIds.length > 0
      ) {
        await tx.reviewNotification.createMany({
          data: parsed.mentionRecipientIds.map((recipientId, index) => ({
            id: notificationIds[index]!,
            reviewRoundId: round.id,
            recipientId,
            kind: "mention",
            sourceKey: comment.id,
          })),
        });
      } else if (parsed.mentionRecipientIds.length > 0) {
        await recordNotificationAdmissionSuppressed(tx, {
          reviewRoundId: round.id,
          sourceId: comment.id,
          sourceKind: "mention",
          recipientCount: parsed.mentionRecipientIds.length,
        });
      }
      await tx.reviewAuditEvent.create({
        data: {
          reviewRoundId: round.id,
          kind: "internal_comment_created",
          targetId: comment.id,
          metadata: {
            actorUserId: scope.actorUserId,
            itemId: parsed.itemId,
            mentionCount: parsed.mentionRecipientIds.length,
            notificationCount: notificationIds.length,
            timecoded: parsed.timestampSec !== null,
          },
        },
      });
      return { comment, notificationIds };
    });
  }

  async resendRound(
    scope: { workspaceId: string; projectId: string; actorUserId: string },
    roundId: string,
    idempotencyKey: string,
  ) {
    this.assertNotificationAdmissionEnabled();
    return requirePrisma().$transaction(async (tx) => {
      const round = await tx.reviewRound.findFirst({
        where: {
          id: roundId,
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          status: "open",
          revokedAt: null,
          AND: [
            { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
            { OR: [{ decision: null }, { decision: { not: "approved" } }] },
          ],
        },
        select: {
          id: true,
          recipients: {
            where: { role: "reviewer" },
            select: { id: true },
          },
        },
      });
      if (!round) {
        throw new ReviewServiceError(
          "review_round_closed",
          "This review round is no longer open",
        );
      }
      const rows = round.recipients.map((recipient) => ({
        id: randomUUID(),
        reviewRoundId: round.id,
        recipientId: recipient.id,
        kind: "round_resent",
        sourceKey: idempotencyKey,
      }));
      const created = rows.length > 0
        ? await tx.reviewNotification.createMany({
          data: rows,
          skipDuplicates: true,
        })
        : { count: 0 };
      if (created.count > 0) {
        await tx.reviewAuditEvent.create({
          data: {
            reviewRoundId: round.id,
            kind: "round_resent",
            targetId: round.id,
            metadata: {
              actorUserId: scope.actorUserId,
              recipientCount: created.count,
            },
          },
        });
      }
      const notifications = await tx.reviewNotification.findMany({
        where: {
          reviewRoundId: round.id,
          kind: "round_resent",
          sourceKey: idempotencyKey,
        },
        select: { id: true },
      });
      return { notificationIds: notifications.map((entry) => entry.id) };
    });
  }

  async retryNotification(
    scope: { workspaceId: string; projectId: string; actorUserId: string },
    roundId: string,
    notificationId: string,
    idempotencyKey: string,
  ) {
    this.assertNotificationAdmissionEnabled();
    return requirePrisma().$transaction(async (tx) => {
      return retryReviewNotification(
        {
          async readSource(input) {
            return tx.reviewNotification.findFirst({
              where: {
                id: input.notificationId,
                reviewRoundId: input.roundId,
                reviewRound: {
                  workspaceId: input.workspaceId,
                  projectId: input.projectId,
                },
              },
              select: {
                id: true,
                reviewRoundId: true,
                recipientId: true,
                kind: true,
                status: true,
              },
            });
          },
          async findRetry(input) {
            return tx.reviewNotification.findUnique({
              where: {
                reviewRoundId_recipientId_kind_sourceKey: input,
              },
              select: { id: true, status: true },
            });
          },
          async reserveRetry(input) {
            const created = await tx.reviewNotification.createMany({
              data: [{
                id: input.id,
                reviewRoundId: input.source.reviewRoundId,
                recipientId: input.source.recipientId,
                kind: input.source.kind,
                sourceKey: input.sourceKey,
              }],
              skipDuplicates: true,
            });
            const notification = await tx.reviewNotification.findUnique({
              where: {
                reviewRoundId_recipientId_kind_sourceKey: {
                  reviewRoundId: input.source.reviewRoundId,
                  recipientId: input.source.recipientId,
                  kind: input.source.kind,
                  sourceKey: input.sourceKey,
                },
              },
              select: { id: true, status: true },
            });
            if (!notification) {
              throw new Error("Review notification retry reservation disappeared");
            }
            return { notification, created: created.count === 1 };
          },
          async recordRetryAudit(input) {
            await tx.reviewAuditEvent.create({
              data: {
                reviewRoundId: input.reviewRoundId,
                kind: "notification_retried",
                targetId: input.retryNotificationId,
                metadata: {
                  actorUserId: input.actorUserId,
                  sourceNotificationId: input.sourceNotificationId,
                },
              },
            });
          },
        },
        {
          scope,
          roundId,
          notificationId,
          idempotencyKey,
          createId: randomUUID,
        },
      );
    });
  }

  async resolveComment(scope: { workspaceId: string; projectId: string; actorUserId: string }, roundId: string, commentId: string, resolved: boolean) {
    return requirePrisma().$transaction(async (tx) => {
      const comment = await tx.reviewComment.findFirst({ where: { id: commentId, reviewRoundId: roundId, reviewRound: { workspaceId: scope.workspaceId, projectId: scope.projectId } } });
      if (!comment) throw new ReviewServiceError("review_comment_not_found", "Review comment was not found");
      const updated = await tx.reviewComment.update({ where: { id: comment.id }, data: { resolvedAt: resolved ? new Date() : null } });
      await tx.reviewAuditEvent.create({ data: { reviewRoundId: roundId, kind: resolved ? "comment_resolved" : "comment_reopened", targetId: comment.id, metadata: { actorUserId: scope.actorUserId } } });
      return updated;
    });
  }

  async revokeRound(scope: { workspaceId: string; projectId: string; actorUserId: string }, roundId: string) {
    return requirePrisma().$transaction(async (tx) => {
      const revoked = await tx.reviewRound.updateMany({
        where: { id: roundId, workspaceId: scope.workspaceId, projectId: scope.projectId, revokedAt: null },
        data: { revokedAt: new Date(), status: "revoked" },
      });
      if (revoked.count !== 1) throw new ReviewServiceError("review_round_not_found", "Review round was not found or was already revoked");
      await tx.reviewAuditEvent.create({ data: { reviewRoundId: roundId, kind: "round_revoked", targetId: roundId, metadata: { actorUserId: scope.actorUserId } } });
      return { revoked: true };
    });
  }

  async internalWorkspaceView(
    workspaceId: string,
    projectId: string,
    dataSecret?: string,
  ) {
    const prisma = requirePrisma();
    const [project, exports, rounds] = await Promise.all([
      prisma.project.findFirst({
        where: { id: projectId, workspaceId },
        select: {
          id: true,
          title: true,
          brandProfileId: true,
          brandProfileSnapshot: true,
        },
      }),
      prisma.clipExport.findMany({
        where: { workspaceId, projectId, status: "ready" },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          clipId: true,
          editorRevision: true,
          fingerprint: true,
          createdAt: true,
          clip: {
            select: {
              title: true,
              index: true,
              startSec: true,
              endSec: true,
              editorRevision: true,
            },
          },
          variants: {
            where: { status: "completed" },
            orderBy: { aspectRatio: "asc" },
            select: {
              id: true,
              aspectRatio: true,
              resolution: true,
              durationSec: true,
              status: true,
            },
          },
        },
      }),
      prisma.reviewRound.findMany({
        where: { workspaceId, projectId },
        include: {
          items: {
            orderBy: { position: "asc" },
            include: {
              export: {
                select: {
                  id: true,
                  fingerprint: true,
                  editorRevision: true,
                  variants: {
                    select: {
                      id: true,
                      aspectRatio: true,
                      resolution: true,
                      durationSec: true,
                      status: true,
                    },
                  },
                },
              },
              clip: {
                select: {
                  title: true,
                  index: true,
                  editorRevision: true,
                  exports: {
                    where: { status: "ready" },
                    orderBy: { createdAt: "desc" },
                    take: 1,
                    select: { fingerprint: true },
                  },
                },
              },
            },
          },
          comments: {
            orderBy: { createdAt: "asc" },
            select: {
              id: true,
              itemId: true,
              parentId: true,
              authorKind: true,
              authorName: true,
              body: true,
              timestampSec: true,
              resolvedAt: true,
              editedAt: true,
              createdAt: true,
            },
          },
          recipients: {
            orderBy: { createdAt: "asc" },
            select: {
              id: true,
              role: true,
              emailEncrypted: true,
              createdAt: true,
            },
          },
          notifications: {
            orderBy: { createdAt: "desc" },
            select: {
              id: true,
              recipientId: true,
              kind: true,
              sourceKey: true,
              status: true,
              attemptCount: true,
              nextAttemptAt: true,
              failureCode: true,
              sentAt: true,
              createdAt: true,
            },
          },
          auditEvents: {
            orderBy: { createdAt: "desc" },
            take: 100,
            select: {
              id: true,
              kind: true,
              targetId: true,
              metadata: true,
              createdAt: true,
            },
          },
        },
        orderBy: { revision: "desc" },
      }),
    ]);
    if (!project) {
      throw new ReviewServiceError(
        "review_project_not_found",
        "Project was not found",
      );
    }
    const candidates = new Map<string, (typeof exports)[number]>();
    for (const clipExport of exports) {
      if (
        clipExport.variants.length > 0 &&
        !candidates.has(clipExport.clipId)
      ) {
        candidates.set(clipExport.clipId, clipExport);
      }
    }
    const now = new Date();
    return {
      project: {
        id: project.id,
        title: project.title,
        approvalRequired: frozenProjectApprovalRequired(project),
      },
      candidates: [...candidates.values()].sort(
        (left, right) => left.clip.index - right.clip.index,
      ),
      rounds: rounds.map((round) => {
        const {
          accessTokenHash: _accessTokenHash,
          passcodeHash: _passcodeHash,
          ...safeRound
        } = round;
        return {
          ...safeRound,
          status: deriveReviewRoundStatus(round, now),
          responsesOpen:
            round.status === "open" &&
            round.revokedAt === null &&
            (!round.expiresAt || round.expiresAt > now) &&
            round.decision !== "approved",
          recipients: round.recipients.map((recipient) => ({
            id: recipient.id,
            role: recipient.role,
            email: dataSecret
              ? decryptReviewEmail(recipient.emailEncrypted, dataSecret)
              : null,
            createdAt: recipient.createdAt,
          })),
          notifications: round.notifications.map(
            ({ sourceKey, ...notification }) => ({
              ...notification,
              retryOfNotificationId:
                reviewNotificationRetrySourceId(sourceKey),
            }),
          ),
          items: round.items.map((item) => ({
            ...item,
            newerWorkAvailable:
              item.clip.editorRevision > item.editorRevision ||
              (item.clip.exports[0] !== undefined &&
                item.clip.exports[0].fingerprint !== item.export.fingerprint),
          })),
          newerWorkAvailable: round.items.some(
            (item) =>
              item.clip.editorRevision > item.editorRevision ||
              (item.clip.exports[0] !== undefined &&
                item.clip.exports[0].fingerprint !== item.export.fingerprint),
          ),
        };
      }),
    };
  }

  async internalProjection(workspaceId: string, projectId: string) {
    return (await this.internalWorkspaceView(workspaceId, projectId)).rounds;
  }
}

export const reviewService = new ReviewService();
