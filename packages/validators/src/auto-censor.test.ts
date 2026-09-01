import { describe, expect, test } from "bun:test";
import {
  AUTO_CENSOR_POLICY_VERSION,
  autoCensorWordId,
  detectAutoCensorSuggestions,
  isCensorSegmentStale,
} from "./auto-censor";

describe("detectAutoCensorSuggestions", () => {
  test("finds a built-in term without mutating the corrected transcript", () => {
    const transcript = [
      {
        index: 0,
        speakerLabel: "Speaker 1",
        startSec: 10,
        endSec: 12,
        text: "That was FUCK! wild",
        confidence: 0.94,
        words: [
          { word: "That", startSec: 10, endSec: 10.3, confidence: 0.99 },
          { word: "was", startSec: 10.3, endSec: 10.55, confidence: 0.98 },
          { word: "FUCK!", startSec: 10.55, endSec: 10.95, confidence: 0.94 },
          { word: "wild", startSec: 10.95, endSec: 11.35, confidence: 0.97 },
        ],
      },
    ] as const;
    const before = structuredClone(transcript);

    const result = detectAutoCensorSuggestions({
      documentRevision: 7,
      locale: "en-US",
      clipWindow: { startSec: 10, endSec: 12 },
      transcript,
      brandTerms: [],
      projectTerms: [],
      defaultTreatment: "beep",
      paddingSec: 0.08,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      matchedText: "FUCK!",
      policySource: "built_in",
      treatment: "beep",
      sourceStartSec: 10.55,
      sourceEndSec: 10.95,
      audioStartSec: 10.47,
      audioEndSec: 11.03,
      timingLimitation: null,
    });
    expect(result[0]?.sourceWordIds).toHaveLength(1);
    expect(result[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(transcript).toEqual(before);
  });

  test("normalizes Unicode and prefers one project phrase over overlapping policy terms", () => {
    const result = detectAutoCensorSuggestions({
      documentRevision: 3,
      locale: "en",
      clipWindow: { startSec: 0, endSec: 5 },
      transcript: [
        {
          index: 4,
          speakerLabel: "Speaker 1",
          startSec: 0,
          endSec: 5,
          text: "What the ＦＵＣＫ, launch leak now",
          confidence: 0.9,
          words: [
            { word: "What", startSec: 0, endSec: 0.3, confidence: 0.9 },
            { word: "the", startSec: 0.3, endSec: 0.5, confidence: 0.9 },
            { word: "ＦＵＣＫ,", startSec: 0.5, endSec: 0.9, confidence: 0.9 },
            { word: "launch", startSec: 1, endSec: 1.3, confidence: 0.9 },
            { word: "leak", startSec: 1.3, endSec: 1.6, confidence: 0.9 },
            { word: "now", startSec: 1.6, endSec: 1.9, confidence: 0.9 },
          ],
        },
      ],
      brandTerms: ["leak"],
      projectTerms: ["launch leak"],
      defaultTreatment: "mute",
      paddingSec: 0,
    });

    expect(result.map((suggestion) => ({
      text: suggestion.matchedText,
      source: suggestion.policySource,
      wordCount: suggestion.sourceWordIds.length,
    }))).toEqual([
      { text: "ＦＵＣＫ,", source: "built_in", wordCount: 1 },
      { text: "launch leak", source: "project", wordCount: 2 },
    ]);
  });

  test("limits an untimed match to caption masking", () => {
    const [suggestion] = detectAutoCensorSuggestions({
      documentRevision: 1,
      locale: "en",
      clipWindow: { startSec: 0, endSec: 8 },
      transcript: [
        {
          index: 0,
          speakerLabel: "Speaker 1",
          startSec: 0,
          endSec: 8,
          text: "well shit",
          confidence: null,
          words: [
            { word: "well", startSec: 1, endSec: 1.2, confidence: null },
            { word: "shit", startSec: null, endSec: null, confidence: null },
          ],
        },
      ],
      brandTerms: [],
      projectTerms: [],
      defaultTreatment: "beep",
      paddingSec: 0.1,
    });

    expect(suggestion).toMatchObject({
      treatment: "caption_mask",
      timingLimitation: "caption_only",
      sourceStartSec: null,
      sourceEndSec: null,
      audioStartSec: null,
      audioEndSec: null,
    });
  });

  test("classifies a built-in slur separately from profanity", () => {
    const [suggestion] = detectAutoCensorSuggestions({
      documentRevision: 1,
      locale: "en",
      clipWindow: { startSec: 0, endSec: 2 },
      transcript: [{
        index: 0,
        speakerLabel: "Speaker 1",
        startSec: 0,
        endSec: 2,
        text: "retard",
        confidence: 0.95,
        words: [{ word: "retard", startSec: 0.4, endSec: 0.9, confidence: 0.95 }],
      }],
      brandTerms: [],
      projectTerms: [],
      defaultTreatment: "mute",
      paddingSec: 0.05,
    });

    expect(suggestion?.policyCategory).toBe("slur");
  });

  test("changes the word identity and fingerprint after a transcript correction", () => {
    const scan = (word: string) => detectAutoCensorSuggestions({
      documentRevision: 11,
      locale: "en",
      clipWindow: { startSec: 0, endSec: 3 },
      transcript: [{
        index: 0,
        speakerLabel: "Speaker 1",
        startSec: 0,
        endSec: 3,
        text: word,
        confidence: 0.8,
        words: [{ word, startSec: 1, endSec: 1.4, confidence: 0.8 }],
      }],
      brandTerms: ["ship"],
      projectTerms: [],
      defaultTreatment: "caption_mask" as const,
      paddingSec: 0,
    })[0]!;

    const before = scan("shit");
    const after = scan("ship");

    expect(after.sourceWordIds).not.toEqual(before.sourceWordIds);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  test("keeps a suggestion fingerprint stable across revision and review-setting changes", () => {
    const scan = (documentRevision: number, defaultTreatment: "beep" | "mute", paddingSec: number) =>
      detectAutoCensorSuggestions({
        documentRevision,
        locale: "en",
        clipWindow: { startSec: 0, endSec: 3 },
        transcript: [{
          index: 0,
          speakerLabel: "Speaker 1",
          startSec: 0,
          endSec: 3,
          text: "shit",
          confidence: 0.9,
          words: [{ word: "shit", startSec: 1, endSec: 1.4, confidence: 0.9 }],
        }],
        brandTerms: [],
        projectTerms: [],
        defaultTreatment,
        paddingSec,
      })[0]!.fingerprint;

    expect(scan(2, "beep", 0.04)).toBe(scan(7, "mute", 0.12));
  });

  test("marks an applied segment stale when a referenced transcript word changes", () => {
    const transcript = [{
      index: 0,
      speakerLabel: "Speaker 1",
      startSec: 1,
      endSec: 1.4,
      text: "shit",
      confidence: 0.9,
      words: [{ word: "shit", startSec: 1, endSec: 1.4, confidence: 0.9 }],
    }];
    const segment = {
      schemaVersion: 1 as const,
      id: "3ca02b2e-a324-45d0-8b0f-88dbbc05552a",
      sourceWordIds: [autoCensorWordId({
        utteranceIndex: 0,
        wordIndex: 0,
        word: transcript[0]!.words[0]!,
      })],
      sourceStartSec: 1,
      sourceEndSec: 1.4,
      treatment: "mute" as const,
      paddingSec: 0,
      beepSettings: null,
      captionMaskPolicy: null,
      suggestionFingerprint: "a".repeat(64),
      policyVersion: AUTO_CENSOR_POLICY_VERSION,
      enabled: true,
    };

    expect(isCensorSegmentStale(segment, transcript)).toBe(false);
    expect(isCensorSegmentStale(segment, [{
      ...transcript[0]!,
      text: "ship",
      words: [{ ...transcript[0]!.words[0]!, word: "ship" }],
    }])).toBe(true);
  });

  test("returns the same empty result for a clean corrected transcript", () => {
    const input = {
      documentRevision: 2,
      locale: "fr-FR",
      clipWindow: { startSec: 0, endSec: 2 },
      transcript: [{
        index: 0,
        speakerLabel: "Speaker 1",
        startSec: 0,
        endSec: 2,
        text: "bonjour tout le monde",
        confidence: 1,
        words: [
          { word: "bonjour", startSec: 0, endSec: 0.5, confidence: 1 },
          { word: "tout", startSec: 0.5, endSec: 0.8, confidence: 1 },
          { word: "le", startSec: 0.8, endSec: 1, confidence: 1 },
          { word: "monde", startSec: 1, endSec: 1.5, confidence: 1 },
        ],
      }],
      brandTerms: [],
      projectTerms: [],
      defaultTreatment: "mute" as const,
      paddingSec: 0.05,
    };

    expect(detectAutoCensorSuggestions(input)).toEqual([]);
    expect(detectAutoCensorSuggestions(input)).toEqual([]);
  });
});
