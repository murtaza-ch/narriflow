import { describe, expect, test } from "bun:test";
import { interpretYouTubeProcessingStatus } from "./youtube-receipt-enrichment";

describe("YouTube receipt processing", () => {
  test("keeps accepted uploads pending until YouTube finishes processing", () => {
    expect(
      interpretYouTubeProcessingStatus({
        status: { uploadStatus: "uploaded", privacyStatus: "private" },
      }),
    ).toEqual({ status: "processing", failureCode: null, visibility: "private" });
  });

  test("reports post-acceptance processing failure without discarding the receipt", () => {
    expect(
      interpretYouTubeProcessingStatus({
        status: { uploadStatus: "rejected", rejectionReason: "duplicate" },
      }),
    ).toEqual({
      status: "failed",
      failureCode: "youtube_processing_failed",
      visibility: null,
    });
  });
});
