import { createHmac, timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import { publicationOperationLookupHash } from "./social-publication-attempt";

const MAX_SIGNATURE_AGE_SECONDS = 5 * 60;

export class TikTokPublicationWebhookError extends Error {
  constructor(
    readonly code:
      | "tiktok_webhook_signature_invalid"
      | "tiktok_webhook_signature_expired"
      | "tiktok_webhook_payload_invalid"
      | "tiktok_webhook_client_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "TikTokPublicationWebhookError";
  }
}

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  return prisma;
}

export function verifyTikTokWebhookSignature(input: {
  rawBody: string;
  signature: string | null;
  clientSecret: string;
  now: Date;
  maximumAgeSeconds?: number;
}) {
  const values = new Map(
    (input.signature ?? "").split(",").map((part) => {
      const separator = part.indexOf("=");
      return separator < 0
        ? [part.trim(), ""]
        : [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
    }),
  );
  const timestamp = values.get("t");
  const signature = values.get("s");
  if (!timestamp || !/^\d+$/.test(timestamp) || !signature || !/^[a-f0-9]{64}$/i.test(signature)) {
    throw new TikTokPublicationWebhookError(
      "tiktok_webhook_signature_invalid",
      "TikTok webhook signature is missing or malformed",
    );
  }
  const expected = createHmac("sha256", input.clientSecret)
    .update(`${timestamp}.${input.rawBody}`)
    .digest();
  const received = Buffer.from(signature, "hex");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new TikTokPublicationWebhookError(
      "tiktok_webhook_signature_invalid",
      "TikTok webhook signature does not match",
    );
  }
  const age = Math.abs(Math.floor(input.now.getTime() / 1000) - Number(timestamp));
  if (age > (input.maximumAgeSeconds ?? MAX_SIGNATURE_AGE_SECONDS)) {
    throw new TikTokPublicationWebhookError(
      "tiktok_webhook_signature_expired",
      "TikTok webhook signature is outside the replay window",
    );
  }
}

type TikTokPublicationEvent = {
  event:
    | "post.publish.complete"
    | "post.publish.publicly_available"
    | "post.publish.failed";
  publishId: string;
  postId: string | null;
  reason: string | null;
};

export function parseTikTokPublicationWebhook(
  rawBody: string,
  expectedClientKey: string,
): TikTokPublicationEvent | null {
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    throw new TikTokPublicationWebhookError(
      "tiktok_webhook_payload_invalid",
      "TikTok webhook body must be a JSON object",
    );
  }
  if (body.client_key !== expectedClientKey) {
    throw new TikTokPublicationWebhookError(
      "tiktok_webhook_client_mismatch",
      "TikTok webhook client key does not match",
    );
  }
  if (
    body.event !== "post.publish.complete" &&
    body.event !== "post.publish.publicly_available" &&
    body.event !== "post.publish.failed"
  ) {
    return null;
  }
  let content: Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(body.content ?? ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    content = parsed as Record<string, unknown>;
  } catch {
    throw new TikTokPublicationWebhookError(
      "tiktok_webhook_payload_invalid",
      "TikTok webhook content must be serialized JSON",
    );
  }
  const publishId = content.publish_id;
  if (typeof publishId !== "string" || publishId.length < 1 || publishId.length > 64) {
    throw new TikTokPublicationWebhookError(
      "tiktok_webhook_payload_invalid",
      "TikTok publication webhook is missing publish_id",
    );
  }
  const postId =
    typeof content.post_id === "string" || typeof content.post_id === "number"
      ? String(content.post_id)
      : null;
  const reason =
    typeof content.reason === "string" && content.reason.length <= 200
      ? content.reason
      : null;
  return { event: body.event, publishId, postId, reason };
}

export async function acceptTikTokPublicationWebhook(input: {
  rawBody: string;
  signature: string | null;
  clientKey: string;
  clientSecret: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  verifyTikTokWebhookSignature({
    rawBody: input.rawBody,
    signature: input.signature,
    clientSecret: input.clientSecret,
    now,
  });
  const event = parseTikTokPublicationWebhook(input.rawBody, input.clientKey);
  if (!event) return { kind: "ignored" as const };
  const lookupHash = publicationOperationLookupHash(`tiktok:${event.publishId}`);

  try {
    return await requirePrisma().$transaction(async (tx) => {
      const attempt = await tx.socialPublicationAttempt.findUnique({
        where: { operationLookupHash: lookupHash },
        include: {
          receipt: true,
          socialPost: { include: { socialAccount: { select: { handle: true } } } },
          frozenState: { select: { platform: true } },
        },
      });
      if (!attempt || attempt.frozenState.platform !== "tiktok") {
        return { kind: "unknown_operation" as const };
      }
      if (attempt.phase === "succeeded" || attempt.receipt) {
        return { kind: "already_settled" as const, attemptId: attempt.id };
      }
      if (event.event === "post.publish.failed") {
        const updated = await tx.socialPublicationAttempt.updateMany({
          where: {
            id: attempt.id,
            phase: { in: ["uploading", "submission_started", "processing", "reconciling"] },
          },
          data: {
            phase: "failed",
            outcome: "failed",
            failureCode: event.reason
              ? `tiktok_${event.reason}`
              : "tiktok_publish_failed",
            failureDisposition: "permanent",
            terminalAt: now,
          },
        });
        if (updated.count !== 1) {
          return { kind: "already_settled" as const, attemptId: attempt.id };
        }
        await tx.socialPost.updateMany({
          where: {
            id: attempt.socialPostId,
            status: { in: ["publishing", "processing", "reconciling"] },
          },
          data: {
            status: "failed",
            errorCode: event.reason
              ? `tiktok_${event.reason}`
              : "tiktok_publish_failed",
            errorDisposition: "permanent",
            nextAttemptAt: null,
          },
        });
        return { kind: "failed" as const, attemptId: attempt.id };
      }

      const updated = await tx.socialPublicationAttempt.updateMany({
        where: {
          id: attempt.id,
          phase: { in: ["uploading", "submission_started", "processing", "reconciling"] },
        },
        data: {
          phase: "succeeded",
          outcome: "accepted",
          failureCode: null,
          failureDisposition: null,
          terminalAt: now,
        },
      });
      if (updated.count !== 1) {
        return { kind: "already_settled" as const, attemptId: attempt.id };
      }
      const username = attempt.socialPost.socialAccount?.handle?.replace(/^@/, "");
      const externalUrl =
        event.postId && username
          ? `https://www.tiktok.com/@${username}/video/${event.postId}`
          : null;
      await tx.providerReceipt.create({
        data: {
          attemptId: attempt.id,
          platform: "tiktok",
          receiptId: event.publishId,
          platformPostId: event.postId,
          externalUrl,
          metrics: Prisma.JsonNull,
        },
      });
      await tx.publicationAnalyticsIntent.create({
        data: {
          attemptId: attempt.id,
          socialPostId: attempt.socialPostId,
          projectId: attempt.socialPost.projectId,
          kind: "social_posted",
          payload: { platform: "tiktok", evidence: "verified_webhook" },
          deliveredAt: now,
        },
      });
      await tx.projectAnalyticsEvent.create({
        data: {
          projectId: attempt.socialPost.projectId,
          clipId: attempt.socialPost.clipId,
          type: "social_posted",
          platform: "tiktok",
          metadata: {
            socialPostId: attempt.socialPostId,
            attemptId: attempt.id,
            evidence: "verified_webhook",
          },
        },
      });
      await tx.socialPost.update({
        where: { id: attempt.socialPostId },
        data: {
          status: "posted",
          postedAt: now,
          externalUrl,
          errorCode: null,
          errorDisposition: null,
          nextAttemptAt: null,
        },
      });
      return { kind: "posted" as const, attemptId: attempt.id };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { kind: "already_settled" as const };
    }
    throw error;
  }
}
