import { describe, expect, test } from "bun:test";
import {
  maskCensoredCaptionWord,
  normalizeCensorAudioSchedule,
} from "./auto-censor";
import type { CensorSegment } from "./timed-edits";

describe("maskCensoredCaptionWord", () => {
  test("masks visible graphemes while preserving punctuation", () => {
    expect(maskCensoredCaptionWord("Fúck?!", {
      replacement: "asterisks",
      preservePunctuation: true,
    })).toBe("****?!");
    expect(maskCensoredCaptionWord("Fúck?!", {
      replacement: "first_character",
      preservePunctuation: true,
    })).toBe("F***?!");
    expect(maskCensoredCaptionWord("Fúck?!", {
      replacement: "full_block",
      preservePunctuation: true,
    })).toBe("████?!");
  });
});

describe("normalizeCensorAudioSchedule", () => {
  test("maps source intervals through cuts, clamps exact-end padding, and gives mute precedence", () => {
    const segment = (
      id: string,
      treatment: "beep" | "mute",
      sourceStartSec: number,
      sourceEndSec: number,
      paddingSec: number,
    ): CensorSegment => ({
      schemaVersion: 1,
      id,
      sourceWordIds: [`word:${id}`],
      sourceStartSec,
      sourceEndSec,
      treatment,
      paddingSec,
      beepSettings: treatment === "beep"
        ? { frequencyHz: 1_000, levelDb: -12 }
        : null,
      captionMaskPolicy: null,
      suggestionFingerprint: "a".repeat(64),
      policyVersion: "auto-censor-2026-09-01.1",
      enabled: true,
    });

    const schedule = normalizeCensorAudioSchedule({
      clipWindow: { startSec: 10, endSec: 20 },
      deletedRanges: [{ startSec: 12, endSec: 14 }],
      segments: [
        segment("00000000-0000-4000-8000-000000000001", "beep", 11.8, 14.2, 0.1),
        segment("00000000-0000-4000-8000-000000000002", "mute", 14.1, 14.5, 0),
        segment("00000000-0000-4000-8000-000000000003", "beep", 19.9, 20, 0.5),
      ],
    });

    expect(schedule).toEqual([
      {
        startSec: 1.7,
        endSec: 2.1,
        treatment: "beep",
        frequencyHz: 1_000,
        gain: 0.251189,
        fadeInSec: 0.015,
        fadeOutSec: 0.015,
      },
      { startSec: 2.1, endSec: 2.5, treatment: "mute" },
      {
        startSec: 7.4,
        endSec: 8,
        treatment: "beep",
        frequencyHz: 1_000,
        gain: 0.251189,
        fadeInSec: 0.015,
        fadeOutSec: 0.015,
      },
    ]);
  });

  test("does not carry source censoring across an inserted Scene Block", () => {
    const schedule = normalizeCensorAudioSchedule({
      clipWindow: { startSec: 0, endSec: 5 },
      deletedRanges: [],
      sceneBlocks: [{
        schemaVersion: 1,
        id: "10000000-0000-4000-8000-000000000001",
        anchorSec: 2,
        durationSec: 1,
        content: { kind: "color", color: "#000000" },
        motion: { entrance: "none", exit: "none" },
        templateSnapshot: null,
      }],
      segments: [{
        schemaVersion: 1,
        id: "20000000-0000-4000-8000-000000000001",
        sourceWordIds: ["word:1"],
        sourceStartSec: 1,
        sourceEndSec: 3,
        treatment: "beep",
        paddingSec: 0,
        beepSettings: { frequencyHz: 800, levelDb: -18 },
        captionMaskPolicy: null,
        suggestionFingerprint: "b".repeat(64),
        policyVersion: "auto-censor-2026-09-01.1",
        enabled: true,
      }],
    });

    expect(schedule.map(({ startSec, endSec }) => ({ startSec, endSec }))).toEqual([
      { startSec: 1, endSec: 2 },
      { startSec: 3, endSec: 4 },
    ]);
  });
});
