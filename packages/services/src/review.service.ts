import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import { AnalyticsEventType, Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  brandProfileSnapshotSchema,
  createReviewRoundSchema,
  internalReviewCommentSchema,
  inviteReviewersSchema,
  reviewCommentEditSchema,
  reviewCommentSchema,
  reviewDecisionSchema,
  reviewGuestAccessSchema,
  reviewSelectedVariantIdsSchema,
  type PricingTier,
} from "@narriflow/validators";
import { hasFeature } from "./plan-features";
import { checkRateLimit } from "./rate-limit";
import { presignDownloadUrl } from "./r2-storage";
import {
  ExpectedDomainFailureError,
  type ExpectedDomainFailureCatalog,
} from "./expected-domain-failure";

const REVIEW_SESSION_TTL_SEC = 12 * 60 * 60;
const REVIEW_COMMENT_EDIT_WINDOW_MS = 15 * 60_000;
const REVIEW_ACCESS_WINDOW_MS = 15 * 60_000;
const REVIEW_ACCESS_LIMIT = 8;
const ARGON2ID_ALGORITHM = 2 as const;
const localAccessAttempts = new Map<string, { count: number; resetAt: number }>();

const REVIEW_FAILURES = {
  review_access_invalid: "invalid",
  review_access_rate_limited: "rate_limited",
  review_campaign_not_ready: "conflict",
  review_comment_delete_forbidden: "forbidden",
  review_comment_edit_forbidden: "forbidden",
  review_comment_has_replies: "conflict",
  review_comment_not_found: "missing",
  review_context_duplicate: "invalid",
  review_context_stale: "conflict",
  review_delivery_configuration_invalid: "unavailable",
  review_download_forbidden: "forbidden",
  review_expiry_invalid: "invalid",
  review_feature_unavailable: "forbidden",
  review_item_not_found: "missing",
  review_item_stale: "conflict",
  review_items_duplicate: "invalid",
  review_media_not_found: "missing",
  review_origin_invalid: "invalid",
  review_project_not_found: "missing",
  review_recipients_limit_exceeded: "invalid",
  review_request_invalid: "invalid",
  review_request_too_large: "invalid",
  review_round_closed: "conflict",
  review_round_not_found: "missing",
  review_route_not_found: "missing",
  review_secret_invalid: "unavailable",
  review_session_configuration_invalid: "unavailable",
  review_session_invalid: "invalid",
  review_thread_invalid: "invalid",
  review_timecode_out_of_range: "invalid",
  review_timecode_requires_item: "invalid",
} as const satisfies ExpectedDomainFailureCatalog<string>;

export type ReviewServiceErrorCode = keyof typeof REVIEW_FAILURES;

export class ReviewServiceError extends ExpectedDomainFailureError<ReviewServiceErrorCode> {
  constructor(code: ReviewServiceErrorCode, message: string) {
    super({ code, kind: REVIEW_FAILURES[code], message });
    this.name = "ReviewServiceError";
  }
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

export function brandApprovalRequiredByDefault(snapshot: unknown): boolean {
	const parsed = brandProfileSnapshotSchema.safeParse(snapshot);
	return parsed.success && parsed.data.approvalRule === "approval_required";
}

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  return prisma;
}

export function hashReviewAccessToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
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

function reviewGrantHash(subject: string) {
  return createHash("sha256").update(subject).digest("hex");
}

export function reviewGuestCanEditComment(
  claims: Pick<ReviewSessionClaims, "guestId" | "subject">,
  comment: { authorKind: string; authorGuestId: string | null; authorGrantHash: string; createdAt: Date },
  now = new Date(),
) {
  return comment.authorKind === "guest" &&
    comment.authorGuestId === claims.guestId &&
    comment.authorGrantHash === reviewGrantHash(claims.subject) &&
    now.getTime() - comment.createdAt.getTime() <= REVIEW_COMMENT_EDIT_WINDOW_MS;
}

function encryptReviewEmail(email: string, secret: string) {
  return encryptReviewValue(email, secret);
}

export function encryptReviewValue(value: string, secret: string) {
  const key = createHash("sha256").update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((value) => value.toString("base64url")).join(".");
}

export function decryptReviewValue(value: string, secret: string) {
  const [ivValue, tagValue, encryptedValue, extra] = value.split(".");
  if (!ivValue || !tagValue || !encryptedValue || extra) {
    throw new ReviewServiceError("review_secret_invalid", "Review delivery data is invalid");
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      createHash("sha256").update(secret).digest(),
      Buffer.from(ivValue, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new ReviewServiceError("review_secret_invalid", "Review delivery data is invalid");
  }
}

export function reviewDeliverySecret() {
  const secret = process.env.REVIEW_ACCESS_SECRET?.trim() || process.env.REVIEW_SESSION_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new ReviewServiceError(
      "review_delivery_configuration_invalid",
      "Review delivery encryption is not configured",
    );
  }
  return secret;
}

function normalizeRecipientEmails(values: readonly string[]) {
  return [...new Set(values.map((value) => value.trim().toLowerCase()))].sort();
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
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    data: { updatedAt: now },
  });
  if (live.count !== 1) {
    throw new ReviewServiceError("review_round_closed", "This review round is no longer open");
  }
}

function recordReviewAnalytics(
  tx: Prisma.TransactionClient,
  projectId: string,
  type: AnalyticsEventType,
  reviewRoundId: string,
  clipId?: string,
) {
  return tx.projectAnalyticsEvent.create({
    data: {
      projectId,
      type,
      clipId,
      metadata: { reviewRoundId },
    },
  });
}

async function recordReviewExpiry(roundId: string, now = new Date()) {
  const prisma = requirePrisma();
  return prisma.$transaction(async (tx) => {
    const round = await tx.reviewRound.findUnique({
      where: { id: roundId },
      select: { projectId: true },
    });
    if (!round) return false;
    const recorded = await tx.reviewRound.updateMany({
      where: {
        id: roundId,
        status: "open",
        revokedAt: null,
        expiryRecordedAt: null,
        expiresAt: { lte: now },
      },
      data: { expiryRecordedAt: now },
    });
    if (recorded.count !== 1) return false;
    await recordReviewAnalytics(tx, round.projectId, AnalyticsEventType.review_expired, roundId);
    await tx.reviewAuditEvent.create({
      data: { reviewRoundId: roundId, kind: "round_expired", targetId: roundId },
    });
    return true;
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
  async createRound(scope: { actorUserId: string; workspaceId: string; projectId: string; pricingTier: PricingTier }, input: unknown) {
    if (!hasFeature(scope.pricingTier, "review.rooms")) {
      throw new ReviewServiceError("review_feature_unavailable", "Review rooms are not available on this plan");
    }
    const parsed = createReviewRoundSchema.parse(input);
    if (parsed.expiresAt && new Date(parsed.expiresAt) <= new Date()) {
      throw new ReviewServiceError("review_expiry_invalid", "Review expiry must be in the future");
    }
    if (new Set(parsed.items.map((item) => item.clipId)).size !== parsed.items.length) {
      throw new ReviewServiceError("review_items_duplicate", "A clip can appear only once in a review round");
    }
    if (new Set(parsed.contextCommentIds).size !== parsed.contextCommentIds.length) {
      throw new ReviewServiceError("review_context_duplicate", "A feedback thread can be linked only once");
    }
    const prisma = requirePrisma();
    const project = await prisma.project.findFirst({ where: { id: scope.projectId, workspaceId: scope.workspaceId }, select: { id: true } });
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
    const rawToken = randomBytes(32).toString("base64url");
    const tokenHash = hashReviewAccessToken(rawToken);
    const recipientEmails = normalizeRecipientEmails(parsed.recipientEmails);
    const deliveryTokenEncrypted = encryptReviewValue(rawToken, reviewDeliverySecret());
    const passcodeHash = parsed.passcode
      ? await hashReviewPasscode(parsed.passcode)
      : null;
    const round = await withSerializableRetry(() => prisma.$transaction(async (tx) => {
      const latest = await tx.reviewRound.findFirst({
        where: { projectId: scope.projectId },
        orderBy: { revision: "desc" },
        select: { id: true, revision: true },
      });
      const contextComments = parsed.contextCommentIds.length > 0
        ? await tx.reviewComment.findMany({
          where: {
            id: { in: parsed.contextCommentIds },
            parentId: null,
            resolvedAt: null,
            reviewRound: {
              workspaceId: scope.workspaceId,
              projectId: scope.projectId,
            },
          },
          select: { id: true },
        })
        : [];
      if (contextComments.length !== parsed.contextCommentIds.length) {
        throw new ReviewServiceError(
          "review_context_stale",
          "Linked feedback must still be unresolved in this project",
        );
      }
      await tx.reviewRound.updateMany({ where: { projectId: scope.projectId, status: "open" }, data: { status: "superseded", supersededAt: new Date() } });
      const created = await tx.reviewRound.create({ data: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        createdByUserId: scope.actorUserId,
        revision: (latest?.revision ?? 0) + 1,
        title: parsed.title,
        message: parsed.message,
        allowDownloads: parsed.allowDownloads,
        approvalRequired: parsed.approvalRequired,
        accessTokenHash: tokenHash,
        deliveryTokenEncrypted,
        recipientEmails,
        passcodeHash,
        expiresAt: parsed.expiresAt ? new Date(parsed.expiresAt) : null,
        items: { create: parsed.items.map((item, position) => ({
          clipId: item.clipId,
          exportId: item.exportId,
          editorRevision: item.expectedEditorRevision,
          position,
          selectedVariantIds: item.variantIds,
          required: item.required,
        })) },
        auditEvents: { create: {
          kind: latest ? "round_resubmitted" : "round_sent",
          metadata: latest ? { previousRoundId: latest.id } : undefined,
        } },
        notificationLedgers: { create: recipientEmails.map((recipientEmail) => ({
          recipientEmail,
          kind: "round_sent",
          scopeKey: "round",
        })) },
        contextLinks: {
          create: contextComments.map((comment) => ({ sourceCommentId: comment.id })),
        },
      }, select: { id: true, revision: true, createdAt: true } });
      await recordReviewAnalytics(
        tx,
        scope.projectId,
        latest ? AnalyticsEventType.review_resubmitted : AnalyticsEventType.review_sent,
        created.id,
      );
      return created;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
    return { ...round, token: rawToken, path: `/review/${rawToken}` };
  }

  async inviteReviewers(
    scope: { actorUserId: string; workspaceId: string; projectId: string; pricingTier: PricingTier },
    roundId: string,
    input: unknown,
  ) {
    if (!hasFeature(scope.pricingTier, "review.rooms")) {
      throw new ReviewServiceError("review_feature_unavailable", "Review rooms are not available on this plan");
    }
    const parsed = inviteReviewersSchema.parse(input);
    const requestedEmails = normalizeRecipientEmails(parsed.recipientEmails);

    return withSerializableRetry(() => requirePrisma().$transaction(async (tx) => {
      const round = await tx.reviewRound.findFirst({
        where: {
          id: roundId,
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
        },
        select: { id: true },
      });
      if (!round) {
        throw new ReviewServiceError("review_round_not_found", "Review round was not found");
      }
      await assertReviewRoundWritable(tx, round.id);
      const lockedRound = await tx.reviewRound.findUniqueOrThrow({
        where: { id: round.id },
        select: { recipientEmails: true },
      });

      const currentEmails = normalizeRecipientEmails(
        Array.isArray(lockedRound.recipientEmails)
          ? lockedRound.recipientEmails.filter((value): value is string => typeof value === "string")
          : [],
      );
      const currentSet = new Set(currentEmails);
      const addedEmails = requestedEmails.filter((email) => !currentSet.has(email));
      const recipientEmails = normalizeRecipientEmails([...currentEmails, ...addedEmails]);
      if (recipientEmails.length > 25) {
        throw new ReviewServiceError(
          "review_recipients_limit_exceeded",
          "A review round can include at most 25 reviewers",
        );
      }

      if (addedEmails.length > 0) {
        await tx.reviewRound.update({
          where: { id: round.id },
          data: { recipientEmails },
        });
        await tx.reviewNotificationLedger.createMany({
          data: addedEmails.map((recipientEmail) => ({
            reviewRoundId: round.id,
            recipientEmail,
            kind: "round_sent",
            scopeKey: "round",
          })),
          skipDuplicates: true,
        });
        await tx.reviewAuditEvent.create({
          data: {
            reviewRoundId: round.id,
            kind: "reviewers_invited",
            targetId: round.id,
            metadata: { actorUserId: scope.actorUserId, count: addedEmails.length },
          },
        });
      }

      return { addedCount: addedEmails.length, recipientEmails };
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 15_000,
      timeout: 30_000,
    }));
  }

  async authenticate(rawToken: string, input: unknown, rateLimitKey: string, secret: string) {
    const parsed = reviewGuestAccessSchema.parse(input);
    const tokenHash = hashReviewAccessToken(rawToken);
    const sourceHash = createHash("sha256").update(rateLimitKey).digest("hex");
    const rejectAccess = async () => {
      await enforceReviewRateLimit(`review-access-source:${tokenHash}:${sourceHash}`, REVIEW_ACCESS_LIMIT, REVIEW_ACCESS_WINDOW_MS);
      await enforceReviewRateLimit(`review-access-token:${tokenHash}`, REVIEW_ACCESS_LIMIT, REVIEW_ACCESS_WINDOW_MS);
      throw new ReviewServiceError("review_access_invalid", "Review access is invalid or expired");
    };
    const round = await requirePrisma().reviewRound.findUnique({ where: { accessTokenHash: tokenHash }, select: { id: true, projectId: true, accessTokenHash: true, passcodeHash: true, status: true, expiresAt: true, revokedAt: true } });
    if (round?.expiresAt && round.expiresAt <= new Date()) {
      await recordReviewExpiry(round.id);
    }
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
    const guest = await requirePrisma().$transaction(async (tx) => {
      const row = await tx.reviewGuest.upsert({
        where: { reviewRoundId_emailHash: { reviewRoundId: round.id, emailHash } },
        create: { reviewRoundId: round.id, displayName: parsed.identity, emailHash, emailEncrypted: encryptReviewEmail(normalizedEmail, reviewDeliverySecret()), sessionGrantHash: reviewGrantHash(subject) },
        update: { displayName: parsed.identity, emailEncrypted: encryptReviewEmail(normalizedEmail, reviewDeliverySecret()), sessionGrantHash: reviewGrantHash(subject), lastSeenAt: new Date() },
      });
      await tx.reviewAuditEvent.create({ data: { reviewRoundId: round.id, guestId: row.id, kind: "guest_authenticated" } });
      const firstOpen = await tx.reviewRound.updateMany({
        where: { id: round.id, firstOpenedAt: null },
        data: { firstOpenedAt: new Date() },
      });
      if (firstOpen.count === 1) {
        await recordReviewAnalytics(tx, round.projectId, AnalyticsEventType.review_opened, round.id);
      }
      return row;
    });
    return issueReviewSession({ roundId: round.id, guestId: guest.id, grant: round.accessTokenHash.slice(0, 32), identity: guest.displayName, subject }, secret);
  }

  async readRound(session: string, secret: string) {
    const claims = verifyReviewSession(session, secret);
    const round = await requirePrisma().reviewRound.findUnique({
      where: { id: claims.roundId },
      include: {
        project: { select: { title: true } },
        workspace: { select: { name: true } },
        items: { orderBy: { position: "asc" }, include: {
          clip: { select: { title: true } },
          export: { select: { id: true, editorRevision: true, variants: { select: { id: true, aspectRatio: true, durationSec: true, status: true } } } },
        } },
        comments: { orderBy: { createdAt: "asc" } },
      },
    });
    if (round?.expiresAt && round.expiresAt <= new Date()) {
      await recordReviewExpiry(round.id);
    }
    if (!round || round.accessTokenHash.slice(0, 32) !== claims.grant || round.revokedAt || round.status !== "open" || (round.expiresAt && round.expiresAt <= new Date())) {
      throw new ReviewServiceError("review_session_invalid", "Review session is invalid or expired");
    }
    const guest = await requirePrisma().reviewGuest.findFirst({ where: { id: claims.guestId, reviewRoundId: round.id, sessionGrantHash: reviewGrantHash(claims.subject) }, select: { id: true } });
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
      const comment = await tx.reviewComment.create({ data: { reviewRoundId: round.id, itemId: parsed.itemId, parentId: parsed.parentId, authorKind: "guest", authorName: claims.identity, authorGuestId: claims.guestId, authorGrantHash: reviewGrantHash(claims.subject), body: parsed.body, timestampSec: parsed.timestampSec } });
      await tx.reviewAuditEvent.create({ data: { reviewRoundId: round.id, guestId: claims.guestId, kind: "comment_created", targetId: comment.id, metadata: { itemId: parsed.itemId, timecoded: parsed.timestampSec !== null } } });
      const firstComment = await tx.reviewRound.updateMany({
        where: { id: round.id, firstCommentAt: null },
        data: { firstCommentAt: new Date() },
      });
      if (firstComment.count === 1) {
        await recordReviewAnalytics(tx, round.projectId, AnalyticsEventType.review_first_comment, round.id);
      }
      return comment;
    });
  }

  async editComment(session: string, secret: string, commentId: string, input: unknown) {
    const parsed = reviewCommentEditSchema.parse(input);
    const { round, claims } = await this.readRound(session, secret);
    await enforceReviewRateLimit(`review-comment-edit:${round.id}:${claims.guestId}`, 30, 15 * 60_000);
    const comment = round.comments.find((candidate) => candidate.id === commentId);
    if (!comment || comment.authorKind !== "guest" || comment.authorGrantHash !== reviewGrantHash(claims.subject) || Date.now() - comment.createdAt.getTime() > REVIEW_COMMENT_EDIT_WINDOW_MS) {
      throw new ReviewServiceError("review_comment_edit_forbidden", "This comment can no longer be edited");
    }
    return requirePrisma().$transaction(async (tx) => {
      await assertReviewRoundWritable(tx, round.id);
      const eligible = await tx.reviewComment.updateMany({
        where: {
          id: comment.id,
          authorGrantHash: reviewGrantHash(claims.subject),
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
    const { round, claims } = await this.readRound(session, secret);
    await enforceReviewRateLimit(`review-comment-delete:${round.id}:${claims.guestId}`, 30, 15 * 60_000);
    const grantHash = reviewGrantHash(claims.subject);
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
      if (item && parsed.decision === "approved" && item.currentDecision !== "approved") {
        await recordReviewAnalytics(tx, round.projectId, AnalyticsEventType.review_item_approved, round.id, item.clipId);
      }
      if (!item && parsed.decision === "approved" && round.decision !== "approved") {
        await recordReviewAnalytics(tx, round.projectId, AnalyticsEventType.campaign_approved, round.id);
      }
      if (parsed.decision === "changes_requested") {
        const firstChange = await tx.reviewRound.updateMany({
          where: { id: round.id, firstChangeRequestedAt: null },
          data: { firstChangeRequestedAt: decidedAt },
        });
        if (firstChange.count === 1) {
          await recordReviewAnalytics(tx, round.projectId, AnalyticsEventType.review_changes_requested, round.id, item?.clipId);
        }
      }
      const creator = await tx.user.findUnique({
        where: { id: round.createdByUserId },
        select: { primaryEmail: true },
      });
      const recipientEmail = creator?.primaryEmail?.trim().toLowerCase();
      if (recipientEmail && parsed.decision === "changes_requested") {
        await tx.reviewNotificationLedger.upsert({
          where: { reviewRoundId_recipientEmail_kind_scopeKey: {
            reviewRoundId: round.id,
            recipientEmail,
            kind: "first_change_requested",
            scopeKey: "round",
          } },
          update: {},
          create: { reviewRoundId: round.id, recipientEmail, kind: "first_change_requested", scopeKey: "round" },
        });
      }
      const decisionsAfterChange = currentItems.map((candidate) =>
        candidate.id === item?.id ? { ...candidate, currentDecision: parsed.decision } : candidate,
      );
      const requiredAfterChange = decisionsAfterChange.filter((candidate) => candidate.required);
      if (
        recipientEmail &&
        requiredAfterChange.length > 0 &&
        requiredAfterChange.every((candidate) => candidate.currentDecision === "approved")
      ) {
        await tx.reviewNotificationLedger.upsert({
          where: { reviewRoundId_recipientEmail_kind_scopeKey: {
            reviewRoundId: round.id,
            recipientEmail,
            kind: "all_approved",
            scopeKey: "round",
          } },
          update: {},
          create: { reviewRoundId: round.id, recipientEmail, kind: "all_approved", scopeKey: "round" },
        });
      }
      return decision;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  async addInternalComment(
    scope: { workspaceId: string; projectId: string; actorUserId: string },
    roundId: string,
    input: unknown,
  ) {
    const parsed = internalReviewCommentSchema.parse(input);
    return requirePrisma().$transaction(async (tx) => {
      const round = await tx.reviewRound.findFirst({
        where: { id: roundId, workspaceId: scope.workspaceId, projectId: scope.projectId },
        include: { comments: true, items: { select: { id: true } } },
      });
      if (!round) throw new ReviewServiceError("review_round_not_found", "Review round was not found");
      if (parsed.itemId && !round.items.some((item) => item.id === parsed.itemId)) {
        throw new ReviewServiceError("review_item_not_found", "Review item was not found");
      }
      if (parsed.parentId) {
        const parent = round.comments.find((comment) => comment.id === parsed.parentId);
        if (!parent || parent.parentId || parent.itemId !== parsed.itemId) {
          throw new ReviewServiceError("review_thread_invalid", "Replies can only be one level deep within the same review item");
        }
      }
      const actor = await tx.user.findUnique({
        where: { id: scope.actorUserId },
        select: { firstName: true, lastName: true, primaryEmail: true },
      });
      const authorName = [actor?.firstName, actor?.lastName].filter(Boolean).join(" ") || actor?.primaryEmail || "Narriflow team";
      const comment = await tx.reviewComment.create({ data: {
        reviewRoundId: round.id,
        itemId: parsed.itemId,
        parentId: parsed.parentId,
        authorKind: "internal",
        authorName,
        authorGrantHash: createHash("sha256").update(`internal:${scope.actorUserId}`).digest("hex"),
        body: parsed.body,
        timestampSec: parsed.timestampSec,
      } });
      await tx.reviewAuditEvent.create({ data: {
        reviewRoundId: round.id,
        kind: "internal_reply_created",
        targetId: comment.id,
        metadata: { actorUserId: scope.actorUserId },
      } });
      const configuredRecipients = new Set(normalizeRecipientEmails(
        Array.isArray(round.recipientEmails)
          ? round.recipientEmails.filter((value): value is string => typeof value === "string")
          : [],
      ));
      const mentions = normalizeRecipientEmails(parsed.mentionRecipients)
        .filter((recipientEmail) => configuredRecipients.has(recipientEmail));
      if (mentions.length > 0) {
        await tx.reviewNotificationLedger.createMany({
          data: mentions.map((recipientEmail) => ({
            reviewRoundId: round.id,
            recipientEmail,
            kind: "mention",
            scopeKey: comment.id,
          })),
          skipDuplicates: true,
        });
      }
      return comment;
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
      await recordReviewAnalytics(tx, scope.projectId, AnalyticsEventType.review_revoked, roundId);
      return { revoked: true };
    });
  }

  async internalProjection(workspaceId: string, projectId: string) {
    const rounds = await requirePrisma().reviewRound.findMany({
      where: { workspaceId, projectId },
      include: { items: { include: {
        export: { select: { fingerprint: true } },
        clip: { select: {
          editorRevision: true,
          exports: { where: { status: "ready" }, orderBy: { createdAt: "desc" }, take: 1, select: { fingerprint: true } },
        } },
      } } },
      orderBy: { revision: "desc" },
    });
    const now = new Date();
    return rounds.map((round) => ({
      ...round,
      status: deriveReviewRoundStatus(round, now),
      newerWorkAvailable: round.items.some((item) =>
        item.clip.editorRevision > item.editorRevision ||
        (item.clip.exports[0] !== undefined && item.clip.exports[0].fingerprint !== item.export.fingerprint)),
    }));
  }

  async recordExpiredRounds(limit = 100, now = new Date()) {
    const requestedLimit = Number.isFinite(limit) ? Math.floor(limit) : 100;
    const boundedLimit = Math.max(1, Math.min(500, requestedLimit));
    const rounds = await requirePrisma().reviewRound.findMany({
      where: {
        status: "open",
        revokedAt: null,
        expiryRecordedAt: null,
        expiresAt: { lte: now },
      },
      orderBy: { expiresAt: "asc" },
      take: boundedLimit,
      select: { id: true },
    });
    const recorded = await Promise.all(rounds.map((round) => recordReviewExpiry(round.id, now)));
    return recorded.filter(Boolean).length;
  }

  async internalRoom(workspaceId: string, projectId: string, access: "manage" | "view") {
    const prisma = requirePrisma();
    const expiredRounds = await prisma.reviewRound.findMany({
      where: {
        workspaceId,
        projectId,
        status: "open",
        revokedAt: null,
        expiryRecordedAt: null,
        expiresAt: { lte: new Date() },
      },
      select: { id: true },
    });
    await Promise.all(expiredRounds.map((round) => recordReviewExpiry(round.id)));
    const [project, rounds, clips] = await Promise.all([
      prisma.project.findFirst({
        where: { id: projectId, workspaceId },
        select: { title: true, brandProfileSnapshot: true, workspace: { select: { name: true } } },
      }),
      prisma.reviewRound.findMany({
        where: { workspaceId, projectId },
        orderBy: { revision: "desc" },
        include: {
          items: { orderBy: { position: "asc" }, include: {
            clip: { select: { id: true, title: true, editorRevision: true, exports: { where: { status: "ready" }, orderBy: { createdAt: "desc" }, take: 1, select: { fingerprint: true } } } },
            export: { select: { id: true, fingerprint: true, editorRevision: true, variants: { where: { status: "completed" }, select: { id: true, aspectRatio: true, durationSec: true } } } },
          } },
          comments: { orderBy: { createdAt: "asc" }, select: { id: true, itemId: true, parentId: true, authorKind: true, authorName: true, body: true, timestampSec: true, resolvedAt: true, editedAt: true, createdAt: true } },
          guests: { orderBy: { firstSeenAt: "asc" }, select: { id: true, displayName: true, emailEncrypted: true, firstSeenAt: true, lastSeenAt: true } },
          auditEvents: { orderBy: { createdAt: "desc" }, select: { id: true, kind: true, targetId: true, metadata: true, createdAt: true } },
          notificationLedgers: { orderBy: { createdAt: "asc" }, select: { id: true, recipientEmail: true, kind: true, status: true, attemptCount: true, failureCode: true, sentAt: true, createdAt: true } },
          contextLinks: {
            orderBy: { createdAt: "asc" },
            include: {
              sourceComment: {
                select: {
                  id: true,
                  authorName: true,
                  body: true,
                  timestampSec: true,
                  reviewRound: { select: { revision: true } },
                  item: { select: { clip: { select: { title: true } } } },
                },
              },
            },
          },
        },
      }),
      prisma.clip.findMany({
        where: { projectId, exports: { some: { status: "ready" } } },
        orderBy: { index: "asc" },
        select: {
          id: true,
          title: true,
          editorRevision: true,
          exports: { where: { status: "ready" }, orderBy: { createdAt: "desc" }, select: {
            id: true,
            editorRevision: true,
            createdAt: true,
            variants: { where: { status: "completed" }, select: { id: true, aspectRatio: true, durationSec: true } },
          } },
        },
      }),
    ]);
    if (!project) throw new ReviewServiceError("review_project_not_found", "Project was not found");
    const deliverySecret = access === "manage" ? reviewDeliverySecret() : null;
    const now = new Date();
    return {
      project: {
		title: project.title,
		workspace: project.workspace,
		approvalRequiredByDefault: brandApprovalRequiredByDefault(
			project.brandProfileSnapshot,
		),
	  },
      candidates: access === "manage" ? clips : [],
      rounds: rounds.map((round) => {
        const recipientEmails = normalizeRecipientEmails(
          Array.isArray(round.recipientEmails)
            ? round.recipientEmails.filter((value): value is string => typeof value === "string")
            : [],
        );
        return {
          id: round.id,
          revision: round.revision,
          title: round.title,
          message: round.message,
          status: deriveReviewRoundStatus(round, now),
          path: deliverySecret
            ? `/review/${decryptReviewValue(round.deliveryTokenEncrypted, deliverySecret)}`
            : null,
          allowDownloads: round.allowDownloads,
          approvalRequired: round.approvalRequired,
          recipientEmails: access === "manage" ? recipientEmails : [],
          sentAt: round.sentAt,
          expiresAt: round.expiresAt,
          revokedAt: round.revokedAt,
          decision: round.decision,
          newerWorkAvailable: round.items.some((item) =>
            item.clip.editorRevision > item.editorRevision ||
            (item.clip.exports[0] !== undefined && item.clip.exports[0].fingerprint !== item.export.fingerprint)),
          items: round.items.map((item) => ({
            id: item.id,
            clipId: item.clipId,
            clipTitle: item.clip.title,
            exportId: item.exportId,
            editorRevision: item.editorRevision,
            required: item.required,
            currentDecision: item.currentDecision,
            variants: item.export.variants,
          })),
          comments: round.comments.map((comment) => ({
            ...comment,
            authorName: access === "manage"
              ? comment.authorName
              : comment.authorKind === "guest" ? "Client reviewer" : "Narriflow team",
          })),
          guests: round.guests.map((guest) => ({
            id: guest.id,
            displayName: access === "manage" ? guest.displayName : null,
            email: deliverySecret ? decryptReviewValue(guest.emailEncrypted, deliverySecret) : null,
            firstSeenAt: guest.firstSeenAt,
            lastSeenAt: guest.lastSeenAt,
          })),
          auditEvents: access === "manage" ? round.auditEvents : [],
          notifications: access === "manage" ? round.notificationLedgers : [],
          context: access === "manage" ? round.contextLinks.map((link) => ({
            id: link.id,
            sourceCommentId: link.sourceComment.id,
            sourceRoundRevision: link.sourceComment.reviewRound.revision,
            authorName: link.sourceComment.authorName,
            body: link.sourceComment.body,
            timestampSec: link.sourceComment.timestampSec,
            clipTitle: link.sourceComment.item?.clip.title ?? null,
          })) : [],
        };
      }),
    };
  }
}

export const reviewService = new ReviewService();
