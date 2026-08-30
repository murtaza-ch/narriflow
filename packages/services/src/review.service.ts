import { createCipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  createReviewRoundSchema,
  reviewCommentEditSchema,
  reviewCommentSchema,
  reviewDecisionSchema,
  reviewGuestAccessSchema,
  reviewSelectedVariantIdsSchema,
  type PricingTier,
} from "@narriflow/validators";
import { hasFeature } from "./plan-features";
import { assertProgramWriteEnabled } from "./program-rollout";
import { checkRateLimit } from "./rate-limit";
import { presignDownloadUrl } from "./r2-storage";

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

function encryptReviewEmail(email: string, secret: string) {
  const key = createHash("sha256").update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(email, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((value) => value.toString("base64url")).join(".");
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
    assertProgramWriteEnabled("review_rooms");
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
    const passcodeHash = parsed.passcode
      ? await hashReviewPasscode(parsed.passcode)
      : null;
    const round = await withSerializableRetry(() => prisma.$transaction(async (tx) => {
      const latest = await tx.reviewRound.aggregate({ where: { projectId: scope.projectId }, _max: { revision: true } });
      await tx.reviewRound.updateMany({ where: { projectId: scope.projectId, status: "open" }, data: { status: "superseded", supersededAt: new Date() } });
      return tx.reviewRound.create({ data: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        createdByUserId: scope.actorUserId,
        revision: (latest._max.revision ?? 0) + 1,
        title: parsed.title,
        message: parsed.message,
        allowDownloads: parsed.allowDownloads,
        approvalRequired: parsed.approvalRequired,
        accessTokenHash: tokenHash,
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
      }, select: { id: true, revision: true, createdAt: true } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
    return { ...round, token: rawToken, path: `/review/${rawToken}` };
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
    const round = await requirePrisma().reviewRound.findUnique({ where: { accessTokenHash: tokenHash }, select: { id: true, accessTokenHash: true, passcodeHash: true, status: true, expiresAt: true, revokedAt: true } });
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
        create: { reviewRoundId: round.id, displayName: parsed.identity, emailHash, emailEncrypted: encryptReviewEmail(normalizedEmail, secret), sessionGrantHash: reviewGrantHash(subject) },
        update: { displayName: parsed.identity, emailEncrypted: encryptReviewEmail(normalizedEmail, secret), sessionGrantHash: reviewGrantHash(subject), lastSeenAt: new Date() },
      });
      await tx.reviewAuditEvent.create({ data: { reviewRoundId: round.id, guestId: row.id, kind: "guest_authenticated" } });
      return row;
    });
    return issueReviewSession({ roundId: round.id, guestId: guest.id, grant: round.accessTokenHash.slice(0, 32), identity: guest.displayName, subject }, secret);
  }

  async readRound(session: string, secret: string) {
    const claims = verifyReviewSession(session, secret);
    const round = await requirePrisma().reviewRound.findUnique({
      where: { id: claims.roundId },
      include: { items: { orderBy: { position: "asc" }, include: { export: { select: { id: true, editorRevision: true, variants: { select: { id: true, aspectRatio: true, durationSec: true, status: true } } } } } }, comments: { orderBy: { createdAt: "asc" } } },
    });
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
      return decision;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
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
}

export const reviewService = new ReviewService();
