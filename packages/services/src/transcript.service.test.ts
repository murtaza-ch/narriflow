import { describe, expect, test } from "bun:test";
import {
  buildTranscriptSnapshot,
  exportTranscript,
  normalizeDeepgramTranscript,
} from "./transcript.service";

describe("normalizeDeepgramTranscript", () => {
  test("normalizes utterances, speaker labels, and language", () => {
    const normalized = normalizeDeepgramTranscript({
      metadata: {
        duration: 31.8,
        model_info: {
          "nova-3": {
            name: "nova-3",
          },
        },
      },
      results: {
        utterances: [
          {
            start: 0.2,
            end: 4.8,
            transcript: "Welcome back to Narriflow.",
            confidence: 0.98,
            speaker: 0,
            words: [
              { word: "welcome", punctuated_word: "Welcome", start: 0.2, end: 0.8, confidence: 0.99 },
              { word: "back", punctuated_word: "back", start: 0.9, end: 1.3, confidence: 0.98 },
              { word: "to", punctuated_word: "to", start: 1.4, end: 1.6, confidence: 0.97 },
              { word: "narriflow", punctuated_word: "Narriflow.", start: 1.7, end: 4.8, confidence: 0.96 },
            ],
          },
          {
            start: 5.1,
            end: 9.6,
            transcript: "Today we are talking about transcription quality.",
            confidence: 0.95,
            speaker: 1,
            words: [
              { word: "today", punctuated_word: "Today", start: 5.1, end: 5.5, confidence: 0.97 },
              { word: "we", punctuated_word: "we", start: 5.6, end: 5.8, confidence: 0.98 },
              { word: "are", punctuated_word: "are", start: 5.9, end: 6.1, confidence: 0.96 },
              { word: "talking", punctuated_word: "talking", start: 6.2, end: 6.8, confidence: 0.95 },
              { word: "about", punctuated_word: "about", start: 6.9, end: 7.2, confidence: 0.97 },
              { word: "transcription", punctuated_word: "transcription", start: 7.3, end: 8.5, confidence: 0.93 },
              { word: "quality", punctuated_word: "quality.", start: 8.6, end: 9.6, confidence: 0.94 },
            ],
          },
        ],
        channels: [
          {
            alternatives: [
              {
                transcript:
                  "Welcome back to Narriflow. Today we are talking about transcription quality.",
                languages: ["en"],
              },
            ],
          },
        ],
      },
    });

    expect(normalized.provider).toBe("deepgram");
    expect(normalized.providerModel).toBe("nova-3");
    expect(normalized.languageCode).toBe("en");
    expect(normalized.durationSeconds).toBe(32);
    expect(normalized.speakerCount).toBe(2);
    expect(normalized.utterances).toHaveLength(2);
    expect(normalized.utterances[0]).toEqual(
      expect.objectContaining({
        speakerLabel: "Speaker 1",
        text: "Welcome back to Narriflow.",
      }),
    );
  });

  test("captures word-level timing from Deepgram utterances", () => {
    const normalized = normalizeDeepgramTranscript({
      metadata: { duration: 10 },
      results: {
        utterances: [
          {
            start: 1.0,
            end: 3.5,
            transcript: "hello world",
            confidence: 0.95,
            speaker: 0,
            words: [
              { word: "hello", punctuated_word: "Hello", start: 1.0, end: 1.8, confidence: 0.97 },
              { word: "world", punctuated_word: "world", start: 2.0, end: 3.5, confidence: 0.93 },
            ],
          },
        ],
        channels: [{ alternatives: [{ transcript: "hello world" }] }],
      },
    });

    expect(normalized.utterances[0]!.words).toHaveLength(2);
    expect(normalized.utterances[0]!.words[0]).toEqual({
      word: "Hello",
      startSec: 1.0,
      endSec: 1.8,
      confidence: 0.97,
    });
    expect(normalized.utterances[0]!.words[1]).toEqual({
      word: "world",
      startSec: 2.0,
      endSec: 3.5,
      confidence: 0.93,
    });
  });

  test("returns empty words array when utterance has no word data", () => {
    const normalized = normalizeDeepgramTranscript({
      metadata: { duration: 5 },
      results: {
        utterances: [
          {
            start: 0,
            end: 5,
            transcript: "Hello world",
            confidence: 0.9,
            speaker: 0,
          },
        ],
        channels: [{ alternatives: [{ transcript: "Hello world" }] }],
      },
    });

    expect(normalized.utterances[0]!.words).toEqual([]);
  });
});

describe("exportTranscript", () => {
  const snapshot = buildTranscriptSnapshot({
    projectId: "72e62077-cfc8-446b-9dd1-29bd72020858",
    status: "completed",
    provider: "deepgram",
    providerModel: "nova-3",
    languageCode: "en",
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
