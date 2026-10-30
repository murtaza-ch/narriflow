import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildTranscriptSnapshot,
  exportTranscript,
  normalizeElevenLabsTranscript,
  TranscriptNormalizationError,
} from "./transcript.service";
import { workflowFailureFromUnknown } from "./workflow-run-lifecycle";

type Token = Record<string, unknown>;
type Payload = { words: Token[]; [key: string]: unknown };

/** Trimmed slices of real Scribe v2 results (see test-fixtures/scribe). */
function fixture(name: string): Payload {
  return JSON.parse(readFileSync(join(import.meta.dir, "test-fixtures/scribe", name), "utf8"));
}

const options = { allowEmpty: false, providerJobId: "tx_1", providerRequestId: "req_1", durationSeconds: 188.4 };
const word = (text: string, start: number, end: number, speaker_id: string | null = "speaker_0"): Token => ({
  text, start, end, type: "word", ...(speaker_id ? { speaker_id } : {}), logprob: -0.01,
});
const space = (start: number, end: number): Token => ({ text: " ", start, end, type: "spacing", speaker_id: "speaker_0", logprob: 0 });
const event = (text: string, start: number, end: number): Token => ({ text, start, end, type: "audio_event", speaker_id: "speaker_0", logprob: -0.1 });
const payloadOf = (words: Token[], extra: Record<string, unknown> = {}) => ({
  language_code: "eng", language_probability: 0.99, text: "", transcription_id: "tx_1", audio_duration_secs: 10, words, ...extra,
});
const wordsOf = (normalized: ReturnType<typeof normalizeElevenLabsTranscript>) => normalized.utterances.flatMap((u) => u.words);

describe("normalizeElevenLabsTranscript", () => {
  test("turns a diarized English result into speaker utterances", () => {
    const payload = fixture("en-diarized.json");
    const normalized = normalizeElevenLabsTranscript(payload, options);

    expect(normalized).toMatchObject({
      provider: "elevenlabs",
      providerModel: "scribe_v2",
      providerJobId: "tx_1",
      providerRequestId: "req_1",
      languageCode: "en",
      languageConfidence: 1,
      durationSeconds: 188,
    });
    expect(normalized.rawPayload).toBe(payload);
    expect(normalized.speakerCount).toBeGreaterThan(1);
    expect(normalized.utterances.map((u) => u.index)).toEqual(normalized.utterances.map((_, i) => i));
    for (const utterance of normalized.utterances) {
      expect(utterance.speakerLabel).toBe(`Speaker ${utterance.speaker! + 1}`);
      expect(utterance.confidence).toBeNull();
      expect(utterance.text).toBe(utterance.words.map((w) => w.word).join(" "));
      expect(utterance.startSec).toBe(utterance.words[0]!.startSec);
    }
    expect(normalized.text).toBe(normalized.utterances.map((u) => u.text).join("\n\n"));
  });

  test("numbers speakers densely in first-seen order, whatever the provider ids", () => {
    const normalized = normalizeElevenLabsTranscript(
      payloadOf([
        word("Hi", 0, 0.2, "speaker_3"), space(0.2, 0.25), word("there.", 0.25, 0.5, "speaker_3"),
        word("Hello.", 1, 1.4, "speaker_0"),
        word("Right.", 2, 2.4, "speaker_3"),
        word("Yes.", 3, 3.4, "speaker_7"),
      ]),
      options,
    );
    expect(normalized.utterances.map((u) => [u.speaker, u.speakerLabel])).toEqual([
      [0, "Speaker 1"], [1, "Speaker 2"], [0, "Speaker 1"], [2, "Speaker 3"],
    ]);
    expect(normalized.speakerCount).toBe(3);
  });

  test("a long podcast slice keeps both speakers' turns and sentence timing", () => {
    const normalized = normalizeElevenLabsTranscript(fixture("podcast-diarized.json"), { ...options, durationSeconds: 4100.6208125 });
    expect(normalized.speakerCount).toBe(2);
    expect(normalized.durationSeconds).toBe(4101);
    for (const utterance of normalized.utterances) {
      expect(utterance.endSec).toBeGreaterThanOrEqual(utterance.startSec);
      expect(new Set(utterance.words.map((w) => w.word)).size).toBeGreaterThan(0);
    }
    const turns = normalized.utterances.map((u) => u.speaker);
    expect(turns.some((speaker, i) => i > 0 && speaker !== turns[i - 1])).toBe(true);
  });

  test("keeps provider seconds as they are and leaves confidence null", () => {
    const normalized = normalizeElevenLabsTranscript(payloadOf([word("Hello", 1.14, 2.14), space(2.14, 2.28), word("world.", 2.28, 2.7)]), options);
    expect(normalized.utterances[0]!.words).toEqual([
      { word: "Hello", startSec: 1.14, endSec: 2.14, confidence: null },
      { word: "world.", startSec: 2.28, endSec: 2.7, confidence: null, spaceBefore: true },
    ]);
  });

  test("Chinese per-character tokens touch: spaceBefore false and no spaces in the text", () => {
    const normalized = normalizeElevenLabsTranscript(fixture("zh-per-character.json"), options);
    expect(normalized.languageCode).toBe("zh");
    const words = wordsOf(normalized);
    expect(words.length).toBeGreaterThan(30);
    const touching = words.slice(1).filter((w) => w.spaceBefore === false);
    expect(touching.length).toBeGreaterThan(20);
    expect(words[0]!.spaceBefore).toBeUndefined();
    for (const utterance of normalized.utterances) {
      expect(utterance.text).not.toMatch(/[\u4e00-\u9fff] [\u4e00-\u9fff]/);
    }
  });

  test("Japanese keeps per-character tokens and spaces only where Scribe put a spacing token", () => {
    const normalized = normalizeElevenLabsTranscript(fixture("ja-per-character.json"), options);
    expect(normalized.languageCode).toBe("ja");
    const words = wordsOf(normalized);
    const emo = words.findIndex((w) => w.word === "EMO");
    expect(words[emo]!.spaceBefore).toBe(true);
    expect(words[emo - 1]!.word).toBe("室");
    expect(normalized.utterances.some((u) => u.text.includes("室 EMO"))).toBe(true);
    expect(words.filter((w) => w.spaceBefore === false).length).toBeGreaterThan(20);
  });

  test("Urdu stays right-to-left text, spaced by Scribe's spacing tokens", () => {
    const normalized = normalizeElevenLabsTranscript(fixture("ur-rtl.json"), options);
    expect(normalized.languageCode).toBe("ur");
    expect(normalized.utterances[0]!.text).toMatch(/^مرحلے فرض اور /);
    expect(wordsOf(normalized).slice(1).every((w) => w.spaceBefore === true)).toBe(true);
  });

  test("English words inside Urdu and Hindi stay their own spaced words", () => {
    const hindi = normalizeElevenLabsTranscript(fixture("hi-mixed-english.json"), options);
    expect(hindi.languageCode).toBe("hi");
    expect(hindi.text).toContain("Soviet Polish");

    const urdu = fixture("ur-rtl.json");
    const at = urdu.words.findIndex((w) => w.text === "اور");
    const end = urdu.words[at]!.end as number;
    urdu.words.splice(at + 1, 0, space(end, end), word("OpenAI", end, end));
    const mixed = normalizeElevenLabsTranscript(urdu, options);
    expect(mixed.text).toMatch(/اور OpenAI صلاحیتوں/);
  });

  test("audio events and spacing tokens are not words", () => {
    const normalized = normalizeElevenLabsTranscript(
      payloadOf([
        event("(laughter)", 0, 0.5), word("Hi", 0.5, 0.7), space(0.7, 0.75), event("(applause)", 0.75, 1),
        space(1, 1.1), word("there.", 1.1, 1.4), space(1.4, 1.5),
      ]),
      options,
    );
    expect(wordsOf(normalized)).toEqual([
      { word: "Hi", startSec: 0.5, endSec: 0.7, confidence: null },
      { word: "there.", startSec: 1.1, endSec: 1.4, confidence: null, spaceBefore: true },
    ]);
    expect(normalized.text).toBe("Hi there.");
  });

  test("whitespace inside a token spaces the word", () => {
    const normalized = normalizeElevenLabsTranscript(payloadOf([word("Hi", 0, 0.2), word(" there", 0.2, 0.5), word("again ", 0.5, 0.8), word("now", 0.8, 1)]), options);
    expect(wordsOf(normalized).map((w) => w.spaceBefore)).toEqual([undefined, true, false, true]);
  });

  test("words with no speaker_id share one unknown speaker that stays stable", () => {
    const normalized = normalizeElevenLabsTranscript(
      payloadOf([
        word("Hello.", 0, 0.4, "speaker_0"),
        word("Mystery.", 1, 1.4, null),
        word("Back.", 2, 2.4, "speaker_0"),
        word("Again.", 3, 3.4, null),
      ]),
      options,
    );
    expect(normalized.utterances.map((u) => u.speaker)).toEqual([0, 1, 0, 1]);
    expect(normalized.speakerCount).toBe(2);
  });

  test("a result with no speaker ids at all is one speaker", () => {
    const normalized = normalizeElevenLabsTranscript(payloadOf([word("One.", 0, 0.4, null), word("Two.", 1, 1.4, null)]), options);
    expect(normalized.speakerCount).toBe(1);
  });

  test("language: provider codes normalize, probability clamps, unknown or absent is null", () => {
    const base = payloadOf([word("Hi.", 0, 0.4)]);
    expect(normalizeElevenLabsTranscript({ ...base, language_code: "urd", language_probability: 1.7 }, options)).toMatchObject({ languageCode: "ur", languageConfidence: 1 });
    expect(normalizeElevenLabsTranscript({ ...base, language_code: "fil", language_probability: -0.2 }, options)).toMatchObject({ languageCode: "fil", languageConfidence: 0 });
    expect(normalizeElevenLabsTranscript({ ...base, language_code: "xx-nope", language_probability: undefined }, options)).toMatchObject({ languageCode: null, languageConfidence: null });
    expect(normalizeElevenLabsTranscript({ ...base, language_code: undefined, language_probability: Number.NaN }, options)).toMatchObject({ languageCode: null, languageConfidence: null });
  });

  test("duration is the probed source duration; the last word only stands in when unknown", () => {
    const payload = payloadOf([word("Hi.", 0, 4.4), word("Bye.", 5, 9.6)], { audio_duration_secs: 99 });
    expect(normalizeElevenLabsTranscript(payload, { ...options, durationSeconds: 61.2 }).durationSeconds).toBe(61);
    expect(normalizeElevenLabsTranscript(payload, { ...options, durationSeconds: null }).durationSeconds).toBe(10);
  });

  describe("no speech", () => {
    const silent = payloadOf([space(0, 1), event("(music)", 0, 7)], { text: "" });

    test("is refused unless the generation can finish without speech", () => {
      for (const empty of [silent, payloadOf([]), { language_code: "eng" }]) {
        expect(() => normalizeElevenLabsTranscript(empty, options)).toThrow(TranscriptNormalizationError);
      }
    });

    test("a caption-only generation gets a finished transcript with no utterances", () => {
      for (const empty of [silent, payloadOf([]), { language_code: "eng" }]) {
        expect(normalizeElevenLabsTranscript(empty, { ...options, allowEmpty: true, durationSeconds: 7.6 })).toMatchObject({
          provider: "elevenlabs", providerModel: "scribe_v2", providerJobId: "tx_1", text: "", utterances: [], speakerCount: 0, durationSeconds: 8,
        });
      }
    });

    test("speech is normalized the same way whatever the option", () => {
      const payload = fixture("en-diarized.json");
      expect(normalizeElevenLabsTranscript(payload, { ...options, allowEmpty: true })).toEqual(normalizeElevenLabsTranscript(payload, options));
    });
  });

  describe("malformed results are permanent", () => {
    const bad: [string, unknown][] = [
      ["a non-object result", "oops"],
      ["words that are not a list", { words: "nope" }],
      ["a missing end", payloadOf([{ text: "Hi", start: 0, type: "word", speaker_id: "speaker_0" }])],
      ["a missing start", payloadOf([{ text: "Hi", end: 1, type: "word", speaker_id: "speaker_0" }])],
      ["a non-finite time", payloadOf([word("Hi", 0, Number.POSITIVE_INFINITY)])],
      ["a string time", payloadOf([{ text: "Hi", start: "0", end: "1", type: "word", speaker_id: "speaker_0" }])],
      ["a negative start", payloadOf([word("Hi", -1, 1)])],
      ["an end before its start", payloadOf([word("Hi", 2, 1)])],
      ["a word without text", payloadOf([{ start: 0, end: 1, type: "word", speaker_id: "speaker_0" }])],
      ["a token that is not an object", payloadOf(["Hi" as unknown as Token])],
    ];

    for (const [name, payload] of bad) {
      test(name, () => {
        let error: unknown;
        try {
          normalizeElevenLabsTranscript(payload, { ...options, allowEmpty: true });
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(TranscriptNormalizationError);
        expect((error as TranscriptNormalizationError).code).toBe("elevenlabs_result_invalid");
        expect(workflowFailureFromUnknown(error)).toMatchObject({ code: "elevenlabs_result_invalid", disposition: "permanent" });
      });
    }

    test("a malformed token past the speech is still refused", () => {
      expect(() => normalizeElevenLabsTranscript(payloadOf([word("Hi.", 0, 1), word("Late", 2, 1)]), options)).toThrow(TranscriptNormalizationError);
    });
  });
});

describe("exportTranscript", () => {
  const snapshot = buildTranscriptSnapshot({
    projectId: "72e62077-cfc8-446b-9dd1-29bd72020858",
    status: "completed",
    provider: "assemblyai",
    providerModel: "universal-3-5-pro",
    providerJobId: "aai-transcript-123",
    languageCode: "en",
    languageConfidence: 0.97,
    text: "Welcome back to Narriflow.\n\nToday we are talking about transcription quality.",
    utterancesJson: [
      {
        index: 0,
        speaker: 0,
        speakerLabel: "Speaker 1",
        startSec: 0.2,
        endSec: 4.8,
        text: "Welcome back to Narriflow.",
        confidence: 0.98,
        words: [],
      },
      {
        index: 1,
        speaker: 1,
        speakerLabel: "Speaker 2",
        startSec: 5.1,
        endSec: 9.6,
        text: "Today we are talking about transcription quality.",
        confidence: 0.95,
        words: [],
      },
    ],
    speakerCount: 2,
    durationSeconds: 32,
    errorCode: null,
    completedAt: "2026-03-06T10:00:00.000Z",
    updatedAt: "2026-03-06T10:00:00.000Z",
  });

  test("exports TXT with timestamps and speaker labels", () => {
    expect(exportTranscript(snapshot, "txt")).toContain(
      "[0:00] Speaker 1: Welcome back to Narriflow.",
    );
  });

  test("exports SRT cues", () => {
    const srt = exportTranscript(snapshot, "srt");
    expect(srt).toContain(
      "1\n00:00:00,200 --> 00:00:04,800\nSpeaker 1: Welcome back to Narriflow.",
    );
    expect(srt).toContain(
      "2\n00:00:05,100 --> 00:00:09,600\nSpeaker 2: Today we are talking about transcription quality.",
    );
  });

  test("exports VTT cues", () => {
    const vtt = exportTranscript(snapshot, "vtt");
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).toContain("00:00:05.100 --> 00:00:09.600");
  });
});
