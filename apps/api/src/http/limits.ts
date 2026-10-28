import {
  ExpectedDomainFailureError,
  requireNewMutationAllowed,
} from "@narriflow/services";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ApiEnv } from "./env";
import { failureResponse, jsonError, payloadTooLargeResponse, requestIdOf } from "./errors";
import type {
  AuthenticatedActorScope,
  RateLimitCheck,
  RateLimitRule,
  RecordedRateLimit,
} from "./request-policy";

const KIB = 1024;

/** Streaming request-body ceilings by route class. Media uploads never pass through the API. */
export const BODY_LIMIT_BYTES = {
  /** Review guest access and opt-out. */
  guest: 32 * KIB,
  /** Ordinary controls and public REST. */
  control: 1024 * KIB,
  /** Clerk, Stripe, TikTok and Zoom webhooks. */
  webhook: 1024 * KIB,
  /** Studio document and bulk campaign writes. Also Bun's process maximum. */
  editor: 8 * 1024 * KIB,
} as const;
export type BodyLimitClass = keyof typeof BODY_LIMIT_BYTES;

export const MAX_REQUEST_URL_BYTES = 8 * KIB;
export const MAX_REQUEST_HEADER_BYTES = 32 * KIB;

/**
 * Rejects an oversized body even when it is chunked or lies about
 * Content-Length: Hono counts the bytes as they stream, before any handler
 * reads, clones or parses the body.
 */
export function limitBody(limitClass: BodyLimitClass): MiddlewareHandler<ApiEnv> {
  return bodyLimit({
    maxSize: BODY_LIMIT_BYTES[limitClass],
    onError: (c) => payloadTooLargeResponse(requestIdOf(c as Context<ApiEnv>)),
  }) as MiddlewareHandler<ApiEnv>;
}

const encoder = new TextEncoder();

/** Bounded safe failures for oversized URLs (414) and header blocks (431) at application ingress. */
export function limitRequestEnvelope(): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const url = new URL(c.req.url);
    if (encoder.encode(url.pathname + url.search).byteLength > MAX_REQUEST_URL_BYTES) {
      return jsonError(414, "uri_too_long", "The request URL is too long.", requestIdOf(c));
    }
    let headerBytes = 0;
    for (const [name, value] of c.req.raw.headers) {
      headerBytes += encoder.encode(name).byteLength + encoder.encode(value).byteLength + 4;
      if (headerBytes > MAX_REQUEST_HEADER_BYTES) {
        return jsonError(
          431,
          "request_headers_too_large",
          "The request headers are too large.",
          requestIdOf(c),
        );
      }
    }
    await next();
  };
}

/** Fixed windows of the new first-party tiers. Existing per-operation limits live in each declaration. */
export const RATE_TIERS = {
  read: { limit: 300, windowSeconds: 60 },
  mutation: { limit: 60, windowSeconds: 60 },
  /** Per actor, Workspace and clip. */
  editor: { limit: 120, windowSeconds: 60 },
  /** Per actor, across every clip. */
  editorGlobal: { limit: 300, windowSeconds: 60 },
  streamStart: { limit: 30, windowSeconds: 60 },
  publicRead: { limit: 60, windowSeconds: 60 },
  guestExchange: { limit: 30, windowSeconds: 60 },
  adminRead: { limit: 60, windowSeconds: 60 },
  adminMutation: { limit: 10, windowSeconds: 60 },
} as const;

/**
 * `editor` is the Studio document PUT/reset: it has its own bucket and is
 * exempt from the ordinary mutation bucket. `none` is for routes whose own
 * rules fully describe their cost, such as signature webhooks.
 */
export type RateTier = "read" | "mutation" | "editor" | "stream" | "none";

export function defaultTierForMethod(method: string): "read" | "mutation" {
  return method === "GET" || method === "HEAD" ? "read" : "mutation";
}

type BaselineActor = AuthenticatedActorScope & { workspaceId?: string };

function scopeOf(actor: BaselineActor): string {
  return actor.workspaceId
    ? `${actor.workspaceId}:${actor.actorUserId}`
    : actor.actorUserId;
}

/**
 * The baseline rules a tier adds ahead of a declaration's own operation limit.
 * Keys include the Workspace so tenants never share a bucket.
 */
export function baselineRateRules(
  tier: RateTier,
  options: { editorClipId?: string } = {},
): RateLimitRule<BaselineActor>[] {
  switch (tier) {
    case "none":
      return [];
    case "read":
    case "mutation":
      return [
        {
          key: (actor) => `api-${tier}:${scopeOf(actor)}`,
          ...RATE_TIERS[tier],
        },
      ];
    case "stream":
      return [
        {
          key: (actor) => `api-stream:${actor.actorUserId}`,
          ...RATE_TIERS.streamStart,
        },
      ];
    case "editor": {
      if (!options.editorClipId) {
        throw new Error("The editor tier requires the clip identifier");
      }
      const clipId = options.editorClipId;
      return [
        {
          key: (actor) => `api-editor:${scopeOf(actor)}:${clipId}`,
          ...RATE_TIERS.editor,
        },
        {
          key: (actor) => `api-editor-global:${actor.actorUserId}`,
          ...RATE_TIERS.editorGlobal,
        },
      ];
    }
  }
}

/**
 * Enforces the limiter outcome the policy recorded, for a command that has
 * already ruled out an immutable replay. Call it from the receipt's
 * `beforeAccept` (after the locked recheck): exhausted counters answer 429 with
 * window guidance, and an unavailable limiter pauses new work with
 * 503 `mutations_unavailable` rather than failing open.
 */
export function enforceRecordedRateLimit(
  recorded: RecordedRateLimit | null | undefined,
): void {
  if (!recorded) return;
  if (!recorded.allowed) {
    throw new ExpectedDomainFailureError({
      code: "rate_limited",
      kind: "rate_limited",
      message: "Too many requests. Wait before trying again.",
      retryAfterSeconds: recorded.retryAfterSeconds ?? 60,
    });
  }
  requireNewMutationAllowed({
    allowed: true,
    availability: recorded.availability,
    remaining: recorded.remaining ?? 0,
    limit: recorded.limit ?? 0,
  });
}

/** `RateLimit-*` headers for the most constraining window of a request. */
export function rateLimitHeaders(
  recorded: RecordedRateLimit | null | undefined,
): Record<string, string> {
  if (
    !recorded ||
    recorded.availability !== "available" ||
    recorded.limit === undefined ||
    recorded.remaining === undefined ||
    recorded.resetSeconds === undefined
  ) {
    return {};
  }
  return {
    "RateLimit-Limit": String(recorded.limit),
    "RateLimit-Remaining": String(Math.max(0, recorded.remaining)),
    "RateLimit-Reset": String(recorded.resetSeconds),
  };
}

export interface ClientIpOptions {
  /**
   * The single header the deployment's trusted ingress overwrites with the
   * client address (for Railway, `X-Real-IP`). Null trusts no forwarded header.
   */
  trustedHeader: string | null;
  /** The socket peer, used when no trusted header applies. */
  socketAddress?: string | undefined;
}

/** Resolves the client IP for unauthenticated limits. Arbitrary forwarded headers are never trusted. */
export function trustedIngressIp(
  headers: Headers,
  options: ClientIpOptions,
): string {
  const forwarded = options.trustedHeader
    ? headers.get(options.trustedHeader)?.trim()
    : undefined;
  return (forwarded || options.socketAddress || "unknown").slice(0, 64);
}

/** Per-IP limiter for public share/guest reads and guest credential exchange. */
export function ipRateLimit(options: {
  prefix: string;
  tier: "publicRead" | "guestExchange";
  clientIp(c: Context<ApiEnv>): string;
  rateLimit(input: {
    key: string;
    limit: number;
    windowSeconds: number;
  }): Promise<RateLimitCheck>;
}): MiddlewareHandler<ApiEnv> {
  const { limit, windowSeconds } = RATE_TIERS[options.tier];
  return async (c, next) => {
    const check = await options.rateLimit({
      key: `${options.prefix}:${options.clientIp(c)}`,
      limit,
      windowSeconds,
    });
    if (!check.allowed) {
      return failureResponse({
        code: "rate_limited",
        category: "rate_limit",
        status: 429,
        message: "Too many requests. Wait before trying again.",
        requestId: requestIdOf(c),
        retryAfterSeconds: Math.max(
          1,
          Math.ceil(check.retryAfterSeconds ?? windowSeconds),
        ),
      });
    }
    await next();
  };
}
