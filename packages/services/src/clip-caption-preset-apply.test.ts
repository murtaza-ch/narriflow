import { describe, expect, test } from "bun:test";
import { DEFAULT_CAPTION_PRESET, editorDocumentSchema, studioEditsSchema, type CaptionEmojiRef, type EditorDocument } from "@narriflow/validators";
import { applyCaptionPresetToProject, type ApplyClipEmojiSuggester } from "./clip-caption-preset-apply";
import {
  createClipEditorDocumentPersistence,
  createInMemoryClipEditorDocumentStore,
  type ClipEditorDocumentDiagnostics,
  type ClipEditorDocumentStoredState,
} from "./clip-editor-document-persistence";
import type { CaptionEmojiTaggingOutcome } from "./clip-emoji-tagging";

const words = ["this", "pizza", "is", "fire"].map((word, index) => ({ word, startSec: 10 + index * 0.5, endSec: 10.5 + index * 0.5, confidence: null }));

function document(captionEmojis?: Record<string, CaptionEmojiRef>): EditorDocument {
  return editorDocumentSchema.parse({
    version: 1, clipStartSec: 10, clipEndSec: 30, captionPreset: DEFAULT_CAPTION_PRESET, brollUrl: null, deletedRanges: [],
    transcriptSlice: [{ index: 0, speaker: 0, speakerLabel: "Speaker A", startSec: 10, endSec: 12, text: "this pizza is fire", confidence: null, words }],
    studioEdits: studioEditsSchema.parse(captionEmojis ? { captionEmojis } : undefined),
  });
}

function stored(clipId: string, captionEmojis?: Record<string, CaptionEmojiRef>): ClipEditorDocumentStoredState {
  return {
    workspaceId: "workspace-1", projectId: "project-1", clipId, revision: 3, document: document(captionEmojis), original: null, title: null, hookText: "",
    sourceDurationSec: 300, wholeSource: false, sourceStorageKey: "projects/project-1/source.mp4", sourceTranscript: [], viralityScore: 70,
    status: "detected", preview: { storageKey: null, startSec: null, durationSec: null }, evidence: { screen: null, automatic: null, split: null },
    scores: { durationOptimality: 80, tiktok: 80, youtube: 70, instagram: 75 },
    mutableRenders: [{ id: `render-${clipId}`, storageKey: `projects/project-1/renders/${clipId}.mp4` }],
  };
}

const withEmojis = { ...DEFAULT_CAPTION_PRESET, fontName: "Anton", emojis: true };
const scope = { actorUserId: "editor-1", workspaceId: "workspace-1", projectId: "project-1" };
const outcome = (over: Partial<CaptionEmojiTaggingOutcome> = {}): CaptionEmojiTaggingOutcome =>
  ({ chunks: 1, tagged: 1, failed: 0, retried: 0, rateLimited: 0, skipped: 0, unsafe: 0, tokensUsed: 10, picks: [], ...over });
const yum = { "10500": { id: "yum" } };

function setup(seeds: ClipEditorDocumentStoredState[]) {
  const store = createInMemoryClipEditorDocumentStore(seeds);
  const events: Parameters<ClipEditorDocumentDiagnostics["record"]>[0][] = [];
  const persistence = createClipEditorDocumentPersistence({ authorize: async () => ({ pricingTier: "business" }), store, diagnostics: { record: (event) => events.push(event) } });
  return { store, persistence, events };
}

function recording(reply: (clipId: string) => ReturnType<ApplyClipEmojiSuggester>) {
  const calls: string[] = [];
  const suggest: ApplyClipEmojiSuggester = (clip) => { calls.push(clip.clipId); return reply(clip.clipId); };
  return { calls, suggest };
}

describe("applyCaptionPresetToProject", () => {
  test("with emojis on, clips without emojis get them in the preset's update and clips with emojis keep theirs", async () => {
    const { store, persistence, events } = setup([stored("clip-a"), stored("clip-b", { "11500": { id: "fire" } }), stored("clip-open")]);
    const { calls, suggest } = recording(async () => ({ emojis: yum, outcome: outcome(), complete: true }));
    const prepared: string[][] = [];

    const result = await applyCaptionPresetToProject({ ...scope, excludeClipId: "clip-open", captionPreset: withEmojis },
      { persistence, prepareSuggester: async (clipIds) => { prepared.push(clipIds); return suggest; } });

    expect(result).toEqual({ updated: 2, captionEmojis: { added: 1, failed: 0 } });
    expect(prepared).toEqual([["clip-a"]]);
    expect(calls).toEqual(["clip-a"]);
    expect(store.inspect("clip-a")).toMatchObject({ writeCount: 1,
      state: { revision: 4, mutableRenders: [], document: { captionPreset: withEmojis, studioEdits: { captionEmojis: yum } } } });
    expect(store.inspect("clip-b")).toMatchObject({ writeCount: 1,
      state: { revision: 4, document: { captionPreset: withEmojis, studioEdits: { captionEmojis: { "11500": { id: "fire" } } } } } });
    expect(store.inspect("clip-open")).toMatchObject({ writeCount: 0, state: { revision: 3 } });
    // One revision and the same invalidation as a plain preset apply.
    expect(events.map((event) => [event.clipId, event.resultingRevision, event.invalidationClasses])).toEqual([
      ["clip-a", 4, ["mutable_renders"]], ["clip-b", 4, ["mutable_renders"]]]);
  });

  test("a clip that already has the preset still gets its emojis", async () => {
    const seed = stored("clip-a");
    seed.document = { ...seed.document, captionPreset: withEmojis };
    const { store, persistence } = setup([seed]);
    const { suggest } = recording(async () => ({ emojis: yum, outcome: outcome(), complete: true }));

    await expect(applyCaptionPresetToProject({ ...scope, captionPreset: withEmojis }, { persistence, prepareSuggester: async () => suggest }))
      .resolves.toEqual({ updated: 1, captionEmojis: { added: 1, failed: 0 } });
    expect(store.inspect("clip-a")?.state.document.studioEdits.captionEmojis).toEqual(yum);
  });

  test("with emojis off nothing is read for tagging or called", async () => {
    const { store, persistence } = setup([stored("clip-a")]);
    let prepared = 0;
    const result = await applyCaptionPresetToProject({ ...scope, captionPreset: { ...withEmojis, emojis: false } },
      { persistence, prepareSuggester: async () => { prepared += 1; return null; } });

    expect(result).toEqual({ updated: 1, captionEmojis: { added: 0, failed: 0 } });
    expect(prepared).toBe(0);
    expect(store.inspect("clip-a")?.state.document.studioEdits.captionEmojis).toBeUndefined();
  });

  test("a failing tagger still applies the preset and counts the clips it could not fill", async () => {
    const { store, persistence } = setup([stored("clip-a"), stored("clip-b"), stored("clip-c"), stored("clip-d"), stored("clip-e")]);
    const { calls, suggest } = recording(async (clipId) => {
      if (clipId === "clip-a") throw new Error("socket hang up");
      if (clipId === "clip-b") return { emojis: {}, outcome: outcome({ tagged: 0, failed: 1, rateLimited: 1 }), complete: false };
      // Tagged, and nothing fits: not a failure.
      if (clipId === "clip-c") return { emojis: {}, outcome: outcome() };
      // Failed after the tagger's own retry.
      if (clipId === "clip-e") return { emojis: {}, outcome: outcome({ tagged: 0, failed: 1, retried: 1 }), complete: false };
      return { emojis: yum, outcome: outcome() };
    });

    const result = await applyCaptionPresetToProject({ ...scope, captionPreset: withEmojis }, { persistence, concurrency: 1, prepareSuggester: async () => suggest });

    expect(result).toEqual({ updated: 5, captionEmojis: { added: 1, failed: 3 } });
    // One call per clip: the tagger retries a failed request itself (`tagCaptionEmojis`).
    expect(calls).toEqual(["clip-a", "clip-b", "clip-c", "clip-d", "clip-e"]);
    for (const clipId of ["clip-a", "clip-b", "clip-c", "clip-d", "clip-e"]) {
      expect(store.inspect(clipId)).toMatchObject({ writeCount: 1, state: { revision: 4, document: { captionPreset: withEmojis } } });
    }
    expect(store.inspect("clip-d")?.state.document.studioEdits.captionEmojis).toEqual(yum);
  });

  test("a clip tagged only in part keeps what was tagged", async () => {
    const { store, persistence } = setup([stored("clip-a")]);
    const { suggest } = recording(async () => ({ emojis: yum, outcome: outcome({ chunks: 2, tagged: 1, failed: 1 }), complete: false }));
    await expect(applyCaptionPresetToProject({ ...scope, captionPreset: withEmojis }, { persistence, prepareSuggester: async () => suggest }))
      .resolves.toEqual({ updated: 1, captionEmojis: { added: 1, failed: 0 } });
    expect(store.inspect("clip-a")?.state.document.studioEdits.captionEmojis).toEqual(yum);
  });

  test("no suggester (no key, closed admission or a throw) applies the preset without emojis", async () => {
    for (const prepareSuggester of [async () => null, async () => { throw new Error("admission closed"); }]) {
      const { store, persistence } = setup([stored("clip-a"), stored("clip-b")]);
      await expect(applyCaptionPresetToProject({ ...scope, captionPreset: withEmojis }, { persistence, prepareSuggester }))
        .resolves.toEqual({ updated: 2, captionEmojis: { added: 0, failed: 2 } });
      expect(store.inspect("clip-a")).toMatchObject({ writeCount: 1, state: { document: { captionPreset: withEmojis } } });
    }
  });

  test("the time budget stops further calls", async () => {
    const { persistence } = setup(["a", "b", "c", "d", "e"].map((id) => stored(`clip-${id}`)));
    let clock = 0;
    const deadlines: number[] = [];
    const { calls, suggest } = recording(async () => { clock += 8_000; return { emojis: yum, outcome: outcome() }; });

    const result = await applyCaptionPresetToProject({ ...scope, captionPreset: withEmojis },
      { persistence, now: () => clock, concurrency: 1, prepareSuggester: async () => (clip, options) => { deadlines.push(options.deadline); return suggest(clip, options); } });

    // Calls start at 0, 8 and 16 s; at 24 s the 20 s budget is spent.
    expect(calls).toEqual(["clip-a", "clip-b", "clip-c"]);
    expect(deadlines).toEqual([20_000, 20_000, 20_000]);
    expect(result).toEqual({ updated: 5, captionEmojis: { added: 3, failed: 2 } });
  });

  test("emojis added while the model runs are kept", async () => {
    const { store, persistence } = setup([stored("clip-a"), stored("clip-b")]);
    const hand = { "12000": { id: "thumbs-up" } };
    const { suggest } = recording(async (clipId) => {
      if (clipId === "clip-a") {
        await persistence.mutateDocument({ ...scope, clipId, intent: { kind: "set_studio_edits", studioEdits: { ...document().studioEdits, captionEmojis: hand } } });
      }
      return { emojis: yum, outcome: outcome() };
    });

    const result = await applyCaptionPresetToProject({ ...scope, captionPreset: withEmojis }, { persistence, concurrency: 1, prepareSuggester: async () => suggest });

    expect(result).toEqual({ updated: 2, captionEmojis: { added: 1, failed: 0 } });
    expect(store.inspect("clip-a")).toMatchObject({ state: { revision: 5, document: { captionPreset: withEmojis, studioEdits: { captionEmojis: hand } } } });
    expect(store.inspect("clip-b")?.state.document.studioEdits.captionEmojis).toEqual(yum);
  });

  test("a clip whose words changed while the model ran gets the preset without those emojis, counted as failed", async () => {
    const { store, persistence } = setup([stored("clip-a"), stored("clip-b"), stored("clip-c")]);
    const { suggest } = recording(async (clipId) => {
      // A line rewrite on clip-a and a cut on clip-c, after the apply read them: the suggestion was made for other words.
      if (clipId === "clip-a") {
        const rewritten = [{ ...document().transcriptSlice[0]!, text: "this pasta is fire", words: words.map((word, index) => (index === 1 ? { ...word, word: "pasta" } : word)) }];
        await persistence.mutateDocument({ ...scope, clipId, intent: { kind: "set_transcript", transcriptSlice: rewritten } });
      }
      if (clipId === "clip-c") {
        const current = (await store.read({ ...scope, clipId }))!;
        await persistence.mutateDocument({ ...scope, clipId, intent: { kind: "replace", baseRevision: current.revision, document: { ...current.document, deletedRanges: [{ startSec: 10.5, endSec: 11 }] } } });
      }
      return { emojis: yum, outcome: outcome() };
    });

    const result = await applyCaptionPresetToProject({ ...scope, captionPreset: withEmojis }, { persistence, concurrency: 1, prepareSuggester: async () => suggest });

    expect(result).toEqual({ updated: 3, captionEmojis: { added: 1, failed: 2 } });
    for (const clipId of ["clip-a", "clip-c"]) {
      expect(store.inspect(clipId)).toMatchObject({ state: { revision: 5, document: { captionPreset: withEmojis } } });
      expect(store.inspect(clipId)?.state.document.studioEdits.captionEmojis).toBeUndefined();
    }
    expect(store.inspect("clip-b")?.state.document.studioEdits.captionEmojis).toEqual(yum);
  });

  test("an edit between the apply's read and its commit is re-read before emojis are written", async () => {
    const inner = createInMemoryClipEditorDocumentStore([stored("clip-a"), stored("clip-b")]);
    const hand = { "12000": { id: "thumbs-up" } };
    let raced = false;
    const persistence = createClipEditorDocumentPersistence({
      authorize: async () => ({ pricingTier: "business" }),
      store: {
        ...inner,
        async commitProjectSelection(input) {
          if (!raced) {
            raced = true;
            const current = (await inner.read({ ...scope, clipId: "clip-b" }))!;
            await inner.commit({ scope: { ...scope, clipId: "clip-b" }, expectedRevision: current.revision, captureOriginal: null, retirePreview: false,
              retireEvidence: false, scores: current.scores, cleanupIntents: [],
              nextDocument: { ...current.document, studioEdits: { ...current.document.studioEdits, captionEmojis: hand } } });
          }
          return inner.commitProjectSelection(input);
        },
      },
    });
    const { suggest } = recording(async () => ({ emojis: yum, outcome: outcome(), complete: true }));

    const result = await applyCaptionPresetToProject({ ...scope, captionPreset: withEmojis }, { persistence, prepareSuggester: async () => suggest });

    expect(result).toEqual({ updated: 2, captionEmojis: { added: 1, failed: 0 } });
    expect(inner.inspect("clip-a")?.state.document.studioEdits.captionEmojis).toEqual(yum);
    expect(inner.inspect("clip-b")).toMatchObject({ state: { revision: 5, document: { captionPreset: withEmojis, studioEdits: { captionEmojis: hand } } } });
  });
});
