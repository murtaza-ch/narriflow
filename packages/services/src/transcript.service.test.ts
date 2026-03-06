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
          },
          {
            start: 5.1,
            end: 9.6,
            transcript: "Today we are talking about transcription quality.",
            confidence: 0.95,
            speaker: 1,
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
      },
      {
        index: 1,
        speaker: 1,
        speakerLabel: "Speaker 2",
        startSec: 5.1,
        endSec: 9.6,
        text: "Today we are talking about transcription quality.",
        confidence: 0.95,
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
