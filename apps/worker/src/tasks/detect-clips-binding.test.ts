import { describe, expect, spyOn, test } from "bun:test";
import { WorkflowAttemptLost, WorkflowFailure, type ClaimedWorkflowAttempt } from "@narriflow/services";
import { contentPackSchema } from "@narriflow/validators";
import type { ContentPack as StoredContentPack, Transcript } from "@prisma/client";
import { processClipDetectionRun } from "./detect-clips";

type Persistence = NonNullable<Parameters<typeof processClipDetectionRun>[2]>;
const attempt: ClaimedWorkflowAttempt = {
  workflowRunId: "detection-run", projectId: "project", stage: "moment_detection", attemptId: "attempt", attemptCount: 1,
  status: "running", progress: 0, contentPackId: "bound-pack", leaseExpiresAt: new Date(Date.now() + 60_000),
  project: { id: "project", title: "Test", sourceMediaUrl: "r2://test/source.mp4", sourceType: "upload", sourceInput: null,
    sourceStorageKey: "source.mp4", sourceMimeType: "video/mp4", sourceDurationSeconds: 50,
    createdByUserId: "actor", workspaceId: "workspace" },
};

function storedPack(): StoredContentPack {
  return {
    ...contentPackSchema.parse({ outputTypes: ["short_clip"], clipCountTarget: 10, clipDurationSecTarget: 45,
      platformPlaybookVersion: "platform-playbook-v1", mode: "caption_only", processingStartSec: 5, processingEndSec: 35, defaultAspectRatio: "1:1" }),
    id: "bound-pack", projectId: "project", draft: false, createdAt: new Date(), updatedAt: new Date(),
  };
}

function harness(readPack: Persistence["project"]["getContentPackForRun"]) {
  const failures: WorkflowFailure[] = [];
  const notices: Array<Parameters<Persistence["notifyFailure"]>[0]> = [];
  let transcriptReads = 0;
  let clipWrites = 0;
  let completions = 0;
  const persistence: Persistence = {
    project: {
      getContentPackForRun: readPack,
      getTranscriptForWorker: async () => { transcriptReads++; throw new Error("Unexpected transcript read"); },
      getSourceProbeDurationForWorker: async () => null,
    },
    clips: {
      persistDetectedClips: async () => { clipWrites++; throw new Error("Unexpected clip write"); },
      autoQueueDefaultRenders: async () => { throw new Error("Unexpected render admission"); },
    },
    exports: {
      captionedExportWrite: () => { throw new Error("Unexpected export admission"); },
    },
    lifecycle: {
      failAttempt: async (received, failure) => { expect(received).toEqual(attempt); failures.push(failure); },
      completeMomentDetection: async () => { completions++; },
    },
    notifyFailure: async (notice) => { notices.push(notice); },
    guidance: { promptLine: async () => null },
  };
  const context = { signal: new AbortController().signal, reportProgress: async () => {} };
  return { persistence, context, failures, notices, counts: () => ({ transcriptReads, clipWrites, completions }) };
}

describe("Clip detection bound Content Pack execution", () => {
  test.each([
    ["missing committed binding", null],
    ["invalid caption preset", { ...storedPack(), captionPreset: "obsolete free-form preset" }],
    ["contradictory processing window", { ...storedPack(), processingStartSec: 35, processingEndSec: 5 }],
  ] as const)("permanently rejects %s before transcript, model or clip work", async (_reason, row) => {
    const h = harness(async (received) => {
      expect(received).toEqual({ projectId: attempt.projectId, contentPackId: attempt.contentPackId });
      return row;
    });
    await processClipDetectionRun(attempt, h.context, h.persistence);
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]).toMatchObject({ code: "workflow_content_pack_invalid", disposition: "permanent" });
    expect(h.notices).toMatchObject([{ workflowRunId: attempt.workflowRunId, projectId: attempt.projectId, errorCode: "workflow_content_pack_invalid" }]);
    expect(h.counts()).toEqual({ transcriptReads: 0, clipWrites: 0, completions: 0 });
  });

  test("an unbound run cannot adopt default generation settings", async () => {
    const unbound = { ...attempt, contentPackId: null };
    const h = harness(async (received) => { expect(received.contentPackId).toBeNull(); return null; });
    h.persistence.lifecycle.failAttempt = async (received, failure) => { expect(received).toEqual(unbound); h.failures.push(failure); };
    await processClipDetectionRun(unbound, h.context, h.persistence);
    expect(h.failures).toMatchObject([{ code: "workflow_content_pack_invalid", disposition: "permanent" }]);
    expect(h.counts().transcriptReads).toBe(0);
  });

  test("a valid bound caption-only pack preserves its window and requested aspect ratio through persistence and render admission", async () => {
    const pack = storedPack();
    const h = harness(async () => pack);
    h.persistence.project.getTranscriptForWorker = async () => ({
      projectId: attempt.projectId, status: "completed", text: "Ready source", speakerCount: 1,
      durationSeconds: 50, languageCode: "en", utterancesJson: [],
    } as unknown as Transcript);
    let saved = false;
    let rendered = false;
    h.persistence.clips.persistDetectedClips = async (received, clips, metadata, settings) => {
      expect(received).toEqual(attempt);
      expect(clips).toHaveLength(1);
      expect(clips[0]).toMatchObject({ startSec: 5, endSec: 35, reasoning: "Caption-only mode: full-length captioned render" });
      expect(metadata).toEqual({ provider: "openai", model: "caption-only", totalTokensUsed: 0 });
      expect(settings).toEqual(contentPackSchema.parse(pack));
      saved = true;
    };
    h.persistence.clips.autoQueueDefaultRenders = async (received, aspectRatio) => {
      expect(received).toEqual(attempt); expect(aspectRatio).toBe("1:1"); expect(saved).toBe(true); rendered = true;
    };
    await processClipDetectionRun(attempt, h.context, h.persistence);
    expect(rendered).toBe(true);
    expect(h.counts().completions).toBe(1);
    expect(h.failures).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  describe("captioned videos", () => {
    const captionedPack = (captionedVideo: Record<string, unknown>, overrides: Record<string, unknown> = {}): StoredContentPack => ({
      ...storedPack(),
      processingStartSec: null, processingEndSec: null, defaultAspectRatio: "9:16",
      ...contentPackSchema.parse({ outputTypes: ["short_clip"], clipCountTarget: 10, clipDurationSecTarget: 45,
        platformPlaybookVersion: "platform-playbook-v1", mode: "caption_only", captionedVideo, ...overrides }),
      captionedVideo,
    } as unknown as StoredContentPack);
    const settings = { framing: "fit", aspectRatios: ["9:16", "1:1"], resolution: "1080p", captions: { source: "none" } };
    const emptyTranscript = (durationSeconds: number) => async () => ({
      projectId: attempt.projectId, status: "completed", text: "", speakerCount: 0, durationSeconds, languageCode: null, utterancesJson: [],
    } as unknown as Transcript);

    test("accepts an empty transcript, ends the clip at the probed duration, and exports instead of rendering a preview", async () => {
      const h = harness(async () => captionedPack(settings));
      h.persistence.project.getTranscriptForWorker = emptyTranscript(8);
      h.persistence.project.getSourceProbeDurationForWorker = async () => 7.6;
      const short = { ...attempt, project: { ...attempt.project, sourceDurationSeconds: 8 } };
      let exported: unknown = null;
      const writer = async () => ({ exportId: "export", clipId: "clip" });
      h.persistence.clips.persistDetectedClips = async (_received, clips) => {
        expect(clips).toHaveLength(1);
        expect(clips[0]).toMatchObject({ startSec: 0, endSec: 7.6, transcriptSlice: [] });
      };
      h.persistence.exports.captionedExportWrite = ((received: unknown, received2: unknown) => { expect(received).toEqual(short); exported = received2; return writer; }) as never;
      let completedWith: unknown = null;
      h.persistence.lifecycle.completeMomentDetection = async (_received, options) => { completedWith = options?.admit; };
      await processClipDetectionRun(short, h.context, h.persistence);
      expect(exported).toEqual(contentPackSchema.parse(captionedPack(settings)).captionedVideo);
      // The export is admitted by the transaction that completes detection, not before it.
      expect(completedWith).toBe(writer);
      expect(h.failures).toEqual([]);
    });

    test("the clip keeps the probed tail the rounded duration would have lost", async () => {
      const h = harness(async () => captionedPack(settings));
      h.persistence.project.getTranscriptForWorker = emptyTranscript(8);
      h.persistence.project.getSourceProbeDurationForWorker = async () => 8.4;
      let window: [number, number] | null = null;
      h.persistence.clips.persistDetectedClips = async (_received, clips) => { window = [clips[0]!.startSec, clips[0]!.endSec]; };
      h.persistence.exports.captionedExportWrite = (() => async () => ({ exportId: "export", clipId: "clip" })) as never;
      await processClipDetectionRun({ ...attempt, project: { ...attempt.project, sourceDurationSeconds: 8 } }, h.context, h.persistence);
      expect(window).toEqual([0, 8.4]);
      expect(h.counts().completions).toBe(1);
      expect(h.failures).toEqual([]);
    });

    test("an empty transcript still fails a clip-mode run", async () => {
      const h = harness(async () => ({ ...storedPack(), mode: "clip", processingStartSec: null, processingEndSec: null } as StoredContentPack));
      h.persistence.project.getTranscriptForWorker = emptyTranscript(60);
      await processClipDetectionRun(attempt, h.context, h.persistence);
      expect(h.failures).toMatchObject([{ code: "source_has_no_speech", disposition: "permanent" }]);
    });

    test("refuses a source beyond 3 minutes permanently, before any clip or export is written", async () => {
      const h = harness(async () => captionedPack(settings));
      h.persistence.project.getTranscriptForWorker = emptyTranscript(181);
      const long = { ...attempt, project: { ...attempt.project, sourceDurationSeconds: 181 } };
      h.persistence.lifecycle.failAttempt = async (_received, failure) => { h.failures.push(failure); };
      await processClipDetectionRun(long, h.context, h.persistence);
      expect(h.failures).toMatchObject([{ code: "whole_source_too_long", disposition: "permanent" }]);
      expect(h.counts().clipWrites).toBe(0);
    });

    test("accepts the 3-minute edge and an 8-second source", async () => {
      for (const seconds of [180, 8]) {
        const h = harness(async () => captionedPack(settings));
        h.persistence.project.getTranscriptForWorker = emptyTranscript(seconds);
        let window: [number, number] | null = null;
        h.persistence.clips.persistDetectedClips = async (_received, clips) => { window = [clips[0]!.startSec, clips[0]!.endSec]; };
        h.persistence.exports.captionedExportWrite = (() => async () => ({ exportId: "export", clipId: "clip" })) as never;
        await processClipDetectionRun({ ...attempt, project: { ...attempt.project, sourceDurationSeconds: seconds } }, h.context, h.persistence);
        expect(window).toEqual([0, seconds]);
        expect(h.failures).toEqual([]);
      }
    });
  });

  test("a clip-mode pack queues automatic renders in its requested aspect ratio", async () => {
    const pack = { ...storedPack(), mode: "clip", processingStartSec: null, processingEndSec: null, defaultAspectRatio: "4:5" } as StoredContentPack;
    const h = harness(async () => pack);
    const utterances = Array.from({ length: 12 }, (_, index) => ({ speaker: "A", startSec: index * 5, endSec: index * 5 + 4.8,
      text: `Sentence number ${index + 1} explains one complete idea.`, words: [] }));
    h.persistence.project.getTranscriptForWorker = async () => ({
      projectId: attempt.projectId, status: "completed", text: "Ready source", speakerCount: 1,
      durationSeconds: 60, languageCode: "en", utterancesJson: utterances,
    } as unknown as Transcript);
    const clip = { title: "Complete idea", start_time: 0, end_time: 39.8, hook_text: "Sentence number 1", payoff_text: "Sentence number 8",
      reasoning: "Complete story", category: "story", platform_fit: ["tiktok"], hook_strength: 80, emotional_intensity: 60,
      story_completeness_score: 90, broll_cues: [] };
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => Response.json({ status: "completed",
      output_text: JSON.stringify({ clips: [clip] }), usage: { total_tokens: 10 } })) as unknown as typeof fetch);
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    let renderedRatio: string | null = null;
    h.persistence.clips.persistDetectedClips = async () => {};
    h.persistence.clips.autoQueueDefaultRenders = async (_received, aspectRatio) => { renderedRatio = aspectRatio; };
    try { await processClipDetectionRun(attempt, h.context, h.persistence); }
    finally { fetchSpy.mockRestore(); process.env.OPENAI_API_KEY = previousKey; }
    expect(h.failures).toEqual([]);
    expect(renderedRatio).toBe("4:5");
  });

  test("a binding read failure keeps its causal retry classification", async () => {
    const failure = new WorkflowFailure("database_temporarily_unavailable", "retryable", "Retry the read");
    const h = harness(async () => { throw failure; });
    await processClipDetectionRun(attempt, h.context, h.persistence);
    expect(h.failures).toEqual([failure]);
    expect(h.counts().transcriptReads).toBe(0);
  });

  test("claim loss during the binding read propagates without failure settlement", async () => {
    const lost = new WorkflowAttemptLost(attempt);
    const h = harness(async () => { throw lost; });
    await expect(processClipDetectionRun(attempt, h.context, h.persistence)).rejects.toBe(lost);
    expect(h.failures).toEqual([]);
    expect(h.notices).toEqual([]);
    expect(h.counts().transcriptReads).toBe(0);
  });
});
