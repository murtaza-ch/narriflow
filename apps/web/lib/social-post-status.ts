/**
 * Display + polling logic for scheduled social posts.
 *
 * The publish tab renders a server snapshot, but a post's real state changes
 * in the worker (`apps/worker/src/tasks/social-publisher.ts`) with no SSE
 * channel of its own — the project stream only carries `workflow.stage.updated`
 * events for pipeline stages. So the panel polls while a post is still in the
 * worker's hands, and these pure helpers decide what to say and how often to
 * ask. Kept free of React so they're unit testable.
 */

import {
  USER_ERROR_MESSAGES,
  type SocialPlatform,
  type SocialPostSnapshot,
} from "@narriflow/validators";
import { formatDateTime } from "./format";

export const SOCIAL_PLATFORM_LABELS: Record<SocialPlatform, string> = {
  tiktok: "TikTok",
  youtube_shorts: "YouTube Shorts",
  instagram_reels: "Instagram Reels",
  linkedin: "LinkedIn",
  x: "X",
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The publish loop polls every few seconds, so a due post should leave
 *  `scheduled` almost immediately. Past this grace window the post is stuck
 *  (no worker running, or one that keeps crashing) and the row says so
 *  instead of showing a reassuring "publishing shortly" forever. */
export const SOCIAL_PUBLISH_GRACE_MS = 5 * MINUTE_MS;

export type SocialPostTone =
  | "neutral"
  | "accent"
  | "success"
  | "warning"
  | "danger";

export interface SocialPostFeedback {
  /** Human status label — never the raw enum value. */
  label: string;
  tone: SocialPostTone;
  /** Timing/outcome line: when it goes out, when it went out, or why not. */
  detail: string;
  /** Failure copy for a failed post; `null` otherwise. */
  error: string | null;
  /** The worker is actively working on this post right now (show a spinner). */
  isBusy: boolean;
  /** The row can still change without user action — keep polling. */
  isLive: boolean;
}

/** A post whose next state comes from the worker, not from the user. */
export function isLiveSocialPost(status: SocialPostSnapshot["status"]): boolean {
  return status === "scheduled" || status === "publishing";
}

/** Rounded, unit-suffixed distance between two instants: `40 min`, `3 hr`. */
export function formatTimeDistance(deltaMs: number): string {
  const abs = Math.abs(deltaMs);
  if (abs < 45_000) return "less than a minute";
  if (abs < HOUR_MS) {
    return `${Math.max(1, Math.round(abs / MINUTE_MS))} min`;
  }
  if (abs < DAY_MS) {
    const hours = Math.round(abs / HOUR_MS);
    return `${hours} hr`;
  }
  const days = Math.round(abs / DAY_MS);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * Friendly copy for a publish failure code, or `null` when there's no code.
 *
 * Unlike `userErrorMessage`, an unmapped code isn't flattened into the generic
 * "something went wrong" line — it's echoed so the row (and any support
 * ticket) still names the platform's actual rejection.
 */
export function publishFailureMessage(
  errorCode: string | null,
): string | null {
  if (!errorCode) return null;
  return (
    USER_ERROR_MESSAGES[errorCode] ??
    `Publishing failed (${errorCode}). Schedule it again, or contact support if it keeps failing.`
  );
}

type SocialPostFeedbackInput = Pick<
  SocialPostSnapshot,
  "status" | "platform" | "scheduledFor" | "postedAt" | "errorCode"
>;

function timestampOf(value: string | null): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Builds the row copy for one social post.
 *
 * @param post - The post snapshot (status, platform, timestamps, error code).
 * @param nowMs - Current time, or `null` before the client has mounted. When
 *   `null`, relative phrasing ("in 12 min") is omitted so the server-rendered
 *   markup matches the first client render.
 */
export function describeSocialPost(
  post: SocialPostFeedbackInput,
  nowMs: number | null,
): SocialPostFeedback {
  const platformLabel = SOCIAL_PLATFORM_LABELS[post.platform];
  const scheduledAt = timestampOf(post.scheduledFor);
  const postedAt = timestampOf(post.postedAt);

  switch (post.status) {
    case "draft":
      return {
        label: "Draft",
        tone: "neutral",
        detail: "Saved as a draft — no publish time set.",
        error: null,
        isBusy: false,
        isLive: false,
      };

    case "scheduled": {
      if (scheduledAt === null) {
        return {
          label: "Queued",
          tone: "accent",
          detail: `Publishing to ${platformLabel} on the next pass.`,
          error: null,
          isBusy: true,
          isLive: true,
        };
      }

      const goesOut = `Goes out ${formatDateTime(post.scheduledFor!)}`;
      if (nowMs === null) {
        return {
          label: "Scheduled",
          tone: "accent",
          detail: goesOut,
          error: null,
          isBusy: false,
          isLive: true,
        };
      }

      const overdueBy = nowMs - scheduledAt;
      if (overdueBy > SOCIAL_PUBLISH_GRACE_MS) {
        return {
          label: "Late",
          tone: "warning",
          detail: `Due ${formatTimeDistance(overdueBy)} ago and not picked up yet — the publisher may be down.`,
          error: null,
          isBusy: false,
          isLive: true,
        };
      }
      if (overdueBy >= 0) {
        return {
          label: "Due now",
          tone: "accent",
          detail: `Handing off to ${platformLabel} — this usually takes under a minute.`,
          error: null,
          isBusy: true,
          isLive: true,
        };
      }

      return {
        label: "Scheduled",
        tone: "accent",
        detail: `${goesOut} · in ${formatTimeDistance(overdueBy)}`,
        error: null,
        isBusy: false,
        isLive: true,
      };
    }

    case "publishing":
      return {
        label: "Publishing",
        tone: "accent",
        detail: `Uploading to ${platformLabel}…`,
        error: null,
        isBusy: true,
        isLive: true,
      };

    case "posted": {
      if (postedAt === null) {
        return {
          label: "Published",
          tone: "success",
          detail: `Live on ${platformLabel}.`,
          error: null,
          isBusy: false,
          isLive: false,
        };
      }
      const published = `Published ${formatDateTime(post.postedAt!)}`;
      return {
        label: "Published",
        tone: "success",
        detail:
          nowMs === null
            ? published
            : `${published} · ${formatTimeDistance(nowMs - postedAt)} ago`,
        error: null,
        isBusy: false,
        isLive: false,
      };
    }

    case "failed":
      return {
        label: "Failed",
        tone: "danger",
        detail: `${platformLabel} didn't accept this post.`,
        // Unmapped provider codes keep the raw code in the copy: it's the one
        // thing that makes a support conversation about a platform-specific
        // rejection (there are ~35 of them) actionable.
        error:
          publishFailureMessage(post.errorCode) ??
          `${platformLabel} rejected this post. Schedule it again, or contact support if it keeps failing.`,
        isBusy: false,
        isLive: false,
      };

    case "cancelled":
      return {
        label: "Canceled",
        tone: "neutral",
        detail: "Canceled before publishing.",
        error: null,
        isBusy: false,
        isLive: false,
      };
  }
}

/**
 * How long to wait before re-fetching the post list, or `null` when nothing
 * is live and polling should stop. Tightens as a post approaches its slot so
 * the "Publishing → Published" transition is visible without hammering the
 * API while a post is hours out.
 */
export function socialPollDelayMs(
  posts: readonly SocialPostFeedbackInput[],
  nowMs: number,
): number | null {
  let delay: number | null = null;
  const tighten = (candidate: number) => {
    delay = delay === null ? candidate : Math.min(delay, candidate);
  };

  for (const post of posts) {
    if (!isLiveSocialPost(post.status)) continue;

    if (post.status === "publishing") {
      tighten(3_000);
      continue;
    }

    const scheduledAt = timestampOf(post.scheduledFor);
    if (scheduledAt === null) {
      tighten(3_000);
      continue;
    }

    const untilDue = scheduledAt - nowMs;
    if (untilDue <= 0) tighten(3_000);
    else if (untilDue <= 2 * MINUTE_MS) tighten(10_000);
    else tighten(30_000);
  }

  return delay;
}
