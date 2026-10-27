import { describe, expect, test } from "bun:test";
import { quotaRefusalRecovery } from "./quota-refusal";

describe("quotaRefusalRecovery", () => {
  test("offers a higher plan for credits below Business", () => {
    expect(quotaRefusalRecovery("pro", "credits_exhausted")?.higherPlanNote).toBe("Higher plans include more credits.");
  });

  test("Business credits wait for renewal, with no plan offer", () => {
    const recovery = quotaRefusalRecovery("business", "credits_exhausted");
    expect(recovery?.higherPlanNote).toBeNull();
    expect(recovery?.message).toContain("renew");
  });

  test("length offers a plan only while one allows longer videos", () => {
    expect(quotaRefusalRecovery("creator", "upload_too_long")?.higherPlanNote).toBe("Higher plans allow longer videos.");
    // Pro and Business share the longest per-video limit.
    const pro = quotaRefusalRecovery("pro", "upload_too_long");
    expect(pro?.higherPlanNote).toBeNull();
    expect(pro?.message).toBe("This video is longer than the Pro plan allows per video. Upload a shorter video.");
  });

  test("ignores other failures", () => {
    expect(quotaRefusalRecovery("free", "source_download_failed")).toBeNull();
    expect(quotaRefusalRecovery("free", null)).toBeNull();
  });
});
