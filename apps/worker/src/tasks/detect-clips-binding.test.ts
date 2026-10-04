import { describe, expect, test } from "bun:test";
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
      platformPlaybookVersion: "2026.2", mode: "caption_only", processingStartSec: 5, processingEndSec: 35 }),
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
    },
    clips: {
      persistDetectedClips: async () => { clipWrites++; throw new Error("Unexpected clip write"); },
      autoQueueDefaultRenders: async () => { throw new Error("Unexpected render admission"); },
    },
    lifecycle: {
      failAttempt: async (received, failure) => { expect(received).toEqual(attempt); failures.push(failure); },
      completeMomentDetection: async () => { completions++; },
    },
    notifyFailure: async (notice) => { notices.push(notice); },
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

  test("a valid bound caption-only pack preserves its window through persistence and render admission", async () => {
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
      expect(received).toEqual(attempt); expect(aspectRatio).toBe("16:9"); expect(saved).toBe(true); rendered = true;
    };
    await processClipDetectionRun(attempt, h.context, h.persistence);
    expect(rendered).toBe(true);
    expect(h.counts().completions).toBe(1);
    expect(h.failures).toEqual([]);
    expect(h.notices).toEqual([]);
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
