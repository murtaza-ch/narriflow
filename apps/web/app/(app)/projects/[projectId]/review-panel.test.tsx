import { describe, expect, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import { renderToStaticMarkup } from "react-dom/server";
import {
  isReviewResubmissionAvailable,
  reviewCandidateDurationSec,
  ReviewCreationGate,
} from "./review-panel";
import {
  resolveReviewCreationAccess,
  type ReviewCreationAccess,
} from "./review-creation-access";

function render(
  creationAccess: ReviewCreationAccess,
  canManageReview = true,
) {
  return renderToStaticMarkup(
    <ChakraProvider value={system}>
      <ReviewCreationGate
        creationAccess={creationAccess}
        canManageReview={canManageReview}
      >
        <input aria-label="Round title" />
        <button type="button">Send review</button>
      </ReviewCreationGate>
    </ChakraProvider>,
  );
}

describe("ReviewPanel creation entitlement", () => {
  test("prioritizes capability, plan, and rollout denials", () => {
    expect(
      resolveReviewCreationAccess({
        canManageReview: false,
        hasReviewRooms: true,
        writesEnabled: true,
      }),
    ).toBe("capability_denied");
    expect(
      resolveReviewCreationAccess({
        canManageReview: true,
        hasReviewRooms: false,
        writesEnabled: false,
      }),
    ).toBe("plan_required");
    expect(
      resolveReviewCreationAccess({
        canManageReview: true,
        hasReviewRooms: true,
        writesEnabled: false,
      }),
    ).toBe("rollout_paused");
    expect(
      resolveReviewCreationAccess({
        canManageReview: true,
        hasReviewRooms: true,
        writesEnabled: true,
      }),
    ).toBe("available");
  });

  test("keeps existing review access readable while locking Business creation", () => {
    const markup = render("plan_required");

    expect(markup).toContain("New review rounds require the Business plan");
    expect(markup).toContain(
      "Existing rounds, comments, and guest access stay available.",
    );
    expect(markup).not.toContain("Round title");
    expect(markup).not.toContain("Send review");
  });

  test("explains a paused rollout without showing a false plan upsell", () => {
    const markup = render("rollout_paused");

    expect(markup).toContain("New review rounds are temporarily unavailable");
    expect(markup).toContain(
      "An administrator has paused new review rounds during rollout.",
    );
    expect(markup).toContain(
      "Existing rounds, comments, and guest access stay available.",
    );
    expect(markup).not.toContain("require the Business plan");
    expect(markup).not.toContain("Round title");
    expect(markup).not.toContain("Send review");
  });

  test("keeps capability denial distinct from plan and rollout state", () => {
    const markup = render("capability_denied", false);

    expect(markup).toContain("Review desk is view-only");
    expect(markup).not.toContain("require the Business plan");
    expect(markup).not.toContain("temporarily unavailable");
  });

  test("reveals creation controls for an entitled workspace", () => {
    const markup = render("available");

    expect(markup).toContain("Round title");
    expect(markup).toContain("Send review");
    expect(markup).not.toContain("Review creation locked");
  });

  test("never offers resubmission without creation entitlement", () => {
    const round = { id: "round-1", newerWorkAvailable: true };

    expect(isReviewResubmissionAvailable(false, round, "round-1")).toBe(false);
    expect(isReviewResubmissionAvailable(true, round, "round-2")).toBe(false);
    expect(isReviewResubmissionAvailable(true, round, "round-1")).toBe(true);
  });
});

describe("reviewCandidateDurationSec", () => {
  const clip = { startSec: 4, endSec: 23 };

  test("uses the longest completed immutable variant duration", () => {
    expect(
      reviewCandidateDurationSec({
        clip,
        variants: [
          { status: "completed", durationSec: 25.23 },
          { status: "completed", durationSec: 25.2 },
          { status: "failed", durationSec: 90 },
          { status: "completed", durationSec: null },
        ],
      }),
    ).toBe(25.23);
  });

  test("falls back to the clip window only while export duration is unavailable", () => {
    expect(
      reviewCandidateDurationSec({
        clip,
        variants: [
          { status: "completed", durationSec: null },
          { status: "failed", durationSec: 90 },
        ],
      }),
    ).toBe(19);
  });
});
