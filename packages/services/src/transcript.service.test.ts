import { describe, expect, test } from "bun:test";
import {
  buildTranscriptSnapshot,
  exportTranscript,
  normalizeAssemblyAiTranscript,
} from "./transcript.service";

const assemblyAiFixture = {
  id: "aai-transcript-123",
  status: "completed",
  text: "Welcome back to Narriflow.\n\nToday we are talking about transcription quality.",
  language_code: "en",
  language_confidence: 0.97,
  speech_model_used: "universal-3-5-pro",
  speech_models: ["universal-3-5-pro", "universal-2"],
  audio_duration: 31.8,
  utterances: [
    {
      start: 200,
      end: 4800,
      text: "Welcome back to Narriflow.",
      confidence: 0.98,
      speaker: "A",
      words: [
        { text: "Welcome", start: 200, end: 800, confidence: 0.99, speaker: "A" },
        { text: "back", start: 900, end: 1300, confidence: 0.98, speaker: "A" },
        { text: "to", start: 1400, end: 1600, confidence: 0.97, speaker: "A" },
        { text: "Narriflow.", start: 1700, end: 4800, confidence: 0.96, speaker: "A" },
      ],
    },
    {
      start: 5100,
      end: 9600,
      text: "Today we are talking about transcription quality.",
      confidence: 0.95,
      speaker: "B",
      words: [
        { text: "Today", start: 5100, end: 5500, confidence: 0.97, speaker: "B" },
        { text: "we", start: 5600, end: 5800, confidence: 0.98, speaker: "B" },
        { text: "are", start: 5900, end: 6100, confidence: 0.96, speaker: "B" },
        { text: "talking", start: 6200, end: 6800, confidence: 0.95, speaker: "B" },
        { text: "about", start: 6900, end: 7200, confidence: 0.97, speaker: "B" },
        { text: "transcription", start: 7300, end: 8500, confidence: 0.93, speaker: "B" },
        { text: "quality.", start: 8600, end: 9600, confidence: 0.94, speaker: "B" },
      ],
    },
    {
      start: 10000,
      end: 12350,
      text: "That timing matters.",
      confidence: 0.93,
      speaker: "A",
      words: [
        { text: "That", start: 10000, end: 10400, confidence: 0.94, speaker: "A" },
        { text: "timing", start: 10500, end: 11200, confidence: 0.91, speaker: "A" },
        { text: "matters.", start: 11300, end: 12350, confidence: 0.93, speaker: "A" },
      ],
    },
  ],
};

describe("normalizeAssemblyAiTranscript", () => {
  test("normalizes utterances, speakers, model metadata, and language", () => {
    const normalized = normalizeAssemblyAiTranscript(assemblyAiFixture);

    expect(normalized.provider).toBe("assemblyai");
    expect(normalized.providerModel).toBe("universal-3-5-pro");
    expect(normalized.providerJobId).toBe("aai-transcript-123");
    expect(normalized.languageCode).toBe("en");
    expect(normalized.languageConfidence).toBe(0.97);
    expect(normalized.durationSeconds).toBe(32);
    expect(normalized.speakerCount).toBe(2);
    expect(normalized.rawPayload).toBe(assemblyAiFixture);
    expect(normalized.utterances).toHaveLength(3);
    expect(normalized.utterances[0]).toEqual(
      expect.objectContaining({
        speaker: 0,
        speakerLabel: "Speaker 1",
        startSec: 0.2,
        endSec: 4.8,
        text: "Welcome back to Narriflow.",
      }),
    );
    expect(normalized.utterances[1]).toEqual(
      expect.objectContaining({
        speaker: 1,
        speakerLabel: "Speaker 2",
      }),
    );
    expect(normalized.utterances[2]).toEqual(
      expect.objectContaining({
        speaker: 0,
        speakerLabel: "Speaker 1",
      }),
    );
  });

  test("converts word timings from milliseconds to seconds", () => {
    const normalized = normalizeAssemblyAiTranscript(assemblyAiFixture);

    expect(normalized.utterances[0]!.words[0]).toEqual({
      word: "Welcome",
      startSec: 0.2,
      endSec: 0.8,
      confidence: 0.99,
    });
    expect(normalized.utterances[1]!.words[6]).toEqual({
      word: "quality.",
      startSec: 8.6,
      endSec: 9.6,
      confidence: 0.94,
    });
  });

  test("falls back for optional metadata without crashing", () => {
    const normalized = normalizeAssemblyAiTranscript({
      speech_models: ["universal-3-5-pro", "universal-2"],
      language_confidence: 1.2,
      utterances: [
        {
          start: 0,
          end: 1000,
          text: "Hello world",
          speaker: "A",
          words: [{ text: "Hello", start: 0, end: 1000 }],
        },
      ],
    });

    expect(normalized.providerModel).toBeNull();
    expect(normalized.providerJobId).toBeNull();
    expect(normalized.languageCode).toBeNull();
    expect(normalized.languageConfidence).toBeNull();
    expect(normalized.utterances[0]!.confidence).toBeNull();
    expect(normalized.utterances[0]!.words[0]!.confidence).toBeNull();
  });

  test("fails when AssemblyAI does not return utterances", () => {
    expect(() => normalizeAssemblyAiTranscript({ utterances: [] })).toThrow(
      "AssemblyAI transcript did not include diarized utterances",
    );
  });

  test("fails when speaker labels are missing", () => {
    expect(() =>
      normalizeAssemblyAiTranscript({
        utterances: [
          {
            start: 0,
            end: 1000,
            text: "Hello world",
            words: [{ text: "Hello", start: 0, end: 1000 }],
          },
        ],
      }),
    ).toThrow("AssemblyAI utterance was missing a speaker label");
  });

  test("fails when word timestamps are missing", () => {
    expect(() =>
      normalizeAssemblyAiTranscript({
        utterances: [
          {
            start: 0,
            end: 1000,
            text: "Hello world",
            speaker: "A",
            words: [{ text: "Hello", start: 0 }],
          },
        ],
      }),
    ).toThrow("AssemblyAI word was missing start or end timestamp");
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
