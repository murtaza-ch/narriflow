import { describe, expect, test } from "bun:test";

import type { CensorSegment } from "./timed-edits";
import {
  AUTO_CENSOR_POLICY_VERSION,
  autoCensorAnalyticsSummary,
  autoCensorSegmentIsCurrent,
  autoCensorSuggestionIsCurrent,
  censorBeepEnvelopeAt,
  censorSegmentFromSuggestion,
  maskCaptionWord,
  resolveCensorAudioIntervals,
  scanAutoCensor,
} from "./auto-censor";

const transcript = [
  {
    index: 4,
    startSec: 10,
    endSec: 14,
    words: [
      { word: "Well,", startSec: 10, endSec: 10.4, confidence: 0.99 },
      { word: "ＦＵＣＫ!", startSec: 10.5, endSec: 10.9, confidence: 0.92 },
      { word: "red", startSec: 11, endSec: 11.2, confidence: 0.98 },
      { word: "FLAG,", startSec: 11.25, endSec: 11.7, confidence: 0.97 },
      { word: "damn", startSec: 12, endSec: 12.3, confidence: 0.8 },
    ],
  },
] as const;

describe("scanAutoCensor", () => {
  test("ships versioned profanity and identity-slur policies by locale", () => {
    const scan = (locale: string, word: string) =>
      scanAutoCensor({
        documentRevision: 1,
        locale,
        clipWindow: { startSec: 0, endSec: 1 },
        transcript: [{
          index: 0,
          startSec: 0,
          endSec: 1,
          words: [{ word, startSec: 0.1, endSec: 0.5, confidence: 1 }],
        }],
        defaultTreatment: "beep",
      }).suggestions[0];

    expect(scan("en-US", "asshole")?.policySource.category).toBe("profanity");
    expect(scan("es-MX", "mierda")?.policySource.category).toBe("profanity");
    expect(scan("fr-FR", "putain")?.policySource.category).toBe("profanity");
    expect(scan("de-DE", "arschloch")?.policySource.category).toBe("profanity");
    expect(scan("pt-BR", "caralho")?.policySource.category).toBe("profanity");
    expect(scan("it-IT", "stronzo")?.policySource.category).toBe("profanity");
    expect(scan("en-US", "faggot")?.policySource.category).toBe(
      "identity_slur",
    );
    expect(scan("nl-NL", "asshole")).toBeUndefined();
  });

  test("combines locale, Brand Profile, and project policy over corrected Unicode words", () => {
    const input = {
      documentRevision: 7,
      locale: "en-US",
      clipWindow: { startSec: 10, endSec: 14 },
      transcript,
      paddingSec: 0.08,
      defaultTreatment: "beep" as const,
      brandTerms: [{ phrase: "red flag", treatment: "caption_mask" as const }],
      projectTerms: [{ phrase: "damn", treatment: "mute" as const }],
    };
    const before = structuredClone(input);

    const first = scanAutoCensor(input);
    const second = scanAutoCensor(input);

    expect(input).toEqual(before);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      detectorVersion: 1,
      policyVersion: AUTO_CENSOR_POLICY_VERSION,
    });
    expect(first.suggestions).toHaveLength(3);
    expect(first.suggestions.map((suggestion) => ({
      source: suggestion.policySource.kind,
      treatment: suggestion.proposedTreatment,
      range: suggestion.sourceRange,
      wordCount: suggestion.sourceWordIds.length,
    }))).toEqual([
      {
        source: "built_in",
        treatment: "beep",
        range: { startSec: 10.42, endSec: 10.98 },
        wordCount: 1,
      },
      {
        source: "brand_profile",
        treatment: "caption_mask",
        range: { startSec: 10.92, endSec: 11.78 },
        wordCount: 2,
      },
      {
        source: "project",
        treatment: "mute",
        range: { startSec: 11.92, endSec: 12.38 },
        wordCount: 1,
      },
    ]);
    for (const suggestion of first.suggestions) {
      expect(suggestion.fingerprint).toMatch(/^[a-f0-9]{32}$/);
      expect(suggestion.sourceWordIds.every((id) => id.startsWith("word:"))).toBe(true);
    }
  });

  test("uses the most specific source for duplicate terms and the longest non-overlapping phrase", () => {
    const result = scanAutoCensor({
      documentRevision: 3,
      locale: "en",
      clipWindow: { startSec: 0, endSec: 3 },
      transcript: [{
        index: 0,
        startSec: 0,
        endSec: 3,
        words: [
          { word: "bad", startSec: 0.2, endSec: 0.5, confidence: 1 },
          { word: "idea", startSec: 0.6, endSec: 0.9, confidence: 1 },
        ],
      }],
      defaultTreatment: "beep",
      brandTerms: [{ phrase: "bad", treatment: "mute" }],
      projectTerms: [{ phrase: "bad idea", treatment: "caption_mask" }],
    });

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toMatchObject({
      policySource: { kind: "project" },
      proposedTreatment: "caption_mask",
    });
    expect(result.suggestions[0]!.sourceWordIds).toHaveLength(2);
  });

  test("returns a clear caption-only limitation for untimed words and succeeds empty", () => {
    const untimed = scanAutoCensor({
      documentRevision: 1,
      locale: "en",
      clipWindow: { startSec: 0, endSec: 2 },
      transcript: [{
        index: 0,
        startSec: 0,
        endSec: 2,
        words: [{ word: "damn", startSec: null, endSec: null, confidence: null }],
      }],
      defaultTreatment: "beep",
    });
    expect(untimed.suggestions[0]).toMatchObject({
      sourceRange: null,
      wordSourceRange: null,
      captionSourceRange: { startSec: 0, endSec: 2 },
      proposedTreatment: "caption_mask",
      limitation: "caption_only_untimed",
    });
    expect(censorSegmentFromSuggestion(
      untimed.suggestions[0]!,
      "38af8b1d-31db-454c-9d5e-bb9cad8270a2",
    )).toMatchObject({
      sourceStartSec: 0,
      sourceEndSec: 2,
      treatment: "caption_mask",
    });
    expect(censorSegmentFromSuggestion(
      untimed.suggestions[0]!,
      "38af8b1d-31db-454c-9d5e-bb9cad8270a2",
      "beep",
    )).toBeNull();

    const empty = scanAutoCensor({
      documentRevision: 1,
      locale: "en",
      clipWindow: { startSec: 0, endSec: 2 },
      transcript: [{
        index: 0,
        startSec: 0,
        endSec: 2,
        words: [{ word: "ordinary", startSec: 0, endSec: 1, confidence: 1 }],
      }],
      defaultTreatment: "beep",
    });
    expect(empty.suggestions).toEqual([]);
  });

  test("invalidates a suggestion after a correction or revision change", () => {
    const input = {
      documentRevision: 2,
      locale: "en",
      clipWindow: { startSec: 10, endSec: 14 },
      transcript,
      defaultTreatment: "beep" as const,
    };
    const suggestion = scanAutoCensor(input).suggestions[0]!;
    expect(autoCensorSuggestionIsCurrent(suggestion, input)).toBe(true);
    expect(autoCensorSuggestionIsCurrent(suggestion, {
      ...input,
      documentRevision: 3,
    })).toBe(false);
    expect(autoCensorSuggestionIsCurrent(suggestion, {
      ...input,
      transcript: [{
        ...transcript[0],
        words: transcript[0].words.map((word, index) =>
          index === 1 ? { ...word, word: "fixed" } : word),
      }],
    })).toBe(false);
    const segment = censorSegmentFromSuggestion(
      suggestion,
      "38af8b1d-31db-454c-9d5e-bb9cad8270a2",
    )!;
    expect(autoCensorSegmentIsCurrent(segment, input.transcript)).toBe(true);
    expect(autoCensorSegmentIsCurrent(segment, [{
      ...transcript[0],
      words: transcript[0].words.map((word, index) =>
        index === 1 ? { ...word, word: "fixed" } : word),
    }])).toBe(false);
  });

  test("does not match a configured phrase across utterance boundaries", () => {
    const result = scanAutoCensor({
      documentRevision: 1,
      locale: "en",
      clipWindow: { startSec: 0, endSec: 2 },
      transcript: [
        {
          index: 0,
          startSec: 0,
          endSec: 1,
          words: [{ word: "red", startSec: 0.5, endSec: 0.8, confidence: 1 }],
        },
        {
          index: 1,
          startSec: 1,
          endSec: 2,
          words: [{ word: "flag", startSec: 1.1, endSec: 1.4, confidence: 1 }],
        },
      ],
      defaultTreatment: "beep",
      projectTerms: [{ phrase: "red flag" }],
    });
    expect(result.suggestions).toEqual([]);
  });

  test("materializes only timed suggestions and keeps transcript content out of analytics", () => {
    const result = scanAutoCensor({
      documentRevision: 7,
      locale: "en",
      clipWindow: { startSec: 10, endSec: 14 },
      transcript,
      defaultTreatment: "beep",
    });
    const segment = censorSegmentFromSuggestion(
      result.suggestions[0]!,
      "b0374cf1-126b-4f10-a873-9a25de20387e",
    );
    expect(segment).toMatchObject({
      schemaVersion: 1,
      treatment: "beep",
      beepSettings: { frequencyHz: 1_000, levelDb: -12 },
      captionMaskPolicy: null,
      enabled: true,
    });
    const summary = autoCensorAnalyticsSummary(result, [segment!]);
    expect(summary).toEqual({
      detectorVersion: 1,
      policyVersion: AUTO_CENSOR_POLICY_VERSION,
      resultCountBucket: "1-5",
      applyCount: 1,
      treatments: { beep: 1, mute: 0, caption_mask: 0 },
      staleCount: 0,
    });
    expect(JSON.stringify(summary)).not.toContain("ＦＵＣＫ");
    expect(JSON.stringify(summary)).not.toContain("Well");
  });
});

describe("shared caption and audio censor helpers", () => {
  test("masks Unicode graphemes while preserving punctuation", () => {
    expect(maskCaptionWord("héllo!", {
      replacement: "asterisks",
      preservePunctuation: true,
    })).toBe("*****!");
    expect(maskCaptionWord("damn?!", {
      replacement: "first_character",
      preservePunctuation: true,
    })).toBe("d***?!");
    expect(maskCaptionWord("bad!", {
      replacement: "full_block",
      preservePunctuation: false,
    })).toBe("████");
  });

  test("clamps trim, removes deleted footage and inserted Scenes, and gives mute precedence", () => {
    const segment = (
      id: string,
      treatment: CensorSegment["treatment"],
      sourceStartSec: number,
      sourceEndSec: number,
      levelDb = -12,
    ): CensorSegment => ({
      schemaVersion: 1,
      id,
      sourceWordIds: [`${id}:word`],
      sourceStartSec,
      sourceEndSec,
      treatment,
      paddingSec: 0,
      beepSettings: treatment === "beep" ? { frequencyHz: 1_000, levelDb } : null,
      captionMaskPolicy: treatment === "caption_mask"
        ? { replacement: "asterisks", preservePunctuation: true }
        : null,
      suggestionFingerprint: null,
      policyVersion: AUTO_CENSOR_POLICY_VERSION,
      enabled: true,
    });
    const schedule = resolveCensorAudioIntervals({
      clipWindow: { startSec: 10, endSec: 16 },
      deletedRanges: [{ startSec: 12, endSec: 13 }],
      sceneBlocks: [{ anchorSec: 1.5, durationSec: 1 }],
      segments: [
        segment("00000000-0000-4000-8000-000000000001", "beep", 9, 11),
        segment("00000000-0000-4000-8000-000000000002", "mute", 11, 13.5),
        segment("00000000-0000-4000-8000-000000000003", "beep", 13.5, 16.5, -18),
      ],
    });

    expect(schedule).toMatchObject([
      {
        kind: "beep",
        activeRange: { startSec: 0, endSec: 1 },
        frequencyHz: 1_000,
        fades: { fadeInSec: 0.008, fadeOutSec: 0.008 },
      },
      {
        kind: "mute",
        activeRange: { startSec: 1, endSec: 1.5 },
      },
      {
        kind: "mute",
        activeRange: { startSec: 2.5, endSec: 3.5 },
      },
      {
        kind: "beep",
        activeRange: { startSec: 3.5, endSec: 6 },
        frequencyHz: 1_000,
        fades: { fadeInSec: 0.008, fadeOutSec: 0.008 },
      },
    ]);
    expect(schedule[0]?.kind === "beep" ? schedule[0].gain : 0).toBeCloseTo(0.2511886, 6);
    expect(schedule[3]?.kind === "beep" ? schedule[3].gain : 0).toBeCloseTo(0.1258925, 6);
  });

  test("uses one bounded beep envelope at preview and render boundaries", () => {
    const interval = {
      kind: "beep" as const,
      activeRange: { startSec: 2, endSec: 2.01 },
      frequencyHz: 1_000,
      gain: 0.25,
      fades: { fadeInSec: 0.005, fadeOutSec: 0.005 },
    };
    expect(censorBeepEnvelopeAt(interval, 1.999)).toBe(0);
    expect(censorBeepEnvelopeAt(interval, 2)).toBe(0);
    expect(censorBeepEnvelopeAt(interval, 2.005)).toBeCloseTo(1);
    expect(censorBeepEnvelopeAt(interval, 2.01)).toBe(0);
  });
});
