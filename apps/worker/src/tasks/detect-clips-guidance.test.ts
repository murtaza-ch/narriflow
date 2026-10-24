import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { computePerformanceGuidance, createPerformanceGuidance, guidancePromptLine, type ClaimedWorkflowAttempt, type GuidanceVideo } from "@narriflow/services";
import { contentPackSchema, type ClipFacts, type ClipPlatformTarget } from "@narriflow/validators";
import type { ContentPack as StoredContentPack, Transcript } from "@prisma/client";
import { buildUserPrompt, processClipDetectionRun } from "./detect-clips";

type Persistence = NonNullable<Parameters<typeof processClipDetectionRun>[2]>;

const attempt: ClaimedWorkflowAttempt = {
  workflowRunId: "detection-run", projectId: "project", stage: "moment_detection", attemptId: "attempt", attemptCount: 1,
  status: "running", progress: 0, contentPackId: "pack", leaseExpiresAt: new Date(Date.now() + 60_000),
  project: { id: "project", title: "Test", sourceMediaUrl: "r2://test/source.mp4", sourceType: "upload", sourceInput: null,
    sourceStorageKey: "source.mp4", sourceMimeType: "video/mp4", sourceDurationSeconds: 120,
    createdByUserId: "actor", workspaceId: "workspace-1" },
};

type PromptArgs = {
  title: string; transcript: string; candidates: number; finalClips: number; clipDurationSec: number;
  durationPolicy: { minDurationSec: number; preferredMinDurationSec: number; preferredMaxDurationSec: number; maxDurationSec: number };
  platformTargets: ClipPlatformTarget[]; toneConstraints: string[]; speakerCount: number; durationMinutes: number;
  options: { autoHook: boolean; specificMoments: string; processingStartSec: number | null; processingEndSec: number | null; sourceLanguageCode: string | null };
};
// Prompts captured by running buildUserPrompt as it was before guidance existed
// (the integration base, c96f67af), with the arguments stored beside each one.
const BASE_PROMPTS = JSON.parse(readFileSync(new URL("./detect-clips-base-prompts.fixture.json", import.meta.url), "utf8")) as Array<{ name: string; args: PromptArgs; prompt: string }>;
const promptFor = ({ args }: { args: PromptArgs }, audienceDataLine?: string | null) =>
  buildUserPrompt(args.title, args.transcript, args.candidates, args.finalClips, args.clipDurationSec, args.durationPolicy, args.platformTargets,
    args.toneConstraints, args.speakerCount, args.durationMinutes, { ...args.options, ...(audienceDataLine === undefined ? {} : { audienceDataLine }) });

const facts = (category: ClipFacts["category"]): ClipFacts => ({
  viralityScore: 80, category, hookStrengthScore: 85, durationSec: 30, aspectRatio: "9:16", platform: "youtube_shorts", postedHour: 9,
});
let nextClip = 0;
const video = (category: ClipFacts["category"], views: number): GuidanceVideo => ({
  clip: `clip-${nextClip++}`, platform: "youtube_shorts" as const, facts: facts(category), views, likes: null, comments: null,
});
// 40 clips on one platform with a typical post of 200 views.
const QUALIFYING = computePerformanceGuidance([
  ...Array.from({ length: 15 }, () => video("story", 1_000)),
  ...Array.from({ length: 15 }, () => video("insight", 200)),
  ...Array.from({ length: 10 }, () => video("humor", 100)),
]);
const LINE = guidancePromptLine(QUALIFYING)!;

describe("moment-detection prompt construction", () => {
  test("without guidance the prompt is byte-identical to the one built before guidance existed", () => {
    expect(BASE_PROMPTS.length).toBeGreaterThan(1);
    for (const base of BASE_PROMPTS) {
      expect(promptFor(base)).toBe(base.prompt);
      expect(promptFor(base, null)).toBe(base.prompt);
      expect(base.prompt).not.toContain("Audience data");
    }
  });

  test("a guidance line is added once, as one line right after the hook guidance, and nothing else moves", () => {
    for (const base of BASE_PROMPTS) {
      const withLine = promptFor(base, LINE);
      expect(withLine.split(LINE)).toHaveLength(2);
      expect(withLine.split("\n").filter((line) => line.includes("Audience data"))).toEqual([LINE]);
      const lines = withLine.split("\n");
      const hook = lines.findIndex((line) => line.startsWith("- The first 3 seconds") || line.startsWith("- A strong opening hook is preferred"));
      expect(lines[hook + 1]).toBe(LINE);
      // Taking the line out gives back exactly the original prompt.
      expect(withLine.replace(`\n${LINE}`, "")).toBe(base.prompt);
    }
    // The scoring instructions are untouched.
    expect(promptFor(BASE_PROMPTS[0]!, LINE)).toContain("score every moment on the same scale");
  });

  test("the line says what it measures and names no hook strength", () => {
    expect(LINE).toContain("among 40 clips you posted from Narriflow");
    expect(LINE).toContain("a typical post on the same platform");
    expect(LINE).not.toContain("Hook");
  });
});

describe("clip detection with a Workspace's guidance", () => {
  const priorKey = process.env.OPENAI_API_KEY;
  beforeEach(() => { process.env.OPENAI_API_KEY = "test-key"; });
  afterEach(() => {
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = priorKey;
  });

  function pack(): StoredContentPack {
    return {
      ...contentPackSchema.parse({ outputTypes: ["short_clip"], clipCountTarget: 5, clipDurationSecTarget: 45, platformPlaybookVersion: "platform-playbook-v1" }),
      id: "pack", projectId: "project", draft: false, createdAt: new Date(), updatedAt: new Date(),
    } as unknown as StoredContentPack;
  }
  const utterances = Array.from({ length: 6 }, (_, index) => ({
    index, speaker: 0, speakerLabel: "A", startSec: index * 10, endSec: index * 10 + 9, text: `This is sentence number ${index}.`, confidence: 0.9, words: [],
  }));

  /** Runs detection against a fake OpenAI that refuses, and returns the user prompt it was sent. */
  async function promptSent(promptLine: (workspaceId: string) => Promise<string | null>) {
    const bodies: string[] = [];
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ error: { message: "stop here", type: "invalid_request_error" } }), { status: 401, headers: { "content-type": "application/json" } });
    }) as never);
    const looked: string[] = [];
    const persistence: Persistence = {
      project: {
        getContentPackForRun: async () => pack(),
        getTranscriptForWorker: async () => ({ projectId: "project", status: "completed", text: "x", speakerCount: 1, durationSeconds: 120, languageCode: "en", utterancesJson: utterances } as unknown as Transcript),
        getSourceProbeDurationForWorker: async () => null,
      },
      clips: { persistDetectedClips: async () => { throw new Error("unexpected"); }, autoQueueDefaultRenders: async () => { throw new Error("unexpected"); } },
      exports: { createForCaptionedVideo: async () => { throw new Error("unexpected"); } },
      lifecycle: { failAttempt: async () => {}, completeMomentDetection: async () => { throw new Error("unexpected"); } },
      notifyFailure: async () => {},
      guidance: { promptLine: async (workspaceId) => { looked.push(workspaceId); return promptLine(workspaceId); } },
    };
    try {
      await processClipDetectionRun(attempt, { signal: new AbortController().signal, reportProgress: async () => {} }, persistence);
    } finally {
      fetchSpy.mockRestore();
    }
    expect(bodies).toHaveLength(1);
    expect(looked).toEqual(["workspace-1"]);
    const request = JSON.parse(bodies[0]!) as { input: Array<{ role: string; content: string }> };
    return request.input.find((message) => message.role === "user")!.content;
  }

  test("the Workspace's line reaches the model once", async () => {
    const sent = await promptSent(async () => LINE);
    expect(sent.split(LINE)).toHaveLength(2);
  });

  test("no line, no mention: the prompt carries nothing about audience data", async () => {
    const sent = await promptSent(async () => null);
    expect(sent).not.toContain("Audience data");
  });

  test("a failed guidance read detects moments as before", async () => {
    const sent = await promptSent(async () => { throw new Error("database unavailable"); });
    expect(sent).not.toContain("Audience data");
  });

  test("the line is empty unless the data qualifies and the setting is on", async () => {
    const row = (setting: boolean | null, guidance = QUALIFYING) => ({ workspace: { findUnique: async () => ({ usePerformanceGuidance: setting, performanceGuidance: { ...guidance, computedAt: new Date() } }) } }) as never;
    const lineFor = (setting: boolean | null, guidance = QUALIFYING) => createPerformanceGuidance({ prisma: row(setting, guidance) }).promptLine("workspace-1");
    expect(await promptSent(() => lineFor(null))).toContain(LINE);
    expect(await promptSent(() => lineFor(false))).not.toContain("Audience data");
    expect(await promptSent(() => lineFor(true, computePerformanceGuidance([video("story", 100)])))).not.toContain("Audience data");
  });
});
