import { describe, expect, test } from "bun:test";
import { AUTO_CENSOR_POLICY_VERSION, type AutoCensorSuggestion } from "@narriflow/validators";
import { buildReviewedCensorSegments } from "./auto-censor-review-model";

const suggestion: AutoCensorSuggestion = {
  fingerprint: "a".repeat(64),
  policyVersion: AUTO_CENSOR_POLICY_VERSION,
  policySource: "built_in",
  policyCategory: "profanity",
  matchedText: "masked",
  contextBefore: "before",
  contextAfter: "after",
  sourceWordIds: ["word:one"],
  sourceStartSec: 1,
  sourceEndSec: 1.3,
  audioStartSec: 0.95,
  audioEndSec: 1.35,
  confidence: 0.9,
  treatment: "beep",
  timingLimitation: null,
};

describe("Auto Censor review apply", () => {
  test("creates one editable segment per selected reviewed suggestion", () => {
    const result = buildReviewedCensorSegments({
      suggestions: [suggestion],
      decisions: [{ fingerprint: suggestion.fingerprint, selected: true, treatment: "mute" }],
      existing: [],
      canApply: true,
      treatments: { caption_mask: true, mute: true, beep: true },
      paddingSec: 0.08,
      createId: () => "b0d3a3bb-beb8-4ea4-be74-bc3387cc1ea4",
    });
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toMatchObject({
      treatment: "mute",
      beepSettings: null,
      paddingSec: 0.08,
    });
    expect(result.segments).toEqual(result.applied);
  });

  test("keeps preview read-only for free users and skips unavailable treatments", () => {
    expect(() => buildReviewedCensorSegments({
      suggestions: [suggestion],
      decisions: [{ fingerprint: suggestion.fingerprint, selected: true, treatment: "beep" }],
      existing: [],
      canApply: false,
      treatments: { caption_mask: true, mute: true, beep: true },
      paddingSec: 0.06,
      createId: crypto.randomUUID,
    })).toThrow("auto_censor_entitlement_required");
    expect(buildReviewedCensorSegments({
      suggestions: [suggestion],
      decisions: [{ fingerprint: suggestion.fingerprint, selected: true, treatment: "beep" }],
      existing: [],
      canApply: true,
      treatments: { caption_mask: true, mute: true, beep: false },
      paddingSec: 0.06,
      createId: crypto.randomUUID,
    }).applied).toEqual([]);
  });
});
