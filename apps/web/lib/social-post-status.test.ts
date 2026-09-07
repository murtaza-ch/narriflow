import { describe, expect, test } from "bun:test";
import {
  describeSocialPost,
  formatTimeDistance,
  isLiveSocialPost,
  isLiveSocialPostSnapshot,
  socialPollDelayMs,
  SOCIAL_PUBLISH_GRACE_MS,
} from "./social-post-status";

const NOW = Date.UTC(2026, 6, 29, 18, 0, 0);

type Post = Parameters<typeof describeSocialPost>[0];

function post(overrides: Partial<Post> = {}): Post {
  return {
    status: "scheduled",
    platform: "youtube_shorts",
    scheduledFor: new Date(NOW + 10 * 60_000).toISOString(),
    postedAt: null,
    errorCode: null,
    errorDisposition: null,
    nextAttemptAt: null,
    providerProcessingStatus: null,
    ...overrides,
  };
}

describe("formatTimeDistance", () => {
  test("rounds to a readable unit in both directions", () => {
    expect(formatTimeDistance(20_000)).toBe("less than a minute");
    expect(formatTimeDistance(-20_000)).toBe("less than a minute");
    expect(formatTimeDistance(9 * 60_000)).toBe("9 min");
    expect(formatTimeDistance(-9 * 60_000)).toBe("9 min");
    expect(formatTimeDistance(2.4 * 3_600_000)).toBe("2 hr");
    expect(formatTimeDistance(26 * 3_600_000)).toBe("1 day");
    expect(formatTimeDistance(50 * 3_600_000)).toBe("2 days");
  });

  test("never rounds a sub-minute-but-not-tiny gap down to zero", () => {
    expect(formatTimeDistance(50_000)).toBe("1 min");
  });
});

describe("describeSocialPost", () => {
  test("a future post shows its slot and a countdown", () => {
    const feedback = describeSocialPost(post(), NOW);
    expect(feedback.label).toBe("Scheduled");
    expect(feedback.detail).toContain("Goes out");
    expect(feedback.detail).toContain("in 10 min");
    expect(feedback.isLive).toBe(true);
    expect(feedback.isBusy).toBe(false);
  });

  test("omits relative phrasing before the client knows the time", () => {
    const feedback = describeSocialPost(post(), null);
    expect(feedback.detail).toContain("Goes out");
    expect(feedback.detail).not.toContain("in 10 min");
  });

  test("a just-due post reads as handing off, not as waiting", () => {
    const feedback = describeSocialPost(
      post({ scheduledFor: new Date(NOW - 30_000).toISOString() }),
      NOW,
    );
    expect(feedback.label).toBe("Due now");
    expect(feedback.isBusy).toBe(true);
    expect(feedback.detail).toContain("YouTube Shorts");
  });

  test("a post past the grace window is called out as late", () => {
    const feedback = describeSocialPost(
      post({
        scheduledFor: new Date(
          NOW - SOCIAL_PUBLISH_GRACE_MS - 4 * 60_000,
        ).toISOString(),
      }),
      NOW,
    );
    expect(feedback.label).toBe("Late");
    expect(feedback.tone).toBe("warning");
    expect(feedback.detail).toContain("9 min ago");
    expect(feedback.isLive).toBe(true);
  });

  test("safe automatic retry timing uses nextAttemptAt instead of the original slot", () => {
    const feedback = describeSocialPost(
      post({
        scheduledFor: new Date(NOW - 60 * 60_000).toISOString(),
        nextAttemptAt: new Date(NOW + 2 * 60_000).toISOString(),
        errorDisposition: "safe_retry",
        errorCode: "provider_rate_limited",
      }),
      NOW,
    );
    expect(feedback.label).toBe("Retry scheduled");
    expect(feedback.detail).toContain("in 2 min");
    expect(feedback.detail).not.toContain("publisher may be down");
    expect(feedback.isLive).toBe(true);
  });

  test("preparation, publishing, processing, and reconciliation stay visibly live", () => {
    const preparing = describeSocialPost(post({ status: "preparing_video" }), NOW);
    expect(preparing.label).toBe("Preparing video");
    expect(preparing.isBusy).toBe(true);

    const feedback = describeSocialPost(post({ status: "publishing" }), NOW);
    expect(feedback.label).toBe("Publishing");
    expect(feedback.isBusy).toBe(true);
    expect(feedback.isLive).toBe(true);

    const processing = describeSocialPost(post({ status: "processing" }), NOW);
    expect(processing.label).toBe("Processing on provider");
    expect(processing.detail).toContain("YouTube Shorts");

    const reconciling = describeSocialPost(post({ status: "reconciling" }), NOW);
    expect(reconciling.label).toBe("Checking outcome");
    expect(reconciling.tone).toBe("warning");
  });

  test("operator attention is terminal and never suggests an unsafe retry", () => {
    const feedback = describeSocialPost(
      post({
        status: "needs_attention",
        errorCode: "publication_outcome_unknown",
        errorDisposition: "attention",
      }),
      NOW,
    );
    expect(feedback.label).toBe("Needs attention");
    expect(feedback.isLive).toBe(false);
    expect(feedback.detail).toContain("could already be live");
    expect(feedback.error).not.toContain("Schedule it again");
  });

  test("names provider lookup limitations instead of implying automatic proof", () => {
    const linkedin = describeSocialPost(
      post({
        platform: "linkedin",
        status: "needs_attention",
        errorCode: "linkedin_reconciliation_permission_missing",
        errorDisposition: "attention",
      }),
      NOW,
    );
    expect(linkedin.error).toContain("read permission");
    expect(linkedin.error).toContain("author-and-video");

    const x = describeSocialPost(
      post({
        platform: "x",
        status: "needs_attention",
        errorCode: "x_reconciliation_permission_missing",
        errorDisposition: "attention",
      }),
      NOW,
    );
    expect(x.error).toContain("product tier");
    expect(x.error).toContain("recent-post lookup");
  });

  test("published shows when it went out and stops polling", () => {
    const feedback = describeSocialPost(
      post({
        status: "posted",
        postedAt: new Date(NOW - 6 * 60_000).toISOString(),
      }),
      NOW,
    );
    expect(feedback.label).toBe("Published");
    expect(feedback.tone).toBe("success");
    expect(feedback.detail).toContain("6 min ago");
    expect(feedback.isLive).toBe(false);
  });

  test("failure surfaces mapped guidance without exposing unknown provider codes", () => {
    const known = describeSocialPost(
      post({ status: "failed", errorCode: "social_publish_failed" }),
      NOW,
    );
    expect(known.tone).toBe("danger");
    expect(known.error).toBe(
      "We couldn't publish to that platform. Please try again.",
    );

    const unknown = describeSocialPost(
      post({ status: "failed", errorCode: "x_media_processing_timeout" }),
      NOW,
    );
    expect(unknown.error).not.toContain("x_media_processing_timeout");
    expect(unknown.error).toContain("schedule it again");

    const missing = describeSocialPost(
      post({ status: "failed", errorCode: null }),
      NOW,
    );
    expect(missing.error).toContain("YouTube Shorts rejected this post");
  });

  test("no status renders its raw enum value", () => {
    const statuses: Post["status"][] = [
      "draft",
      "preparing_video",
      "scheduled",
      "publishing",
      "processing",
      "reconciling",
      "posted",
      "failed",
      "needs_attention",
      "cancelled",
    ];
    for (const status of statuses) {
      const feedback = describeSocialPost(post({ status }), NOW);
      expect(feedback.label).not.toBe(status);
      expect(feedback.detail.length).toBeGreaterThan(0);
    }
  });
});

describe("isLiveSocialPost", () => {
  test("every non-terminal publication state is live", () => {
    expect(isLiveSocialPost("preparing_video")).toBe(true);
    expect(isLiveSocialPost("scheduled")).toBe(true);
    expect(isLiveSocialPost("publishing")).toBe(true);
    expect(isLiveSocialPost("processing")).toBe(true);
    expect(isLiveSocialPost("reconciling")).toBe(true);
    expect(isLiveSocialPost("needs_attention")).toBe(false);
    expect(isLiveSocialPost("posted")).toBe(false);
    expect(isLiveSocialPost("failed")).toBe(false);
    expect(isLiveSocialPost("cancelled")).toBe(false);
    expect(isLiveSocialPost("draft")).toBe(false);
  });
});

describe("isLiveSocialPostSnapshot", () => {
  test("keeps an accepted YouTube post live until provider processing settles", () => {
    expect(
      isLiveSocialPostSnapshot(
        post({ status: "posted", providerProcessingStatus: "processing" }),
      ),
    ).toBe(true);
    expect(
      isLiveSocialPostSnapshot(
        post({ status: "posted", providerProcessingStatus: "succeeded" }),
      ),
    ).toBe(false);
    expect(isLiveSocialPostSnapshot(post({ status: "processing" }))).toBe(true);
  });
});

describe("socialPollDelayMs", () => {
  test("stops polling when every post is terminal", () => {
    expect(
      socialPollDelayMs(
        [post({ status: "posted" }), post({ status: "failed" })],
        NOW,
      ),
    ).toBeNull();
    expect(socialPollDelayMs([], NOW)).toBeNull();
  });

  test("tightens as the soonest post approaches its slot", () => {
    expect(
      socialPollDelayMs([post({ scheduledFor: new Date(NOW + 60 * 60_000).toISOString() })], NOW),
    ).toBe(30_000);
    expect(
      socialPollDelayMs([post({ scheduledFor: new Date(NOW + 90_000).toISOString() })], NOW),
    ).toBe(10_000);
    expect(
      socialPollDelayMs([post({ scheduledFor: new Date(NOW - 1_000).toISOString() })], NOW),
    ).toBe(3_000);
    expect(socialPollDelayMs([post({ status: "publishing" })], NOW)).toBe(3_000);
    expect(socialPollDelayMs([post({ status: "processing" })], NOW)).toBe(3_000);
    expect(socialPollDelayMs([post({ status: "reconciling" })], NOW)).toBe(3_000);
  });

  test("uses the fastest cadence any single live post asks for", () => {
    const delay = socialPollDelayMs(
      [
        post({ scheduledFor: new Date(NOW + 60 * 60_000).toISOString() }),
        post({ status: "publishing" }),
        post({ status: "posted" }),
      ],
      NOW,
    );
    expect(delay).toBe(3_000);
  });

  test("backs off provider polling according to the shared age policy", () => {
    expect(
      socialPollDelayMs(
        [post({ status: "processing", createdAt: new Date(NOW - 3 * 60_000).toISOString() })],
        NOW,
      ),
    ).toBe(10_000);
    expect(
      socialPollDelayMs(
        [post({ status: "reconciling", createdAt: new Date(NOW - 20 * 60_000).toISOString() })],
        NOW,
      ),
    ).toBe(30_000);
  });

  test("a scheduled post with no slot polls at the fast cadence", () => {
    expect(socialPollDelayMs([post({ scheduledFor: null })], NOW)).toBe(3_000);
  });
});
