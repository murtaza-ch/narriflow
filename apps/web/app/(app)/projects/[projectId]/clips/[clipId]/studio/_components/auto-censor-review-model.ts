import {
  AUTO_CENSOR_POLICY_VERSION,
  type AutoCensorSuggestion,
  type AutoCensorTreatment,
  type CensorSegment,
} from "@narriflow/validators";

export interface AutoCensorReviewDecision {
  readonly fingerprint: string;
  readonly selected: boolean;
  readonly treatment: AutoCensorTreatment;
}

export function autoCensorSourceSpanKey(sourceWordIds: readonly string[]): string {
  return sourceWordIds.join("\u0000");
}

export function autoCensorResultCountBucket(count: number) {
  if (count <= 0) return "zero" as const;
  if (count <= 5) return "one_to_five" as const;
  if (count <= 20) return "six_to_twenty" as const;
  return "over_twenty" as const;
}

export function buildReviewedCensorSegments(input: {
  suggestions: readonly AutoCensorSuggestion[];
  decisions: readonly AutoCensorReviewDecision[];
  existing: readonly CensorSegment[];
  canApply: boolean;
  treatments: Readonly<Record<AutoCensorTreatment, boolean>>;
  paddingSec: number;
  createId: () => string;
}): { segments: CensorSegment[]; applied: CensorSegment[] } {
  if (!input.canApply) throw new Error("auto_censor_entitlement_required");
  const decisions = new Map(input.decisions.map((decision) => [decision.fingerprint, decision]));
  const existingFingerprints = new Set(
    input.existing.flatMap((segment) => segment.suggestionFingerprint ? [segment.suggestionFingerprint] : []),
  );
  const existingSourceSpans = new Set(
    input.existing.map((segment) => autoCensorSourceSpanKey(segment.sourceWordIds)),
  );
  const applied = input.suggestions.flatMap((suggestion) => {
    const decision = decisions.get(suggestion.fingerprint);
    if (
      !decision?.selected ||
      !input.treatments[decision.treatment] ||
      existingFingerprints.has(suggestion.fingerprint) ||
      existingSourceSpans.has(autoCensorSourceSpanKey(suggestion.sourceWordIds)) ||
      suggestion.sourceStartSec === null ||
      suggestion.sourceEndSec === null
    ) {
      return [];
    }
    const segment: CensorSegment = {
      schemaVersion: 1,
      id: input.createId(),
      sourceWordIds: [...suggestion.sourceWordIds],
      sourceStartSec: suggestion.sourceStartSec,
      sourceEndSec: suggestion.sourceEndSec,
      treatment: decision.treatment,
      paddingSec: Math.max(0, input.paddingSec),
      beepSettings: decision.treatment === "beep"
        ? { frequencyHz: 1_000, levelDb: -8 }
        : null,
      captionMaskPolicy: decision.treatment === "caption_mask"
        ? { replacement: "first_character", preservePunctuation: true }
        : null,
      suggestionFingerprint: suggestion.fingerprint,
      policyVersion: suggestion.policyVersion ?? AUTO_CENSOR_POLICY_VERSION,
      enabled: true,
    };
    return [segment];
  });
  return { segments: [...input.existing, ...applied], applied };
}
