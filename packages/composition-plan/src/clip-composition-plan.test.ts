import { describe, expect, test } from "bun:test";
import {
  AUTO_CENSOR_POLICY_VERSION,
  autoCensorWordId,
  captionPresetSchema,
  clipAutoLayoutAnalysisSchema,
  editorDocumentSchema,
	MANUAL_BROLL_COMPOSITION_ID,
  MAX_DUCKING_WINDOWS,
  studioEditsSchema,
} from "@narriflow/validators";
import {
  automaticLayoutInputFingerprint,
  CLIP_COMPOSITION_MAX_SERIALIZED_BYTES,
  evaluateCompositionMotion,
  evaluateCompositionTransition,
  planClipComposition,
  resolveCompositionMotion,
  screenLayoutInputFingerprint,
  splitLayoutInputFingerprint,
} from "./clip-composition-plan";

function centerDocument() {
  return editorDocumentSchema.parse({
    version: 2,
    clipStartSec: 10,
    clipEndSec: 20,
    captionPreset: captionPresetSchema.parse({}),
    transcriptSlice: [],
    studioEdits: studioEditsSchema.parse({
      framing: { mode: "center" },
    }),
    brollUrl: null,
    deletedRanges: [{ startSec: 12, endSec: 14 }],
  });
}

function fitDocument() {
  return editorDocumentSchema.parse({
    version: 2,
    clipStartSec: 0,
    clipEndSec: 12,
    captionPreset: captionPresetSchema.parse({}),
    transcriptSlice: [],
    studioEdits: studioEditsSchema.parse({
      framing: { mode: "screen" },
      background: {
        mode: "image",
        color: "#123456",
        imageUrl: "https://example.com/background.jpg",
      },
    }),
    brollUrl: null,
    deletedRanges: [],
  });
}

describe("Clip Composition Plan", () => {
  test("plans one edited-time audio schedule for source, music, ducking, and sound effects", () => {
    const document = editorDocumentSchema.parse({
    version: 2,
      clipStartSec: 10,
      clipEndSec: 20,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [
        {
          index: 0,
          speaker: 0,
          speakerLabel: "Speaker 1",
          startSec: 10.5,
          endSec: 16,
          text: "One two three",
          confidence: 0.99,
          words: [
            { word: "One", startSec: 10.5, endSec: 11, confidence: 0.99 },
            { word: "two", startSec: 12.5, endSec: 13, confidence: 0.99 },
            { word: "three", startSec: 15, endSec: 16, confidence: 0.99 },
          ],
        },
      ],
      studioEdits: studioEditsSchema.parse({
        framing: { mode: "center" },
        sourceAudio: { volume: 65, muted: false },
        music: {
          url: "https://example.com/music.mp3",
          volume: 40,
          startOffsetSec: 3,
          fadeInSec: 5,
          fadeOutSec: 5,
          ducking: true,
        },
        sfx: [
          {
            id: "sting",
            assetId: "11111111-1111-4111-8111-111111111111",
            startSec: 3,
            volume: 80,
          },
        ],
      }),
      brollUrl: null,
      deletedRanges: [{ startSec: 12, endSec: 14 }],
    });
    const result = planClipComposition({
      document,
      source: {
        identity: "source:audio-schedule",
        kind: "video",
        width: 1920,
        height: 1080,
        hasAudio: true,
      },
      evidence: { automaticLayout: { state: "missing" } },
      assets: {
        backgroundImage: { state: "missing" },
        music: { state: "available", ref: "music:bed" },
        soundEffects: {
          sting: { state: "available", ref: "sfx:sting", durationSec: 0.75 },
        },
      },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
      targets: [
        { id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 },
      ],
    });

    expect(result.status).toBe("ready");
    if (result.status === "invalid") throw new Error(result.error.code);
    expect(result.plan.audioSchedule.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect({ ...result.plan.audioSchedule, fingerprint: undefined }).toEqual({
      fingerprint: undefined,
      outputFades: {
        fadeIn: { startSec: 0, endSec: 0.04 },
        fadeOut: { startSec: 7.88, endSec: 8 },
      },
      source: {
        sourceRef: "source:audio-schedule",
        available: true,
        activeRange: { startSec: 0, endSec: 8 },
        gain: 0.65,
        muted: false,
      },
      dialogueTreatments: [],
      music: {
        sourceRef: "music:bed",
        activeRange: { startSec: 0, endSec: 8 },
        gain: 0.4,
        startOffsetSec: 3,
        sourceDurationSec: null,
        loop: true,
        fades: {
          fadeIn: { startSec: 0, endSec: 4 },
          fadeOut: { startSec: 4, endSec: 8 },
        },
        ducking: {
          enabled: true,
          windows: [
            { startSec: 0.38, endSec: 1.12 },
            { startSec: 2.88, endSec: 4.12 },
          ],
          duckedGainFraction: 0.3,
          attackSec: 0.25,
          releaseSec: 0.4,
        },
      },
      soundEffects: [
        {
          id: "sting",
          sourceRef: "sfx:sting",
          activeRange: { startSec: 3, endSec: 3.75 },
          gain: 0.8,
        },
      ],
    });
  });

  test("plans caption masking through the shared cue model without rewriting transcript text", () => {
    const transcriptWord = {
      word: "damn!",
      startSec: 1,
      endSec: 1.5,
      confidence: 0.99,
    };
    const sourceWordId = autoCensorWordId({
      utteranceIndex: 0,
      wordIndex: 0,
      word: transcriptWord,
      locale: "en",
    });
    const document = editorDocumentSchema.parse({
      version: 2,
      clipStartSec: 0,
      clipEndSec: 3,
      captionPreset: captionPresetSchema.parse({ textTransform: "none" }),
      transcriptSlice: [{
        index: 0,
        speaker: 0,
        speakerLabel: "Speaker 1",
        startSec: 1,
        endSec: 1.5,
        text: "damn!",
        confidence: 0.99,
        words: [transcriptWord],
      }],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
      brollUrl: null,
      deletedRanges: [],
      censorSegments: [{
        schemaVersion: 1,
        id: "dbb670b3-e28a-4514-bf2d-63e56608a4d0",
        sourceWordIds: [sourceWordId],
        sourceStartSec: 1,
        sourceEndSec: 1.5,
        treatment: "caption_mask",
        paddingSec: 0.08,
        beepSettings: null,
        captionMaskPolicy: {
          replacement: "asterisks",
          preservePunctuation: true,
        },
        suggestionFingerprint: "a".repeat(32),
        policyVersion: AUTO_CENSOR_POLICY_VERSION,
        enabled: true,
      }],
    });

    const result = planClipComposition({
      document,
      source: {
        identity: "source:caption-mask",
        kind: "video",
        width: 1920,
        height: 1080,
        hasAudio: true,
      },
      evidence: { automaticLayout: { state: "missing" } },
      assets: { backgroundImage: { state: "missing" } },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
      targets: [
        { id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 },
      ],
    });

    if (result.status === "invalid") throw new Error(result.error.code);
    const caption = result.plan.targets[0]!.visualLayers.find(
      (layer) => layer.kind === "caption",
    );
    expect(caption?.kind === "caption" ? caption.words[0]?.text : null).toBe("****!");
    expect(document.transcriptSlice[0]?.words[0]?.word).toBe("damn!");
    expect(result.plan.audioSchedule.dialogueTreatments).toEqual([]);
  });

  test("surfaces a privacy-safe stale Censor Segment notice after transcript correction", () => {
    const originalWord = {
      word: "damn",
      startSec: 1,
      endSec: 1.4,
      confidence: 0.9,
    };
    const oldWordId = autoCensorWordId({
      utteranceIndex: 0,
      wordIndex: 0,
      word: originalWord,
    });
    const document = editorDocumentSchema.parse({
      version: 2,
      clipStartSec: 0,
      clipEndSec: 3,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [{
        index: 0,
        speaker: 0,
        speakerLabel: "Speaker 1",
        startSec: 1,
        endSec: 1.4,
        text: "fixed",
        confidence: 0.9,
        words: [{ ...originalWord, word: "fixed" }],
      }],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
      brollUrl: null,
      deletedRanges: [],
      censorSegments: [{
        schemaVersion: 1,
        id: "dbb670b3-e28a-4514-bf2d-63e56608a4d0",
        sourceWordIds: [oldWordId],
        sourceStartSec: 1,
        sourceEndSec: 1.4,
        treatment: "mute",
        paddingSec: 0.08,
        beepSettings: null,
        captionMaskPolicy: null,
        suggestionFingerprint: "a".repeat(32),
        policyVersion: AUTO_CENSOR_POLICY_VERSION,
        enabled: true,
      }],
    });
    const result = planClipComposition({
      document,
      source: {
        identity: "source:stale-censor",
        kind: "video",
        width: 1920,
        height: 1080,
        hasAudio: true,
      },
      evidence: { automaticLayout: { state: "missing" } },
      assets: { backgroundImage: { state: "missing" } },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
      targets: [{ id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 }],
    });
    if (result.status === "invalid") throw new Error(result.error.code);

    expect(result.plan.notices).toContainEqual(expect.objectContaining({
      code: "censor_segment_stale",
      fidelity: "degraded",
      userActionPossible: true,
    }));
    expect(JSON.stringify(result.plan.notices)).not.toContain("damn");
    expect(JSON.stringify(result.plan.notices)).not.toContain("fixed");
  });

  test("plans normalized beep and mute intervals on the shared edited audio schedule", () => {
    const makeSegment = (
      id: string,
      treatment: "beep" | "mute",
      startSec: number,
      endSec: number,
    ) => ({
      schemaVersion: 1 as const,
      id,
      sourceWordIds: [`word:${id}`],
      sourceStartSec: startSec,
      sourceEndSec: endSec,
      treatment,
      paddingSec: 0,
      beepSettings: treatment === "beep" ? { frequencyHz: 900, levelDb: -12 } : null,
      captionMaskPolicy: null,
      suggestionFingerprint: null,
      policyVersion: AUTO_CENSOR_POLICY_VERSION,
      enabled: true,
    });
    const document = editorDocumentSchema.parse({
      version: 2,
      clipStartSec: 10,
      clipEndSec: 14,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
      brollUrl: null,
      deletedRanges: [],
      sceneBlocks: [{
        schemaVersion: 1,
        id: "8ab9d330-688f-4574-932c-27ac661245c1",
        anchorSec: 2,
        durationSec: 1,
        content: { kind: "color", color: "#111827" },
        motion: { entrance: "none", exit: "none" },
        templateSnapshot: null,
      }],
      censorSegments: [
        makeSegment("dbb670b3-e28a-4514-bf2d-63e56608a4d0", "beep", 10.5, 12.5),
        makeSegment("2adf79cc-35b2-4de5-85dc-c9ed197763e4", "mute", 11.5, 13),
      ],
    });
    const result = planClipComposition({
      document,
      source: {
        identity: "source:censor-audio",
        kind: "video",
        width: 1920,
        height: 1080,
        hasAudio: true,
      },
      evidence: { automaticLayout: { state: "missing" } },
      assets: { backgroundImage: { state: "missing" } },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
      targets: [
        { id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 },
      ],
    });

    if (result.status === "invalid") throw new Error(result.error.code);
    expect(result.plan.editedDurationSec).toBe(5);
    expect(result.plan.audioSchedule.dialogueTreatments).toMatchObject([
      { kind: "beep", activeRange: { startSec: 0.5, endSec: 1.5 }, frequencyHz: 900 },
      { kind: "mute", activeRange: { startSec: 1.5, endSec: 2 } },
      { kind: "mute", activeRange: { startSec: 3, endSec: 4 } },
    ]);
  });

  test("scales boundary fades for sub-160ms clips so export filters never overlap", () => {
    const result = planClipComposition({
      document: editorDocumentSchema.parse({
    version: 2,
        clipStartSec: 0,
        clipEndSec: 0.1,
        captionPreset: captionPresetSchema.parse({}),
        transcriptSlice: [],
        studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
        brollUrl: null,
        deletedRanges: [],
      }),
      source: {
        identity: "source:short-audio-fades",
        kind: "video",
        width: 1920,
        height: 1080,
        hasAudio: true,
      },
      evidence: { automaticLayout: { state: "missing" } },
      assets: { backgroundImage: { state: "missing" } },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
      targets: [
        { id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 },
      ],
    });

    if (result.status === "invalid") throw new Error(result.error.code);
    const { fadeIn, fadeOut } = result.plan.audioSchedule.outputFades;
    expect(fadeIn.endSec).toBeCloseTo(fadeOut.startSec, 8);
    expect(fadeOut.endSec).toBeLessThan(0.16);
    expect(fadeIn.endSec - fadeIn.startSec).toBeGreaterThan(0);
    expect(fadeOut.endSec - fadeOut.startSec).toBeGreaterThan(0);
  });

  test("keeps the audio schedule fingerprint isolated from unrelated visual edits", () => {
    const audioEdits = {
      sourceAudio: { volume: 75, muted: false },
      music: {
        url: "https://example.com/bed.mp3",
        volume: 30,
        startOffsetSec: 2,
        fadeInSec: 1,
        fadeOutSec: 1,
      },
    };
    const makeDocument = (withVisualEdit: boolean) =>
      editorDocumentSchema.parse({
    version: 2,
        clipStartSec: 0,
        clipEndSec: 12,
        captionPreset: captionPresetSchema.parse(
          withVisualEdit ? { highlightColor: "#FFCC00" } : {},
        ),
        transcriptSlice: [],
        studioEdits: studioEditsSchema.parse({
          ...audioEdits,
          ...(withVisualEdit
            ? {
                textLayers: [
                  {
                    id: "visual-only",
                    text: "Visual edit",
                    startSec: 1,
                    endSec: 4,
                    positionX: 50,
                    positionY: 20,
                  },
                ],
              }
            : {}),
        }),
        brollUrl: withVisualEdit ? "https://example.com/broll.mp4" : null,
        deletedRanges: [],
      });
    const plan = (withVisualEdit: boolean) =>
      planClipComposition({
        document: makeDocument(withVisualEdit),
        source: {
          identity: "source:fingerprint-isolation",
          kind: "video",
          width: 1920,
          height: 1080,
          hasAudio: true,
        },
        evidence: { automaticLayout: { state: "missing" } },
        assets: {
          backgroundImage: { state: "missing" },
          music: { state: "available", ref: "music:stable" },
          ...(withVisualEdit
            ? {
                broll: {
                  state: "available" as const,
                  placements: [
                    {
                      id: "visual-only",
                      ref: "broll:visual-only",
										mediaKind: "video" as const,
                      startSec: 2,
                      endSec: 5,
										sourceStartSec: 0,
										sourceEndSec: 3,
                    },
                  ],
                },
              }
            : {}),
        },
        capabilities: {
          automaticSpeakerLayout: true,
          automaticSpeakerEngineVersion: "shot-layout-v1",
        },
        targets: [
          { id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 },
        ],
      });

    const before = plan(false);
    const after = plan(true);
    if (before.status === "invalid" || after.status === "invalid") {
      throw new Error("expected valid plans");
    }
    expect(after.plan.fingerprint).not.toBe(before.plan.fingerprint);
    expect(after.plan.audioSchedule).toEqual(before.plan.audioSchedule);
  });

  test("omits unavailable optional audio independently and scopes stable notices", () => {
    const document = editorDocumentSchema.parse({
    version: 2,
      clipStartSec: 0,
      clipEndSec: 10,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({
        framing: { mode: "center" },
        music: {
          assetId: "11111111-1111-4111-8111-111111111111",
          volume: 35,
        },
        sfx: [
          {
            id: "impact",
            assetId: "22222222-2222-4222-8222-222222222222",
            startSec: 4,
            volume: 90,
          },
        ],
      }),
      brollUrl: null,
      deletedRanges: [],
    });
    const result = planClipComposition({
      document,
      source: {
        identity: "source:optional-audio",
        kind: "video",
        width: 1920,
        height: 1080,
        hasAudio: false,
      },
      evidence: { automaticLayout: { state: "missing" } },
      assets: {
        backgroundImage: { state: "missing" },
        music: { state: "failed" },
        soundEffects: { impact: { state: "pending" } },
      },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
      targets: [
        { id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 },
        { id: "square", aspectRatio: "1:1", width: 1080, height: 1080 },
      ],
    });

    expect(result.status).toBe("pending");
    if (result.status === "invalid") throw new Error(result.error.code);
    expect(result.plan.audioSchedule).toMatchObject({
      source: { available: false, muted: false },
      music: null,
      soundEffects: [],
    });
    expect(result.plan.notices).toEqual([
      ...["vertical", "square"].map((targetId) => ({
        code: "music_asset_unavailable",
        fidelity: "degraded" as const,
        targetId,
        sceneId: null,
        effectiveFallback: "center" as const,
        userActionPossible: true,
      })),
      ...["vertical", "square"].map((targetId) => ({
        code: "sound_effect_asset_pending",
        fidelity: "pending" as const,
        targetId,
        sceneId: null,
        effectiveFallback: "center" as const,
        userActionPossible: false,
        assetId: "impact",
      })),
    ]);
  });

  test("degrades an available SFX fact whose duration cannot own a stop time", () => {
    const document = editorDocumentSchema.parse({
    version: 2,
      clipStartSec: 0,
      clipEndSec: 5,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({
        framing: { mode: "center" },
        sfx: [
          {
            id: "invalid-duration",
            assetId: "22222222-2222-4222-8222-222222222222",
            startSec: 1,
            volume: 90,
          },
        ],
      }),
      brollUrl: null,
      deletedRanges: [],
    });
    const result = planClipComposition({
      document,
      source: {
        identity: "source:invalid-sfx-duration",
        kind: "video",
        width: 1920,
        height: 1080,
      },
      evidence: { automaticLayout: { state: "missing" } },
      assets: {
        backgroundImage: { state: "missing" },
        soundEffects: {
          "invalid-duration": {
            state: "available",
            ref: "sfx:invalid-duration",
            durationSec: Number.NaN,
          },
        },
      },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
      targets: [
        { id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 },
      ],
    });

    expect(result.status).toBe("ready");
    if (result.status === "invalid") throw new Error(result.error.code);
    expect(result.plan.fidelity).toBe("degraded");
    expect(result.plan.audioSchedule.soundEffects).toEqual([]);
    expect(result.plan.notices).toContainEqual({
      code: "sound_effect_asset_unavailable",
      fidelity: "degraded",
      targetId: "vertical",
      sceneId: null,
      effectiveFallback: "center",
      userActionPossible: true,
      assetId: "invalid-duration",
    });
  });

  test("keeps every planned audio range finite, ordered, clipped, capped, and deterministic", () => {
    const words = Array.from({ length: MAX_DUCKING_WINDOWS * 3 }, (_, index) => ({
      word: `w${index}`,
      startSec: index * 1.5,
      endSec: index * 1.5 + 0.2,
      confidence: 0.99,
    }));
    const duration = words.at(-1)!.endSec + 1;
    const document = editorDocumentSchema.parse({
    version: 2,
      clipStartSec: 0,
      clipEndSec: duration,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [
        {
          index: 0,
          speaker: 0,
          speakerLabel: "Speaker 1",
          startSec: 0,
          endSec: duration,
          text: words.map((word) => word.word).join(" "),
          confidence: 0.99,
          words,
        },
      ],
      studioEdits: studioEditsSchema.parse({
        music: {
          url: "https://example.com/music.mp3",
          volume: 100,
          fadeInSec: 5,
          fadeOutSec: 5,
          ducking: true,
        },
        sfx: Array.from({ length: 20 }, (_, index) => ({
          id: `sfx-${index}`,
          assetId: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
          startSec: Math.min(duration, index * 3),
          volume: index % 2 === 0 ? 0 : 100,
        })),
      }),
      brollUrl: null,
      deletedRanges: [],
    });
    const assets = {
      backgroundImage: { state: "missing" as const },
      music: { state: "available" as const, ref: "music:bounded" },
      soundEffects: Object.fromEntries(
        document.studioEdits.sfx.map((placement) => [
          placement.id,
          {
            state: "available" as const,
            ref: `sfx:${placement.id}`,
            durationSec: 0.5,
          },
        ]),
      ),
    };
    const input = {
      document,
      source: {
        identity: "source:bounded-audio",
        kind: "video" as const,
        width: 1920,
        height: 1080,
        hasAudio: true,
      },
      evidence: { automaticLayout: { state: "missing" as const } },
      assets,
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
      targets: [
        { id: "vertical", aspectRatio: "9:16" as const, width: 1080, height: 1920 },
      ],
    };
    const first = planClipComposition(input);
    const second = planClipComposition(input);
    if (first.status === "invalid" || second.status === "invalid") {
      throw new Error("expected valid bounded audio plans");
    }
    const schedule = first.plan.audioSchedule;
    expect(schedule).toEqual(second.plan.audioSchedule);
    expect(schedule.soundEffects).toHaveLength(20);
    expect(schedule.music!.ducking.windows.length).toBeLessThanOrEqual(
      MAX_DUCKING_WINDOWS,
    );
    const ranges = [
      schedule.source.activeRange,
      schedule.music!.activeRange,
      schedule.music!.fades.fadeIn,
      schedule.music!.fades.fadeOut,
      ...schedule.music!.ducking.windows,
      ...schedule.soundEffects.map((effect) => effect.activeRange),
    ];
    for (const range of ranges) {
      expect(Number.isFinite(range.startSec)).toBe(true);
      expect(Number.isFinite(range.endSec)).toBe(true);
      expect(range.startSec).toBeGreaterThanOrEqual(0);
      expect(range.endSec).toBeGreaterThanOrEqual(range.startSec);
      expect(range.endSec).toBeLessThanOrEqual(schedule.source.activeRange.endSec);
    }
  });

  test("plans audio-only input as the existing audiogram and makes unsupported backgrounds explicit", () => {
    const document = editorDocumentSchema.parse({
    version: 2,
      clipStartSec: 0,
      clipEndSec: 12,
      captionPreset: captionPresetSchema.parse({ highlightColor: "#00FF88" }),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({
        background: {
          mode: "image",
          color: "#123456",
          imageUrl: "https://example.com/background.jpg",
        },
      }),
      brollUrl: null,
      deletedRanges: [],
    });
    const result = planClipComposition({
      document,
      source: {
        identity: "source:podcast",
        kind: "audio",
        width: 0,
        height: 0,
        hasAudio: true,
      },
      evidence: { automaticLayout: { state: "missing" } },
      assets: { backgroundImage: { state: "available", ref: "background:one" } },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
      targets: [
        { id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 },
      ],
    });

    expect(result.status).toBe("ready");
    if (result.status === "invalid") throw new Error(result.error.code);
    expect(result.plan.evidenceRequests).toEqual([]);
    expect(result.plan.targets[0]).toMatchObject({
      requestedMode: "fit",
      effectiveMode: "audiogram",
      scenes: [
        {
          startSec: 0,
          endSec: 12,
          layers: [
            {
              kind: "audiogram",
              sourceRef: "source:podcast",
              backgroundColor: "#0F172A",
              waveformColor: "#00FF88",
              waveformHeightRatio: 0.42,
              destination: { x: 0, y: 0, width: 1080, height: 1920 },
            },
          ],
        },
      ],
    });
    expect(result.plan.notices).toEqual([
      {
        code: "audio_only_background_unsupported",
        fidelity: "degraded",
        targetId: "vertical",
        sceneId: null,
        effectiveFallback: "audiogram",
        userActionPossible: true,
      },
    ]);
  });

  test("classifies exact, pending, degraded, and invalid composition fidelity", () => {
    const base = {
      document: centerDocument(),
      source: {
        identity: "source:fidelity",
        kind: "video" as const,
        width: 1920,
        height: 1080,
      },
      assets: { backgroundImage: { state: "missing" as const } },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
      targets: [
        { id: "vertical", aspectRatio: "9:16" as const, width: 1080, height: 1920 },
      ],
    };
    const exact = planClipComposition({
      ...base,
      evidence: { automaticLayout: { state: "missing" as const } },
    });
    const autoDocument = editorDocumentSchema.parse({
    version: 2,
      ...centerDocument(),
      studioEdits: studioEditsSchema.parse({ framing: { mode: "auto" } }),
    });
    const pending = planClipComposition({
      ...base,
      document: autoDocument,
      evidence: { automaticLayout: { state: "missing" as const } },
    });
    const degraded = planClipComposition({
      ...base,
      document: autoDocument,
      evidence: { automaticLayout: { state: "failed" as const } },
    });
    const invalid = planClipComposition({
      ...base,
      targets: [],
      evidence: { automaticLayout: { state: "missing" as const } },
    });

    expect(exact.status === "invalid" ? null : exact.plan.fidelity).toBe("exact");
    expect(pending.status === "invalid" ? null : pending.plan.fidelity).toBe(
      "pending",
    );
    expect(degraded.status === "invalid" ? null : degraded.plan.fidelity).toBe(
      "degraded",
    );
    expect(invalid).toEqual({ status: "invalid", error: { code: "invalid_target" } });
  });

  test("plans Center once for mixed targets with exact bounded geometry", () => {
    const input = {
      document: centerDocument(),
      source: {
        identity: "source:project-1",
        kind: "video" as const,
        width: 1920,
        height: 1080,
      },
      evidence: { automaticLayout: { state: "missing" as const } },
      assets: { backgroundImage: { state: "missing" as const } },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
      targets: [
        { id: "vertical", aspectRatio: "9:16" as const, width: 1080, height: 1920 },
        { id: "landscape", aspectRatio: "16:9" as const, width: 1920, height: 1080 },
      ],
    };

    const first = planClipComposition(input);
    const second = planClipComposition(input);

    expect(first.status).toBe("ready");
    if (first.status === "invalid" || second.status === "invalid") {
      throw new Error("expected a valid Center plan");
    }
    expect(first.plan.version).toBe(1);
    expect(first.plan.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(second.plan.fingerprint).toBe(first.plan.fingerprint);
    expect(first.plan.editedDurationSec).toBe(8);
    expect(first.plan.source).toEqual({
      ref: "source:project-1",
      width: 1920,
      height: 1080,
    });
    expect(first.plan.evidenceRequests).toEqual([]);
    expect(first.plan.notices).toEqual([]);
    expect(first.plan.targets).toEqual([
      {
        id: "vertical",
        aspectRatio: "9:16",
        requestedMode: "center",
        effectiveMode: "center",
        canvas: { width: 1080, height: 1920, divisibleBy: 2 },
        visualLayers: [],
        scenes: [
          {
            id: "scene:center:vertical:0",
            startSec: 0,
            endSec: 8,
            layers: [
              {
                id: "layer:source:vertical:0",
                kind: "source-video",
                sourceRef: "source:project-1",
                sourceCrop: { x: 656, y: 0, width: 608, height: 1080 },
                destination: { x: 0, y: 0, width: 1080, height: 1920 },
                fit: "cover",
                rotationDeg: 0,
                opacity: 1,
                zIndex: 0,
              },
            ],
          },
        ],
      },
      {
        id: "landscape",
        aspectRatio: "16:9",
        requestedMode: "center",
        effectiveMode: "center",
        canvas: { width: 1920, height: 1080, divisibleBy: 2 },
        visualLayers: [],
        scenes: [
          {
            id: "scene:center:landscape:0",
            startSec: 0,
            endSec: 8,
            layers: [
              {
                id: "layer:source:landscape:0",
                kind: "source-video",
                sourceRef: "source:project-1",
                sourceCrop: { x: 0, y: 0, width: 1920, height: 1080 },
                destination: { x: 0, y: 0, width: 1920, height: 1080 },
                fit: "cover",
                rotationDeg: 0,
                opacity: 1,
                zIndex: 0,
              },
            ],
          },
        ],
      },
    ]);
    expect(Object.isFrozen(first.plan)).toBe(true);
    expect(Object.isFrozen(first.plan.targets[0]?.scenes[0]?.layers[0])).toBe(true);
    expect(JSON.stringify(first.plan).length).toBeLessThan(16_000);
  });

  test("splices inserted scenes into one contiguous preview and render timeline", () => {
    const document = editorDocumentSchema.parse({
    version: 2,
      ...centerDocument(),
      sceneBlocks: [
        { id: "8ab9d330-688f-4574-932c-27ac661245c1", schemaVersion: 1, anchorSec: 0, durationSec: 2, content: { kind: "text", text: "Opening", fontFamily: "Arial", fontAsset: null, color: "#FFFFFF", backgroundColor: "#111827" }, motion: { entrance: "fade", exit: "fade" }, templateSnapshot: null },
        { id: "d8ab95f8-fc16-4e60-814e-69762a59a99b", schemaVersion: 1, anchorSec: 6, durationSec: 1, content: { kind: "color", color: "#1D4ED8" }, motion: { entrance: "none", exit: "none" }, templateSnapshot: null },
      ],
    });
    const result = planClipComposition({
      document,
      source: { identity: "source:scenes", kind: "video", width: 1920, height: 1080 },
      evidence: { automaticLayout: { state: "missing" } },
      assets: { backgroundImage: { state: "missing" } },
      capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: "shot-layout-v1" },
      targets: [{ id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 }],
    });
    expect(result.status).toBe("ready");
    if (result.status === "invalid") throw new Error("expected scene plan");
    expect(result.plan.editedDurationSec).toBe(11);
    const scenes = result.plan.targets[0]!.scenes;
    expect(scenes.map((scene) => [scene.startSec, scene.endSec])).toEqual([
      [0, 2], [2, 6], [6, 7], [7, 11],
    ]);
    expect(scenes.filter((scene) => scene.layers[0]?.kind === "inserted-scene")).toHaveLength(2);
  });

  test("reports frozen Scene media and Brand fonts that cannot be resolved", () => {
    const imageSceneId = "55ac909b-05d4-4da5-8e93-1656c6fbf03f";
    const textSceneId = "3db8cd27-ab96-4dd8-a0c9-46228962fc4f";
    const document = editorDocumentSchema.parse({
      ...centerDocument(),
      sceneBlocks: [
        {
          id: imageSceneId,
          schemaVersion: 1,
          anchorSec: 0,
          durationSec: 1,
          content: {
            kind: "image",
            asset: {
              kind: "visual_asset",
              id: "8e1c60dd-7355-4d20-a807-2ec78106b30e",
              fingerprint: "a".repeat(64),
            },
            fit: "cover",
            backgroundColor: "#000000",
          },
          motion: { entrance: "none", exit: "none" },
          templateSnapshot: null,
        },
        {
          id: textSceneId,
          schemaVersion: 1,
          anchorSec: 2,
          durationSec: 1,
          content: {
            kind: "text",
            text: "Brand opener",
            fontFamily: "Brand Display",
            fontAsset: {
              kind: "brand_font",
              id: "578a2ead-ee6a-4b73-a11e-e7f42d7f0a9a",
              fingerprint: "b".repeat(64),
            },
            color: "#FFFFFF",
            backgroundColor: "#111827",
          },
          motion: { entrance: "fade", exit: "fade" },
          templateSnapshot: null,
        },
      ],
    });
    const result = planClipComposition({
      document,
      source: { identity: "source:missing-scenes", kind: "video", width: 1920, height: 1080 },
      evidence: { automaticLayout: { state: "missing" } },
      assets: {
        backgroundImage: { state: "missing" },
        sceneVisuals: { [imageSceneId]: { state: "failed" } },
        sceneFonts: { [textSceneId]: { state: "pending" } },
      },
      capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: "shot-layout-v1" },
      targets: [{ id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 }],
    });
    expect(result.status).toBe("pending");
    if (result.status === "invalid") throw new Error(result.error.code);
    expect(result.plan.notices).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "scene_asset_unavailable", sceneId: imageSceneId }),
      expect.objectContaining({ code: "scene_font_pending", sceneId: textSceneId }),
    ]));
  });

  test("plans Fit precedence and degrades an unavailable image to the selected color", () => {
    const base = {
      document: fitDocument(),
      source: {
        identity: "source:landscape",
        kind: "video" as const,
        width: 1920,
        height: 1080,
      },
      evidence: { automaticLayout: { state: "missing" as const } },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
      targets: [
        { id: "vertical", aspectRatio: "9:16" as const, width: 1080, height: 1920 },
      ],
    };
    const available = planClipComposition({
      ...base,
      assets: {
        backgroundImage: { state: "available" as const, ref: "asset:bg-1" },
      },
    });
    const failed = planClipComposition({
      ...base,
      assets: { backgroundImage: { state: "failed" as const } },
    });

    expect(available.status).toBe("ready");
    expect(failed.status).toBe("ready");
    if (available.status === "invalid" || failed.status === "invalid") {
      throw new Error("expected valid Fit plans");
    }
    expect(available.plan.evidenceRequests).toEqual([]);
    expect(available.plan.targets[0]).toMatchObject({
      requestedMode: "fit",
      effectiveMode: "fit",
      scenes: [
        {
          startSec: 0,
          endSec: 12,
          layers: [
            {
              id: "layer:background:vertical:0",
              kind: "background",
              color: "#123456",
              imageRef: "asset:bg-1",
              destination: { x: 0, y: 0, width: 1080, height: 1920 },
              zIndex: 0,
            },
            {
              id: "layer:source:vertical:0",
              kind: "source-video",
              sourceCrop: { x: 0, y: 0, width: 1920, height: 1080 },
              destination: { x: 0, y: 656, width: 1080, height: 608 },
              fit: "contain",
              zIndex: 1,
            },
          ],
        },
      ],
    });
    expect(failed.plan.targets[0]?.scenes[0]?.layers[0]).toMatchObject({
      kind: "background",
      color: "#123456",
      imageRef: null,
    });
    expect(failed.plan.notices).toEqual([
      {
        code: "background_image_unavailable",
        fidelity: "degraded",
        targetId: "vertical",
        sceneId: null,
        effectiveFallback: "fit",
        userActionPossible: true,
      },
    ]);
  });

  test("requests missing Auto evidence once and plans target-specific speaker scenes when it arrives", () => {
    const document = editorDocumentSchema.parse({
    version: 2,
      clipStartSec: 10,
      clipEndSec: 20,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "auto" } }),
      brollUrl: null,
      deletedRanges: [],
    });
    const source = {
      identity: "source:auto-1",
      kind: "video" as const,
      width: 1920,
      height: 1080,
    };
    const capabilities = {
      automaticSpeakerLayout: true,
      automaticSpeakerEngineVersion: "shot-layout-v1",
    };
    const targets = [
      { id: "vertical", aspectRatio: "9:16" as const, width: 1080, height: 1920 },
      { id: "square", aspectRatio: "1:1" as const, width: 1080, height: 1080 },
    ];
    const missing = planClipComposition({
      document,
      source,
      evidence: { automaticLayout: { state: "missing" } },
      assets: { backgroundImage: { state: "missing" } },
      capabilities,
      targets,
    });
    const fingerprint = automaticLayoutInputFingerprint({
      sourceIdentity: source.identity,
      clipStartSec: 10,
      clipEndSec: 20,
      deletedRanges: [],
      engineVersion: "shot-layout-v1",
    });
    const analysis = clipAutoLayoutAnalysisSchema.parse({
      version: 1,
      engine: "shot-layout-v1",
      sourceIdentity: source.identity,
      analyzedAtISO: "2026-08-26T00:00:00.000Z",
      clipStartSec: 10,
      clipEndSec: 20,
      deletedRanges: [],
      editedDurationSec: 10,
      // Evidence may be measured on a same-source preview proxy. Speaker
      // coordinates are normalized, so the planner scales them to the
      // authoritative source facts instead of rejecting proxy dimensions.
      sourceWidth: 960,
      sourceHeight: 540,
      segments: [
        {
          startSec: 0,
          endSec: 10,
          layout: "two-up",
          topCxNorm: 0.25,
          bottomCxNorm: 0.75,
        },
      ],
      noSplitSegments: [
        {
          startSec: 0,
          endSec: 10,
          layout: "single",
          cxNorm: 0.5,
        },
      ],
      shotCount: 1,
      soloShotCount: 0,
      multiShotCount: 1,
      twoUpSegmentCount: 1,
      speakerCount: 2,
      mappedSpeakerCount: 2,
    });
    const ready = planClipComposition({
      document,
      source,
      evidence: {
        automaticLayout: {
          state: "available",
          value: {
            sourceIdentity: source.identity,
            inputFingerprint: fingerprint,
            engineVersion: "shot-layout-v1",
            analysis,
          },
        },
      },
      assets: { backgroundImage: { state: "missing" } },
      capabilities,
      targets,
    });

    expect(missing.status).toBe("pending");
    if (missing.status === "invalid" || ready.status === "invalid") {
      throw new Error("expected valid Auto plans");
    }
    expect(missing.plan.evidenceRequests).toEqual([
      {
        key: `automatic-speaker-layout:${fingerprint}`,
        kind: "automatic-speaker-layout",
        engineVersion: "shot-layout-v1",
      },
    ]);
    expect(missing.plan.targets.map((target) => target.effectiveMode)).toEqual([
      "center",
      "center",
    ]);
    expect(ready.status).toBe("ready");
    expect(ready.plan.evidenceRequests).toEqual([]);
    expect(ready.plan.targets[0]).toMatchObject({
      effectiveMode: "auto",
      scenes: [
        {
          startSec: 0,
          endSec: 10,
          layers: [
            {
              speaker: { role: "top" },
              destination: { x: 0, y: 0, width: 1080, height: 960 },
              sourceCrop: { x: 0, y: 0, width: 1215, height: 1080 },
            },
            {
              speaker: { role: "bottom" },
              destination: { x: 0, y: 960, width: 1080, height: 960 },
              sourceCrop: { x: 705, y: 0, width: 1215, height: 1080 },
            },
          ],
        },
      ],
    });
    expect(ready.plan.targets[1]).toMatchObject({
      effectiveMode: "auto",
      scenes: [
        {
          layers: [
            {
              speaker: { role: "single" },
              destination: { x: 0, y: 0, width: 1080, height: 1080 },
              sourceCrop: { x: 420, y: 0, width: 1080, height: 1080 },
            },
          ],
        },
      ],
    });
  });

  test("invalidates Auto evidence when its source identity or relevant window fingerprint is stale", () => {
    const document = editorDocumentSchema.parse({
    version: 2,
      clipStartSec: 0,
      clipEndSec: 5,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "auto" } }),
      brollUrl: null,
      deletedRanges: [],
    });
    const analysis = clipAutoLayoutAnalysisSchema.parse({
      version: 1,
      engine: "shot-layout-v1",
      sourceIdentity: "source:old",
      analyzedAtISO: "2026-08-26T00:00:00.000Z",
      clipStartSec: 0,
      clipEndSec: 5,
      deletedRanges: [],
      editedDurationSec: 5,
      sourceWidth: 1920,
      sourceHeight: 1080,
      segments: [{ startSec: 0, endSec: 5, layout: "single", cxNorm: 0.5 }],
      noSplitSegments: [{ startSec: 0, endSec: 5, layout: "single", cxNorm: 0.5 }],
      shotCount: 1,
      soloShotCount: 1,
      multiShotCount: 0,
      twoUpSegmentCount: 0,
      speakerCount: 1,
      mappedSpeakerCount: 1,
    });
    const result = planClipComposition({
      document,
      source: { identity: "source:new", kind: "video", width: 1920, height: 1080 },
      evidence: {
        automaticLayout: {
          state: "available",
          value: {
            sourceIdentity: "source:old",
            inputFingerprint: "stale",
            engineVersion: "shot-layout-v1",
            analysis,
          },
        },
      },
      assets: { backgroundImage: { state: "missing" } },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
      targets: [{ id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 }],
    });

    expect(result.status).toBe("pending");
    if (result.status === "invalid") throw new Error(result.error.code);
    expect(result.plan.targets[0]?.effectiveMode).toBe("center");
    expect(result.plan.evidenceRequests).toHaveLength(1);

    const source = {
      identity: "source:new",
      kind: "video" as const,
      width: 1920,
      height: 1080,
    };
    const common = {
      document,
      source,
      assets: { backgroundImage: { state: "missing" as const } },
      targets: [
        {
          id: "vertical",
          aspectRatio: "9:16" as const,
          width: 1080,
          height: 1920,
        },
      ],
    };
    const failed = planClipComposition({
      ...common,
      evidence: { automaticLayout: { state: "failed" } },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
    });
    const disabled = planClipComposition({
      ...common,
      evidence: { automaticLayout: { state: "disabled" } },
      capabilities: {
        automaticSpeakerLayout: false,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
    });
    const versionMismatch = planClipComposition({
      ...common,
      evidence: {
        automaticLayout: {
          state: "available",
          value: {
            sourceIdentity: source.identity,
            inputFingerprint: automaticLayoutInputFingerprint({
              sourceIdentity: source.identity,
              clipStartSec: 0,
              clipEndSec: 5,
              deletedRanges: [],
              engineVersion: "shot-layout-v1",
            }),
            engineVersion: "shot-layout-v1",
            analysis: { ...analysis, version: 2 } as never,
          },
        },
      },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
    });
    expect(failed).toMatchObject({
      status: "ready",
      plan: {
        evidenceRequests: [],
        notices: [{ code: "automatic_layout_unavailable", fidelity: "degraded" }],
      },
    });
    expect(disabled).toMatchObject({
      status: "ready",
      plan: {
        evidenceRequests: [],
        notices: [{ code: "automatic_layout_disabled", fidelity: "degraded" }],
      },
    });
    expect(versionMismatch).toMatchObject({
      status: "pending",
      plan: {
        evidenceRequests: [{ kind: "automatic-speaker-layout" }],
        notices: [{ code: "automatic_layout_analyzing", fidelity: "pending" }],
      },
    });
  });

  test("applies aspect-specific manual overrides after analysis without freezing caller state", () => {
    const document = editorDocumentSchema.parse({
    version: 2,
      clipStartSec: 0,
      clipEndSec: 5,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({
        framing: { mode: "auto" },
        speakerLayoutOverrides: [
          {
            id: "manual-scene",
            aspectRatio: "9:16",
            startSec: 0,
            endSec: 5,
            layout: "two-up",
            layers: [
              {
                role: "top",
                frameX: 0.1,
                frameY: 0,
                frameWidth: 0.8,
                frameHeight: 0.5,
                rotationDeg: 0,
                cropCxNorm: 0.25,
                cropCyNorm: 0.5,
                cropZoom: 2,
              },
              {
                role: "bottom",
                frameX: 0,
                frameY: 0.5,
                frameWidth: 1,
                frameHeight: 0.5,
                rotationDeg: 0,
                cropCxNorm: 0.75,
                cropCyNorm: 0.5,
                cropZoom: 1,
              },
            ],
          },
        ],
      }),
      brollUrl: null,
      deletedRanges: [],
    });
    const source = {
      identity: "source:override",
      kind: "video" as const,
      width: 1920,
      height: 1080,
    };
    const analysis = clipAutoLayoutAnalysisSchema.parse({
      version: 1,
      engine: "shot-layout-v1",
      sourceIdentity: source.identity,
      analyzedAtISO: "2026-08-26T00:00:00.000Z",
      clipStartSec: 0,
      clipEndSec: 5,
      deletedRanges: [],
      editedDurationSec: 5,
      sourceWidth: 1920,
      sourceHeight: 1080,
      segments: [
        { startSec: 0, endSec: 5, layout: "two-up", topCxNorm: 0.25, bottomCxNorm: 0.75 },
      ],
      noSplitSegments: [
        { startSec: 0, endSec: 5, layout: "single", cxNorm: 0.5 },
      ],
      shotCount: 1,
      soloShotCount: 0,
      multiShotCount: 1,
      twoUpSegmentCount: 1,
      speakerCount: 2,
      mappedSpeakerCount: 2,
    });
    const inputFingerprint = automaticLayoutInputFingerprint({
      sourceIdentity: source.identity,
      clipStartSec: 0,
      clipEndSec: 5,
      deletedRanges: [],
      engineVersion: "shot-layout-v1",
    });
    const result = planClipComposition({
      document,
      source,
      evidence: {
        automaticLayout: {
          state: "available",
          value: {
            sourceIdentity: source.identity,
            inputFingerprint,
            engineVersion: "shot-layout-v1",
            analysis,
          },
        },
      },
      assets: { backgroundImage: { state: "missing" } },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
      targets: [{ id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 }],
    });

    expect(result.status).toBe("ready");
    if (result.status === "invalid") throw new Error(result.error.code);
    expect(result.plan.targets[0]?.scenes[0]?.layers[0]).toMatchObject({
      destination: { x: 108, y: 0, width: 864, height: 960 },
      speaker: {
        overrideId: "manual-scene",
        transform: { frameX: 0.1, frameWidth: 0.8, cropZoom: 2 },
        defaultTransform: { frameX: 0, frameWidth: 1, cropZoom: 1 },
      },
    });
    expect(Object.isFrozen(document.studioEdits.speakerLayoutOverrides[0])).toBe(false);
    expect(Object.isFrozen(document.studioEdits.speakerLayoutOverrides[0]?.layers[0])).toBe(false);
  });

  test("rejects empty, duplicate, odd, or excessive target sets", () => {
    const base = {
      document: centerDocument(),
      source: { identity: "source", kind: "video" as const, width: 1920, height: 1080 },
      evidence: { automaticLayout: { state: "missing" as const } },
      assets: { backgroundImage: { state: "missing" as const } },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
    };
    const target = { id: "one", aspectRatio: "9:16" as const, width: 1080, height: 1920 };
    expect(planClipComposition({ ...base, targets: [] })).toMatchObject({ status: "invalid", error: { code: "invalid_target" } });
    expect(planClipComposition({ ...base, targets: [target, target] })).toMatchObject({ status: "invalid", error: { code: "invalid_target" } });
    expect(planClipComposition({ ...base, targets: [{ ...target, height: 1919 }] })).toMatchObject({ status: "invalid", error: { code: "invalid_target" } });
    expect(planClipComposition({ ...base, targets: Array.from({ length: 5 }, (_, index) => ({ ...target, id: `${index}` })) })).toMatchObject({ status: "invalid", error: { code: "too_many_targets" } });
  });

  test("keeps every Center target contiguous, complete, finite, bounded, and divisible", () => {
    const targets = [
      { id: "vertical", aspectRatio: "9:16" as const, width: 1080, height: 1920 },
      { id: "square", aspectRatio: "1:1" as const, width: 1080, height: 1080 },
      { id: "landscape", aspectRatio: "16:9" as const, width: 1920, height: 1080 },
      { id: "portrait", aspectRatio: "4:5" as const, width: 1080, height: 1350 },
    ];
    const documents = [
      centerDocument(),
      editorDocumentSchema.parse({ ...centerDocument(), deletedRanges: [] }),
    ];
    for (const [source, document] of [
      [
        { identity: "landscape", kind: "video" as const, width: 1920, height: 1080 },
        documents[0]!,
      ],
      [
        { identity: "portrait", kind: "video" as const, width: 1080, height: 1920 },
        documents[1]!,
      ],
    ] as const) {
      const result = planClipComposition({
        document,
        source,
        evidence: { automaticLayout: { state: "missing" } },
        assets: { backgroundImage: { state: "missing" } },
        capabilities: {
          automaticSpeakerLayout: true,
          automaticSpeakerEngineVersion: "shot-layout-v1",
        },
        targets,
      });
      expect(result.status).toBe("ready");
      if (result.status === "invalid") throw new Error(result.error.code);
      for (const target of result.plan.targets) {
        expect(target.canvas.width % target.canvas.divisibleBy).toBe(0);
        expect(target.canvas.height % target.canvas.divisibleBy).toBe(0);
        expect(target.scenes).toHaveLength(1);
        expect(target.scenes[0]?.startSec).toBe(0);
        expect(target.scenes[0]?.endSec).toBe(result.plan.editedDurationSec);
        for (const layer of target.scenes[0]!.layers) {
          expect(Object.values(layer.destination).every(Number.isFinite)).toBe(true);
          expect(layer.destination.x + layer.destination.width).toBeLessThanOrEqual(target.canvas.width);
          expect(layer.destination.y + layer.destination.height).toBeLessThanOrEqual(target.canvas.height);
          if (layer.kind === "source-video") {
            expect(layer.sourceCrop.x + layer.sourceCrop.width).toBeLessThanOrEqual(source.width);
            expect(layer.sourceCrop.y + layer.sourceCrop.height).toBeLessThanOrEqual(source.height);
          }
        }
      }
    }
  });

  test("plans bounded Fit layers for every target and source orientation", () => {
    const targets = [
      { id: "vertical", aspectRatio: "9:16" as const, width: 1080, height: 1920 },
      { id: "square", aspectRatio: "1:1" as const, width: 1080, height: 1080 },
      { id: "landscape", aspectRatio: "16:9" as const, width: 1920, height: 1080 },
      { id: "portrait", aspectRatio: "4:5" as const, width: 1080, height: 1350 },
    ];
    for (const source of [
      { identity: "fit:landscape", kind: "video" as const, width: 1920, height: 1080 },
      { identity: "fit:portrait", kind: "video" as const, width: 1080, height: 1920 },
    ]) {
      const result = planClipComposition({
        document: fitDocument(),
        source,
        evidence: { automaticLayout: { state: "missing" } },
        assets: { backgroundImage: { state: "failed" } },
        capabilities: {
          automaticSpeakerLayout: true,
          automaticSpeakerEngineVersion: "shot-layout-v1",
        },
        targets,
      });
      expect(result.status).toBe("ready");
      if (result.status === "invalid") throw new Error(result.error.code);
      for (const target of result.plan.targets) {
        const layers = target.scenes[0]!.layers;
        expect(layers.map((layer) => layer.kind)).toEqual([
          "background",
          "source-video",
        ]);
        const sourceLayer = layers[1]!;
        expect(sourceLayer.destination.x + sourceLayer.destination.width).toBeLessThanOrEqual(
          target.canvas.width,
        );
        expect(sourceLayer.destination.y + sourceLayer.destination.height).toBeLessThanOrEqual(
          target.canvas.height,
        );
      }
    }
  });

  test("deduplicates missing Auto evidence across targets and unrelated edits", () => {
    const document = editorDocumentSchema.parse({
    version: 2,
      ...centerDocument(),
      studioEdits: studioEditsSchema.parse({ framing: { mode: "auto" } }),
    });
    const input = {
      document,
      source: { identity: "source:stable", kind: "video" as const, width: 1920, height: 1080 },
      evidence: { automaticLayout: { state: "missing" as const } },
      assets: { backgroundImage: { state: "missing" as const } },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
      targets: [
        { id: "vertical", aspectRatio: "9:16" as const, width: 1080, height: 1920 },
        { id: "square", aspectRatio: "1:1" as const, width: 1080, height: 1080 },
      ],
    };
    const first = planClipComposition(input);
    const unrelated = planClipComposition({
      ...input,
      document: editorDocumentSchema.parse({
    version: 2,
        ...document,
        studioEdits: {
          ...document.studioEdits,
          sourceAudio: { muted: true, volume: 37 },
        },
      }),
    });
    if (first.status === "invalid" || unrelated.status === "invalid") {
      throw new Error("expected provisional Auto plans");
    }
    expect(first.plan.evidenceRequests).toHaveLength(1);
    expect(unrelated.plan.evidenceRequests).toEqual(first.plan.evidenceRequests);
  });

  test("keeps evidence fingerprints stable across caller property order", () => {
    const first = automaticLayoutInputFingerprint({
      sourceIdentity: "source:stable-key",
      clipStartSec: 2,
      clipEndSec: 10,
      deletedRanges: [
        { startSec: 4, endSec: 5 },
        { startSec: 7, endSec: 8 },
      ],
      engineVersion: "shot-layout-v1",
    });
    const reordered = automaticLayoutInputFingerprint({
      engineVersion: "shot-layout-v1",
      deletedRanges: [
        { startSec: 7, endSec: 8 },
        { startSec: 4, endSec: 5 },
      ],
      clipEndSec: 10,
      clipStartSec: 2,
      sourceIdentity: "source:stable-key",
    });

    expect(reordered).toBe(first);
  });

  test("keeps the validated 64-scene, four-target Automatic boundary bounded", () => {
    const document = editorDocumentSchema.parse({
    version: 2,
      clipStartSec: 0,
      clipEndSec: 64,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "auto" } }),
      brollUrl: null,
      deletedRanges: [],
    });
    const source = {
      identity: "source:max-scenes",
      kind: "video" as const,
      width: 1920,
      height: 1080,
    };
    const segments = Array.from({ length: 64 }, (_, index) => ({
      startSec: index,
      endSec: index + 1,
      layout: "two-up" as const,
      topCxNorm: 0.25,
      bottomCxNorm: 0.75,
    }));
    const noSplitSegments = Array.from({ length: 64 }, (_, index) => ({
      startSec: index,
      endSec: index + 1,
      layout: "single" as const,
      cxNorm: 0.5,
    }));
    const analysis = clipAutoLayoutAnalysisSchema.parse({
      version: 1,
      engine: "shot-layout-v1",
      sourceIdentity: source.identity,
      analyzedAtISO: "2026-08-26T00:00:00.000Z",
      clipStartSec: 0,
      clipEndSec: 64,
      deletedRanges: [],
      editedDurationSec: 64,
      sourceWidth: 960,
      sourceHeight: 540,
      segments,
      noSplitSegments,
      shotCount: 64,
      soloShotCount: 0,
      multiShotCount: 64,
      twoUpSegmentCount: 64,
      speakerCount: 2,
      mappedSpeakerCount: 2,
    });
    const inputFingerprint = automaticLayoutInputFingerprint({
      sourceIdentity: source.identity,
      clipStartSec: 0,
      clipEndSec: 64,
      deletedRanges: [],
      engineVersion: "shot-layout-v1",
    });
    const result = planClipComposition({
      document,
      source,
      evidence: {
        automaticLayout: {
          state: "available",
          value: {
            sourceIdentity: source.identity,
            inputFingerprint,
            engineVersion: "shot-layout-v1",
            analysis,
          },
        },
      },
      assets: { backgroundImage: { state: "missing" } },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
      targets: [
        { id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 },
        { id: "square", aspectRatio: "1:1", width: 1080, height: 1080 },
        { id: "landscape", aspectRatio: "16:9", width: 1920, height: 1080 },
        { id: "portrait", aspectRatio: "4:5", width: 1080, height: 1350 },
      ],
    });

    expect(result.status).toBe("ready");
    if (result.status === "invalid") throw new Error(result.error.code);
    expect(result.plan.targets.map((target) => target.scenes.length)).toEqual([
      64, 64, 64, 64,
    ]);
    expect(new TextEncoder().encode(JSON.stringify(result.plan)).byteLength).toBeLessThanOrEqual(
      CLIP_COMPOSITION_MAX_SERIALIZED_BYTES,
    );
  });

  test("plans explicit Split scenes per target with distinct crops and encodable 4:5 tiles", () => {
    const document = editorDocumentSchema.parse({
    version: 2,
      clipStartSec: 0,
      clipEndSec: 8,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "split" } }),
      brollUrl: null,
      deletedRanges: [],
    });
    const source = {
      identity: "source:split",
      kind: "video" as const,
      width: 1920,
      height: 1080,
    };
    const engineVersion = "explicit-split-v1";
    const result = planClipComposition({
      document,
      source,
      evidence: {
        automaticLayout: { state: "missing" },
        splitLayout: {
          state: "available",
          value: {
            sourceIdentity: source.identity,
            inputFingerprint: splitLayoutInputFingerprint({
              sourceIdentity: source.identity,
              clipStartSec: 0,
              clipEndSec: 8,
              deletedRanges: [],
              engineVersion,
            }),
            engineVersion,
            source: "explicit-detector",
            segments: [
              {
                startSec: 0,
                endSec: 4,
                layout: "two-up",
                topCxNorm: 0.2,
                bottomCxNorm: 0.8,
              },
              {
                startSec: 4,
                endSec: 8,
                layout: "single",
                cxNorm: 0.72,
              },
            ],
            fallbackSegments: [
              { startSec: 0, endSec: 4, layout: "single", cxNorm: 0.2 },
              { startSec: 4, endSec: 8, layout: "single", cxNorm: 0.72 },
            ],
          },
        },
      },
      assets: { backgroundImage: { state: "missing" } },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
        explicitSplitLayout: true,
        splitEngineVersion: engineVersion,
      },
      targets: [
        { id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 },
        { id: "portrait", aspectRatio: "4:5", width: 1080, height: 1350 },
        { id: "square", aspectRatio: "1:1", width: 1080, height: 1080 },
      ],
    });

    expect(result.status).toBe("ready");
    if (result.status === "invalid") throw new Error(result.error.code);
    expect(result.plan.evidenceRequests).toEqual([]);
    expect(result.plan.targets[0]).toMatchObject({
      requestedMode: "split",
      effectiveMode: "split",
      scenes: [
        {
          startSec: 0,
          endSec: 4,
          layers: [
            {
              speaker: { role: "top" },
              destination: { x: 0, y: 0, width: 1080, height: 960 },
            },
            {
              speaker: { role: "bottom" },
              destination: { x: 0, y: 960, width: 1080, height: 960 },
            },
          ],
        },
        { startSec: 4, endSec: 8, layers: [{ speaker: { role: "single" } }] },
      ],
    });
    expect(result.plan.targets[1]?.scenes[0]?.layers).toMatchObject([
      { destination: { x: 0, y: 0, width: 1080, height: 676 } },
      { destination: { x: 0, y: 676, width: 1080, height: 674 } },
    ]);
    const verticalLayers = result.plan.targets[0]!.scenes[0]!.layers;
    expect(verticalLayers[0]).not.toMatchObject({
      sourceCrop: verticalLayers[1]?.kind === "source-video"
        ? verticalLayers[1].sourceCrop
        : null,
    });
    expect(result.plan.targets[2]).toMatchObject({
      requestedMode: "split",
      effectiveMode: "auto",
      scenes: [
        { layers: [{ speaker: { role: "single" } }] },
        { layers: [{ speaker: { role: "single" } }] },
      ],
    });
    expect(result.plan.notices).toContainEqual({
      code: "split_target_ineligible",
      fidelity: "degraded",
      targetId: "square",
      sceneId: null,
      effectiveFallback: "auto",
      userActionPossible: false,
    });
  });

  test("plans Screen PiP, face-band, and static fallbacks from one evidence contract", () => {
    const document = editorDocumentSchema.parse({
    version: 2,
      clipStartSec: 2,
      clipEndSec: 10,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "screen" } }),
      brollUrl: null,
      deletedRanges: [],
    });
    const source = {
      identity: "source:screen",
      kind: "video" as const,
      width: 1920,
      height: 1080,
    };
    const engineVersion = "screen-layout-v2";
    const common = {
      document,
      source,
      evidence: { automaticLayout: { state: "missing" as const } },
      assets: { backgroundImage: { state: "missing" as const } },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
        screenLayout: true,
        screenEngineVersion: engineVersion,
      },
      targets: [
        { id: "vertical", aspectRatio: "9:16" as const, width: 1080, height: 1920 },
        { id: "portrait", aspectRatio: "4:5" as const, width: 1080, height: 1350 },
      ],
    };
    const fingerprint = screenLayoutInputFingerprint({
      sourceIdentity: source.identity,
      clipStartSec: 2,
      clipEndSec: 10,
      deletedRanges: [],
      engineVersion,
    });
    const pip = planClipComposition({
      ...common,
      evidence: {
        ...common.evidence,
        screenLayout: {
          state: "available" as const,
          value: {
            sourceIdentity: source.identity,
            inputFingerprint: fingerprint,
            engineVersion,
            source: "durable-pip" as const,
            pictureInPicture: {
              state: "confirmed" as const,
              rect: { x: 0.72, y: 0.68, width: 0.2, height: 0.22 },
            },
            faceBand: { state: "unavailable" as const },
          },
        },
      },
    });
    const faceBand = planClipComposition({
      ...common,
      evidence: {
        ...common.evidence,
        screenLayout: {
          state: "available" as const,
          value: {
            sourceIdentity: source.identity,
            inputFingerprint: fingerprint,
            engineVersion,
            source: "analysis" as const,
            pictureInPicture: { state: "unavailable" as const },
            faceBand: {
              state: "available" as const,
              segments: [
                { startSec: 0, endSec: 8, layout: "single" as const, cxNorm: 0.75 },
              ],
            },
          },
        },
      },
    });
    const pending = planClipComposition({
      ...common,
      evidence: {
        ...common.evidence,
        screenLayout: { state: "missing" as const },
      },
    });

    expect(pip.status).toBe("ready");
    expect(faceBand.status).toBe("ready");
    expect(pending.status).toBe("pending");
    if (
      pip.status === "invalid" ||
      faceBand.status === "invalid" ||
      pending.status === "invalid"
    ) {
      throw new Error("expected valid Screen plans");
    }
    expect(pip.plan.targets[0]).toMatchObject({
      requestedMode: "screen",
      effectiveMode: "screen",
      scenes: [
        {
          layers: [
            {
              kind: "source-video",
              fit: "contain",
              sourceCrop: { x: 0, y: 0, width: 1920, height: 1080 },
              destination: { x: 0, y: 0, width: 1080, height: 960 },
            },
            {
              kind: "source-video",
              fit: "cover",
              destination: { x: 0, y: 960, width: 1080, height: 960 },
            },
          ],
        },
      ],
    });
    expect(pip.plan.targets[1]?.scenes[0]?.layers).toMatchObject([
      { destination: { x: 0, y: 0, width: 1080, height: 676 } },
      { destination: { x: 0, y: 676, width: 1080, height: 674 } },
    ]);
    expect(faceBand.plan.targets[0]?.scenes[0]?.layers[1]).toMatchObject({
      sourceCrop: { x: 705, y: 0, width: 1215, height: 1080 },
    });
    expect(pending.plan.evidenceRequests).toEqual([
      {
        key: `screen-layout:${fingerprint}`,
        kind: "screen-layout",
        engineVersion,
      },
    ]);
    expect(pending.plan.notices).toEqual([
      {
        code: "screen_layout_analyzing",
        fidelity: "pending",
        targetId: "vertical",
        sceneId: null,
        effectiveFallback: "screen",
        userActionPossible: false,
      },
      {
        code: "screen_layout_analyzing",
        fidelity: "pending",
        targetId: "portrait",
        sceneId: null,
        effectiveFallback: "screen",
        userActionPossible: false,
      },
    ]);
  });

  test("rejects Split when exact 4:5 tile geometry or clamped crops duplicate tiles", () => {
    const document = editorDocumentSchema.parse({
    version: 2,
      clipStartSec: 0,
      clipEndSec: 8,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "split" } }),
      brollUrl: null,
      deletedRanges: [],
    });
    const engineVersion = "explicit-split-v1";
    const planFor = (source: { identity: string; width: number; height: number }) =>
      planClipComposition({
        document,
        source: { ...source, kind: "video" as const },
        evidence: {
          automaticLayout: { state: "missing" as const },
          splitLayout: {
            state: "available" as const,
            value: {
              sourceIdentity: source.identity,
              inputFingerprint: splitLayoutInputFingerprint({
                sourceIdentity: source.identity,
                clipStartSec: 0,
                clipEndSec: 8,
                deletedRanges: [],
                engineVersion,
              }),
              engineVersion,
              source: "explicit-detector" as const,
              segments: [
                {
                  startSec: 0,
                  endSec: 8,
                  layout: "two-up" as const,
                  topCxNorm: 0.01,
                  bottomCxNorm: 0.02,
                },
              ],
              fallbackSegments: [
                { startSec: 0, endSec: 8, layout: "single" as const, cxNorm: 0.5 },
              ],
            },
          },
        },
        assets: { backgroundImage: { state: "missing" as const } },
        capabilities: {
          automaticSpeakerLayout: true,
          automaticSpeakerEngineVersion: "shot-layout-v1",
          explicitSplitLayout: true,
          splitEngineVersion: engineVersion,
        },
        targets: [
          { id: "portrait", aspectRatio: "4:5" as const, width: 1080, height: 1350 },
        ],
      });

    const boundary = planFor({ identity: "source:boundary", width: 1600, height: 1000 });
    expect(boundary.status).toBe("ready");
    if (boundary.status === "invalid") throw new Error(boundary.error.code);
    expect(boundary.plan.notices[0]?.code).toBe("split_target_ineligible");

    const duplicated = planFor({ identity: "source:duplicate", width: 1920, height: 1080 });
    expect(duplicated.status).toBe("ready");
    if (duplicated.status === "invalid") throw new Error(duplicated.error.code);
    expect(duplicated.plan.targets[0]?.effectiveMode).toBe("auto");
    expect(duplicated.plan.targets[0]?.scenes[0]?.layers).toHaveLength(1);
    expect(duplicated.plan.notices[0]?.code).toBe("split_tiles_not_distinct");
    expect(duplicated.plan.notices[0]?.sceneId).not.toBeNull();
  });

  test("uses a static Screen speaker tile when the face band has no lateral crop room", () => {
    const document = editorDocumentSchema.parse({
    version: 2,
      clipStartSec: 0,
      clipEndSec: 8,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "screen" } }),
      brollUrl: null,
      deletedRanges: [],
    });
    const source = {
      identity: "source:portrait-screen",
      kind: "video" as const,
      width: 1080,
      height: 1920,
    };
    const engineVersion = "screen-layout-v2";
    const result = planClipComposition({
      document,
      source,
      evidence: {
        automaticLayout: { state: "missing" },
        screenLayout: {
          state: "available",
          value: {
            sourceIdentity: source.identity,
            inputFingerprint: screenLayoutInputFingerprint({
              sourceIdentity: source.identity,
              clipStartSec: 0,
              clipEndSec: 8,
              deletedRanges: [],
              engineVersion,
            }),
            engineVersion,
            source: "analysis",
            pictureInPicture: { state: "unavailable" },
            faceBand: {
              state: "available",
              segments: [
                { startSec: 0, endSec: 8, layout: "single", cxNorm: 0.9 },
              ],
            },
          },
        },
      },
      assets: { backgroundImage: { state: "missing" } },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
        screenLayout: true,
        screenEngineVersion: engineVersion,
      },
      targets: [
        { id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 },
      ],
    });
    expect(result.status).toBe("ready");
    if (result.status === "invalid") throw new Error(result.error.code);
    expect(result.plan.notices[0]?.code).toBe("screen_static_center_fallback");
  });

  test("keeps Split failure, stale-evidence, and edited-timeline fallbacks typed", () => {
    const document = editorDocumentSchema.parse({
    version: 2,
      clipStartSec: 0,
      clipEndSec: 10,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "split" } }),
      brollUrl: null,
      deletedRanges: [{ startSec: 4, endSec: 6 }],
    });
    const source = {
      identity: "source:split-failures",
      kind: "video" as const,
      width: 1920,
      height: 1080,
    };
    const engineVersion = "explicit-split-v1";
    const common = {
      document,
      source,
      assets: { backgroundImage: { state: "missing" as const } },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
        explicitSplitLayout: true,
        splitEngineVersion: engineVersion,
      },
      targets: [
        {
          id: "vertical",
          aspectRatio: "9:16" as const,
          width: 1080,
          height: 1920,
        },
      ],
    };

    for (const reason of [
      "detection_unavailable",
      "insufficient_clusters",
      "empty_plan",
      "no_two_up_segments",
    ] as const) {
      const result = planClipComposition({
        ...common,
        evidence: {
          automaticLayout: { state: "missing" },
          splitLayout: { state: "failed", reason },
        },
      });
      expect(result.status).toBe("ready");
      if (result.status === "invalid") throw new Error(result.error.code);
      expect(result.plan.evidenceRequests).toEqual([]);
      expect(result.plan.targets[0]?.effectiveMode).toBe("center");
      expect(result.plan.targets[0]?.scenes[0]).toMatchObject({
        startSec: 0,
        endSec: 8,
      });
      expect(result.plan.notices[0]?.code).toBe(`split_${reason}`);
    }

    const stale = planClipComposition({
      ...common,
      evidence: {
        automaticLayout: { state: "missing" },
        splitLayout: {
          state: "available",
          value: {
            sourceIdentity: source.identity,
            inputFingerprint: "stale",
            engineVersion,
            source: "explicit-detector",
            segments: [
              {
                startSec: 0,
                endSec: 8,
                layout: "two-up",
                topCxNorm: 0.25,
                bottomCxNorm: 0.75,
              },
            ],
            fallbackSegments: [
              { startSec: 0, endSec: 8, layout: "single", cxNorm: 0.5 },
            ],
          },
        },
      },
    });
    expect(stale.status).toBe("pending");
    if (stale.status === "invalid") throw new Error(stale.error.code);
    expect(stale.plan.notices[0]?.code).toBe("split_layout_analyzing");
    expect(stale.plan.evidenceRequests).toHaveLength(1);
  });

  test("keeps Screen PiP gating and unavailable-analysis fallbacks explicit", () => {
    const document = editorDocumentSchema.parse({
    version: 2,
      clipStartSec: 0,
      clipEndSec: 8,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "screen" } }),
      brollUrl: null,
      deletedRanges: [],
    });
    const source = {
      identity: "source:screen-failures",
      kind: "video" as const,
      width: 1920,
      height: 1080,
    };
    const engineVersion = "screen-layout-v2";
    const fingerprint = screenLayoutInputFingerprint({
      sourceIdentity: source.identity,
      clipStartSec: 0,
      clipEndSec: 8,
      deletedRanges: [],
      engineVersion,
    });
    const common = {
      document,
      source,
      assets: { backgroundImage: { state: "missing" as const } },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
        screenLayout: true,
        screenEngineVersion: engineVersion,
      },
      targets: [
        {
          id: "vertical",
          aspectRatio: "9:16" as const,
          width: 1080,
          height: 1920,
        },
      ],
    };
    const tinyPip = planClipComposition({
      ...common,
      evidence: {
        automaticLayout: { state: "missing" },
        screenLayout: {
          state: "available",
          value: {
            sourceIdentity: source.identity,
            inputFingerprint: fingerprint,
            engineVersion,
            source: "analysis",
            pictureInPicture: {
              state: "confirmed",
              rect: { x: 0.7, y: 0.7, width: 0.05, height: 0.05 },
            },
            faceBand: { state: "unavailable" },
          },
        },
      },
    });
    expect(tinyPip.status).toBe("ready");
    if (tinyPip.status === "invalid") throw new Error(tinyPip.error.code);
    expect(tinyPip.plan.targets[0]?.effectiveMode).toBe("screen");
    expect(tinyPip.plan.notices[0]?.code).toBe("screen_pip_too_small");

    for (const reason of [
      "analysis_unavailable",
      "detection_unavailable",
      "no_face_detected",
      "no_trustworthy_faces",
    ] as const) {
      const failed = planClipComposition({
        ...common,
        evidence: {
          automaticLayout: { state: "missing" },
          screenLayout: { state: "failed", reason },
        },
      });
      expect(failed.status).toBe("ready");
      if (failed.status === "invalid") throw new Error(failed.error.code);
      expect(failed.plan.evidenceRequests).toEqual([]);
      expect(failed.plan.targets[0]?.effectiveMode).toBe("screen");
      expect(failed.plan.notices[0]?.code).toBe(`screen_${reason}`);
    }

    const disabled = planClipComposition({
      ...common,
      capabilities: { ...common.capabilities, screenLayout: false },
      evidence: {
        automaticLayout: { state: "missing" },
        screenLayout: { state: "disabled" },
      },
    });
    expect(disabled.status).toBe("ready");
    if (disabled.status === "invalid") throw new Error(disabled.error.code);
    expect(disabled.plan.targets[0]?.effectiveMode).toBe("center");
    expect(disabled.plan.notices[0]?.code).toBe("screen_layout_disabled");
  });

  test("plans resolved B-roll windows as edited-time layers over the existing base composition", () => {
    const document = editorDocumentSchema.parse({
    version: 2,
      clipStartSec: 10,
      clipEndSec: 20,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
      brollUrl: "https://example.com/cutaway.mp4",
      deletedRanges: [{ startSec: 13, endSec: 15 }],
    });
    const result = planClipComposition({
      document,
      source: {
        identity: "source:broll",
        kind: "video",
        width: 1920,
        height: 1080,
      },
      evidence: { automaticLayout: { state: "missing" } },
      assets: {
        backgroundImage: { state: "missing" },
        broll: {
          state: "available",
          placements: [
            {
              id: "manual-1",
              ref: "broll:manual-1",
							mediaKind: "video",
              startSec: 2,
              endSec: 5.5,
							sourceStartSec: 0,
							sourceEndSec: 3.5,
            },
          ],
        },
      },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
      targets: [
        { id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 },
      ],
    });

    expect(result.status).toBe("ready");
    if (result.status === "invalid") throw new Error(result.error.code);
    expect(result.plan.editedDurationSec).toBe(8);
    expect(result.plan.targets[0]?.scenes.map((scene) => [
      scene.startSec,
      scene.endSec,
      scene.layers.map((layer) => layer.kind),
    ])).toEqual([
      [0, 2, ["source-video"]],
      [2, 5.5, ["source-video", "broll-media"]],
      [5.5, 8, ["source-video"]],
    ]);
    expect(result.plan.targets[0]?.scenes[1]?.layers[1]).toEqual({
      id: "layer:broll:manual-1:vertical",
      kind: "broll-media",
      sourceRef: "broll:manual-1",
			mediaKind: "video",
			sourceRange: { startSec: 0, endSec: 3.5 },
      activeRange: { startSec: 2, endSec: 5.5 },
      destination: { x: 0, y: 0, width: 1080, height: 1920 },
      fit: "cover",
      rotationDeg: 0,
      opacity: 1,
      zIndex: 20,
      motion: null,
      audio: "source",
    });
  });

	test("keeps an available still placement when another immutable asset is unavailable", () => {
		const document = editorDocumentSchema.parse({
			version: 2,
			clipStartSec: 0,
			clipEndSec: 10,
			captionPreset: captionPresetSchema.parse({}),
			transcriptSlice: [],
			studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
			deletedRanges: [],
		});
		const result = planClipComposition({
			document,
			source: { identity: "source:asset-broll", kind: "video", width: 1920, height: 1080 },
			evidence: { automaticLayout: { state: "missing" } },
			assets: {
				backgroundImage: { state: "missing" },
				broll: {
					state: "available",
					placements: [{
						id: "still-placement",
						ref: "visual_asset:still:fingerprint",
						mediaKind: "image",
						startSec: 2,
						endSec: 5,
						sourceStartSec: null,
						sourceEndSec: null,
					}],
					unavailablePlacements: [{
						id: "stale-placement",
						reason: "fingerprint_stale",
					}],
				},
			},
			capabilities: {
				automaticSpeakerLayout: true,
				automaticSpeakerEngineVersion: "shot-layout-v1",
			},
			targets: [{ id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 }],
		});

		expect(result.status).toBe("ready");
		if (result.status === "invalid") throw new Error(result.error.code);
		expect(result.plan.editedDurationSec).toBe(10);
		expect(result.plan.targets[0]?.scenes[1]?.layers[1]).toMatchObject({
			kind: "broll-media",
			mediaKind: "image",
			sourceRange: null,
		});
		expect(result.plan.notices).toContainEqual({
			code: "broll_asset_fingerprint_stale",
			fidelity: "degraded",
			targetId: "vertical",
			sceneId: null,
			placementId: "stale-placement",
			effectiveFallback: "center",
			userActionPossible: true,
		});
	});

  test("keeps automatic speaker scenes below B-roll and makes Split fallback truthful for the whole target", () => {
    const automaticDocument = editorDocumentSchema.parse({
    version: 2,
      clipStartSec: 0,
      clipEndSec: 8,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "auto" } }),
      brollUrl: "https://example.com/cutaway.mp4",
      deletedRanges: [],
    });
    const source = {
      identity: "source:broll-auto",
      kind: "video" as const,
      width: 1920,
      height: 1080,
    };
    const analysis = clipAutoLayoutAnalysisSchema.parse({
      version: 1,
      engine: "shot-layout-v1",
      sourceIdentity: source.identity,
      clipStartSec: 0,
      clipEndSec: 8,
      deletedRanges: [],
      editedDurationSec: 8,
      analyzedAtISO: "2026-08-26T00:00:00.000Z",
      sourceWidth: 1920,
      sourceHeight: 1080,
      segments: [
        { startSec: 0, endSec: 4, layout: "single", cxNorm: 0.25 },
        { startSec: 4, endSec: 8, layout: "single", cxNorm: 0.75 },
      ],
      noSplitSegments: [
        { startSec: 0, endSec: 4, layout: "single", cxNorm: 0.25 },
        { startSec: 4, endSec: 8, layout: "single", cxNorm: 0.75 },
      ],
      shotCount: 2,
      soloShotCount: 2,
      multiShotCount: 0,
      twoUpSegmentCount: 0,
      speakerCount: 1,
      mappedSpeakerCount: 1,
    });
    const automaticLayout = {
      state: "available" as const,
      value: {
        sourceIdentity: source.identity,
        inputFingerprint: automaticLayoutInputFingerprint({
          sourceIdentity: source.identity,
          clipStartSec: 0,
          clipEndSec: 8,
          deletedRanges: [],
          engineVersion: "shot-layout-v1",
        }),
        engineVersion: "shot-layout-v1",
        analysis,
      },
    };
    const common = {
      source,
      assets: {
        backgroundImage: { state: "missing" as const },
        broll: {
          state: "available" as const,
          placements: [
			{
				id: "cutaway",
				ref: "broll:cutaway",
				mediaKind: "video",
				startSec: 2,
				endSec: 6,
				sourceStartSec: 0,
				sourceEndSec: 4,
			},
          ],
        },
      },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
        explicitSplitLayout: true,
        splitEngineVersion: "explicit-split-v1",
      },
      targets: [
        { id: "vertical", aspectRatio: "9:16" as const, width: 1080, height: 1920 },
      ],
    };
    const automatic = planClipComposition({
      ...common,
      document: automaticDocument,
      evidence: { automaticLayout },
    });
    const split = planClipComposition({
      ...common,
      document: { ...automaticDocument, studioEdits: studioEditsSchema.parse({ framing: { mode: "split" } }) },
      evidence: { automaticLayout, splitLayout: { state: "missing" } },
    });

    expect(automatic.status).toBe("ready");
    expect(split.status).toBe("ready");
    if (automatic.status === "invalid" || split.status === "invalid") {
      throw new Error("expected ready B-roll plans");
    }
    expect(automatic.plan.targets[0]?.scenes).toHaveLength(4);
    expect(automatic.plan.targets[0]?.scenes[1]?.layers).toMatchObject([
      { kind: "source-video", speaker: { role: "single" } },
			{ kind: "broll-media", sourceRef: "broll:cutaway", mediaKind: "video" },
    ]);
    expect(split.plan.evidenceRequests).toEqual([]);
    expect(split.plan.targets[0]?.effectiveMode).toBe("auto");
    expect(split.plan.notices).toContainEqual({
      code: "split_broll_conflict",
      fidelity: "degraded",
      targetId: "vertical",
      sceneId: null,
      effectiveFallback: "auto",
      userActionPossible: false,
    });
    expect(split.plan.targets[0]?.scenes.every((scene) =>
      scene.layers.some((layer) => layer.kind === "source-video"),
    )).toBe(true);
  });

  test("omits failed optional B-roll without degrading the requested base mode", () => {
    const document = editorDocumentSchema.parse({
    version: 2,
      ...centerDocument(),
      brollUrl: "https://example.com/missing.mp4",
    });
    const result = planClipComposition({
      document,
      source: { identity: "source:broll-missing", kind: "video", width: 1920, height: 1080 },
      evidence: { automaticLayout: { state: "missing" } },
      assets: {
        backgroundImage: { state: "missing" },
        broll: { state: "failed" },
      },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
      targets: [
        { id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 },
      ],
    });

    expect(result.status).toBe("ready");
    if (result.status === "invalid") throw new Error(result.error.code);
    expect(result.plan.targets[0]?.effectiveMode).toBe("center");
    expect(result.plan.targets[0]?.scenes).toHaveLength(1);
    expect(result.plan.notices).toContainEqual({
      code: "broll_asset_unavailable",
      fidelity: "degraded",
      targetId: "vertical",
      sceneId: null,
      effectiveFallback: "center",
      userActionPossible: true,
    });
  });

  test("plans the complete timed visual stack in edited time and omits only an unavailable logo", () => {
    const document = editorDocumentSchema.parse({
    version: 2,
      clipStartSec: 10,
      clipEndSec: 20,
      captionPreset: captionPresetSchema.parse({
        position: "bottom",
        positionX: 42,
        visible: true,
      }),
      transcriptSlice: [
        {
          index: 0,
          speaker: 0,
          speakerLabel: "Speaker 1",
          startSec: 10.5,
          endSec: 16,
          text: "One two three four",
          confidence: 0.99,
          words: [
            { word: "One", startSec: 10.5, endSec: 11, confidence: 0.99 },
            { word: "two", startSec: 11, endSec: 11.5, confidence: 0.99 },
            { word: "three", startSec: 12.5, endSec: 13, confidence: 0.99 },
            { word: "four", startSec: 15, endSec: 16, confidence: 0.99 },
          ],
        },
      ],
      studioEdits: studioEditsSchema.parse({
        framing: { mode: "center" },
        textLayers: [
          {
            id: "hook",
            text: "Read this",
            startSec: 1,
            endSec: 7,
            positionX: 25,
            positionY: 20,
            fontName: "Arial",
            fontSize: 44,
            color: "#FFFFFF",
            bold: true,
            outlineColor: "#000000",
            outlineWidth: 2,
          },
        ],
        transition: { type: "dip-white", durationSec: 0.5 },
      }),
      brollUrl: null,
      deletedRanges: [{ startSec: 12, endSec: 14 }],
    });
    const common = {
      document,
      source: {
        identity: "source:visual-stack",
        kind: "video" as const,
        width: 1920,
        height: 1080,
      },
      evidence: { automaticLayout: { state: "missing" as const } },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
      targets: [
        {
          id: "vertical",
          aspectRatio: "9:16" as const,
          width: 1080,
          height: 1920,
          outputTreatment: { resolution: "720p" as const, watermark: true },
        },
        {
          id: "horizontal",
          aspectRatio: "16:9" as const,
          width: 1920,
          height: 1080,
          outputTreatment: { resolution: "1080p" as const, watermark: false },
        },
      ],
    };

    const available = planClipComposition({
      ...common,
      assets: {
        backgroundImage: { state: "missing" as const },
        logo: {
          state: "available" as const,
          ref: "logo:brand",
          settings: {
            enabled: true,
            position: "top-right" as const,
            opacity: 80,
            scalePct: 12,
          },
        },
      },
    });
    expect(available.status).toBe("ready");
    if (available.status === "invalid") throw new Error(available.error.code);
    expect(available.plan.editedDurationSec).toBe(8);
    expect(available.plan.targets[0]?.visualLayers.map((layer) => [
      layer.id,
      layer.kind,
      layer.zIndex,
      layer.activeRange,
    ])).toEqual([
      ["layer:text:hook:vertical", "text", 30, { startSec: 1, endSec: 7 }],
      ["layer:caption:0:0:vertical", "caption", 40, { startSec: 0.5, endSec: 4 }],
      ["layer:logo:vertical", "logo", 50, { startSec: 0, endSec: 8 }],
      ["layer:transition:vertical", "transition", 60, { startSec: 0, endSec: 8 }],
      ["layer:output-treatment:vertical", "output-treatment", 70, { startSec: 0, endSec: 8 }],
    ]);
    expect(available.plan.targets[0]?.visualLayers[0]).toMatchObject({
      kind: "text",
      anchor: { xPct: 25, yPct: 20 },
      rotationDeg: 0,
      opacity: 1,
    });
    expect(available.plan.targets[0]?.visualLayers[1]).toMatchObject({
      kind: "caption",
      anchor: { xPct: 42, yPct: 88 },
      words: [
        { text: "ONE", startSec: 0.5, endSec: 1 },
        { text: "TWO", startSec: 1, endSec: 3 },
        { text: "FOUR", startSec: 3, endSec: 4 },
      ],
    });
    expect(available.plan.targets[0]?.visualLayers.at(-1)).toMatchObject({
      kind: "output-treatment",
      resolution: "720p",
      scale: { numerator: 2, denominator: 3 },
      watermark: { enabled: true, text: "Made with Narriflow" },
    });
    expect(available.plan.targets[1]?.visualLayers.map((layer) => [
      layer.id,
      layer.kind,
      layer.destination,
    ])).toEqual([
      ["layer:text:hook:horizontal", "text", { x: 0, y: 0, width: 1920, height: 1080 }],
      ["layer:caption:0:0:horizontal", "caption", { x: 0, y: 0, width: 1920, height: 1080 }],
      ["layer:logo:horizontal", "logo", { x: 0, y: 0, width: 1920, height: 1080 }],
      ["layer:transition:horizontal", "transition", { x: 0, y: 0, width: 1920, height: 1080 }],
      ["layer:output-treatment:horizontal", "output-treatment", { x: 0, y: 0, width: 1920, height: 1080 }],
    ]);
    expect(available.plan.targets[1]?.visualLayers.at(-2)).toMatchObject({
      kind: "transition",
      effect: {
        entrance: { range: { startSec: 0, endSec: 0.5 } },
        exit: { range: { startSec: 7.5, endSec: 8 } },
      },
    });
    expect(available.plan.targets[1]?.visualLayers.at(-1)).toMatchObject({
      kind: "output-treatment",
      resolution: "1080p",
      scale: { numerator: 1, denominator: 1 },
      watermark: {
        enabled: false,
        fontFamily: "Arial",
        fontWeight: 700,
        fontSizePx: 39,
        marginPx: { x: 27, y: 27 },
      },
    });

    const failedLogo = planClipComposition({
      ...common,
      assets: {
        backgroundImage: { state: "missing" as const },
        logo: { state: "failed" as const },
      },
    });
    expect(failedLogo.status).toBe("ready");
    if (failedLogo.status === "invalid") throw new Error(failedLogo.error.code);
    expect(failedLogo.plan.targets[0]?.visualLayers.some((layer) => layer.kind === "logo")).toBe(false);
    expect(failedLogo.plan.notices).toContainEqual({
      code: "logo_asset_unavailable",
      fidelity: "degraded",
      targetId: "vertical",
      sceneId: null,
      effectiveFallback: "center",
      userActionPossible: true,
    });
  });

  test("resolves every approved clip transition into canonical target geometry", () => {
    const transitions = [
      ["fade", "fade", null],
      ["fade-black", "fade", null],
      ["dip-white", "fade", null],
      ["cross-dissolve", "cross-dissolve", null],
      ["wipe-left", "wipe", "left"],
      ["wipe-right", "wipe", "right"],
      ["wipe-up", "wipe", "up"],
      ["wipe-down", "wipe", "down"],
      ["slide-left", "slide", "left"],
      ["slide-right", "slide", "right"],
      ["slide-up", "slide", "up"],
      ["slide-down", "slide", "down"],
      ["zoom-in", "zoom", "in"],
      ["zoom-out", "zoom", "out"],
    ] as const;
    for (const [type, family, direction] of transitions) {
      const result = planClipComposition({
        document: editorDocumentSchema.parse({
          ...centerDocument(),
          clipStartSec: 0,
          clipEndSec: 0.5,
          deletedRanges: [],
          studioEdits: studioEditsSchema.parse({
            framing: { mode: "center" },
            transition: { type, durationSec: 0.4 },
          }),
        }),
        source: {
          identity: `source:transition:${type}`,
          kind: "video",
          width: 1920,
          height: 1080,
        },
        evidence: { automaticLayout: { state: "missing" } },
        assets: { backgroundImage: { state: "missing" } },
        capabilities: {
          automaticSpeakerLayout: true,
          automaticSpeakerEngineVersion: "shot-layout-v1",
        },
        targets: [
          { id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 },
        ],
      });
      if (result.status === "invalid") throw new Error(result.error.code);
      const layer = result.plan.targets[0]!.visualLayers.find(
        (candidate) => candidate.kind === "transition",
      );
      expect(layer).toMatchObject({
        kind: "transition",
        transition: type,
        effect: {
          family,
          direction,
          canvas: { width: 1080, height: 1920 },
          entrance: { range: { startSec: 0, endSec: 0.25 } },
          exit: { range: { startSec: 0.25, endSec: 0.5 } },
        },
      });
    }
  });

  test("resolves exact transition masks and transforms for both clip boundaries", () => {
    const planTransition = (
      type: "fade" | "wipe-left" | "slide-up" | "zoom-in",
    ) => {
      const result = planClipComposition({
        document: editorDocumentSchema.parse({
          ...centerDocument(),
          clipStartSec: 0,
          clipEndSec: 2,
          deletedRanges: [],
          studioEdits: studioEditsSchema.parse({
            framing: { mode: "center" },
            transition: { type, durationSec: 0.4 },
          }),
        }),
        source: {
          identity: `source:resolved-transition:${type}`,
          kind: "video",
          width: 1920,
          height: 1080,
        },
        evidence: { automaticLayout: { state: "missing" } },
        assets: { backgroundImage: { state: "missing" } },
        capabilities: {
          automaticSpeakerLayout: true,
          automaticSpeakerEngineVersion: "shot-layout-v1",
        },
        targets: [
          { id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 },
        ],
      });
      if (result.status === "invalid") throw new Error(result.error.code);
      const layer = result.plan.targets[0]!.visualLayers.find(
        (candidate) => candidate.kind === "transition",
      );
      if (layer?.kind !== "transition") throw new Error("missing transition");
      return layer;
    };

    const resting = {
      overlayOpacity: 0,
      overlayMaskSizePx: 0,
      translateXPx: 0,
      translateYPx: 0,
      scale: 1,
    };

    expect(planTransition("fade").effect).toMatchObject({
      version: 1,
      mask: null,
      entrance: {
        range: { startSec: 0, endSec: 0.4 },
        from: { ...resting, overlayOpacity: 1 },
        to: resting,
      },
      resting,
      exit: {
        range: { startSec: 1.6, endSec: 2 },
        from: resting,
        to: { ...resting, overlayOpacity: 1 },
      },
    });

    expect(planTransition("wipe-left").effect).toMatchObject({
      version: 1,
      mask: {
        axis: "horizontal",
        overlayEdge: "start",
        pixelDivisor: 2,
      },
      entrance: {
        from: { ...resting, overlayOpacity: 1, overlayMaskSizePx: 1078 },
        to: { ...resting, overlayOpacity: 1 },
      },
      resting: { ...resting, overlayOpacity: 1 },
      exit: {
        from: { ...resting, overlayOpacity: 1 },
        to: { ...resting, overlayOpacity: 1, overlayMaskSizePx: 1078 },
      },
    });

    expect(planTransition("slide-up").effect).toMatchObject({
      entrance: {
        from: { ...resting, translateYPx: 1920 },
        to: resting,
      },
      resting,
      exit: {
        from: resting,
        to: { ...resting, translateYPx: -1920 },
      },
    });

    const zoom = planTransition("zoom-in");
    expect(zoom.effect).toMatchObject({
      entrance: {
        from: { ...resting, scale: 0.88 },
        to: resting,
      },
      resting,
      exit: {
        from: resting,
        to: { ...resting, scale: 1.12 },
      },
    });
    expect(evaluateCompositionTransition(zoom.effect, 1.8)).toMatchObject({
      translateXPx: 0,
      translateYPx: 0,
      scale: 1.06,
      animated: true,
    });
  });

  test("resolves Scene and B-roll motion once and evaluates a static reduced-motion state", () => {
    const sceneId = "8ab9d330-688f-4574-932c-27ac661245c1";
    const imageId = "141b738e-f106-4da1-b670-8b71ff7f0a58";
		const brollPlacementId = "20000000-0000-4000-8000-000000000001";
		const brollAssetId = "20000000-0000-4000-8000-000000000002";
    const fingerprint = "a".repeat(64);
    const document = editorDocumentSchema.parse({
      ...centerDocument(),
      clipStartSec: 0,
      clipEndSec: 6,
      deletedRanges: [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
		brollUrl: null,
		brollPlacements: [{
			id: brollPlacementId,
			asset: { kind: "visual_asset", id: brollAssetId, fingerprint },
			provenance: "uploaded",
			mediaKind: "video",
			startSec: 3,
			endSec: 6,
			sourceStartSec: 0,
			sourceEndSec: 3,
		}],
      sceneBlocks: [{
        id: sceneId,
        schemaVersion: 1,
        anchorSec: 0,
        durationSec: 2,
        content: {
          kind: "image",
          asset: { kind: "visual_asset", id: imageId, fingerprint },
          fit: "cover",
          backgroundColor: "#111827",
        },
        motion: { entrance: "ken-burns-in", exit: "fade" },
        templateSnapshot: null,
      }],
      mediaMotions: [{
        schemaVersion: 1,
        id: "2adf79cc-35b2-4de5-85dc-c9ed197763e4",
		target: { kind: "broll", placementId: brollPlacementId },
        startSec: 3,
        endSec: 6,
        entrance: "pan-left",
        exit: "scale-out",
        enabled: true,
      }],
    });
    const result = planClipComposition({
      document,
      source: { identity: "source:motion", kind: "video", width: 1920, height: 1080 },
      evidence: { automaticLayout: { state: "missing" } },
      assets: {
        backgroundImage: { state: "missing" },
        broll: {
          state: "available",
			placements: [{
				id: brollPlacementId,
				ref: "broll:manual",
				mediaKind: "video",
				startSec: 3,
				endSec: 6,
				sourceStartSec: 0,
				sourceEndSec: 3,
			}],
        },
        sceneVisuals: { [sceneId]: { state: "available", ref: "scene:image" } },
      },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
      targets: [{ id: "small", aspectRatio: "9:16", width: 100, height: 200 }],
    });
    if (result.status === "invalid") throw new Error(result.error.code);
    const inserted = result.plan.targets[0]!.scenes
      .flatMap((scene) => scene.layers)
      .find((layer) => layer.kind === "inserted-scene");
    if (inserted?.kind !== "inserted-scene" || !inserted.motion) {
      throw new Error("missing resolved Scene motion");
    }
    expect(inserted.motion).toMatchObject({
      version: 1,
      activeRange: { startSec: 0, endSec: 2 },
      clippingBounds: { x: 0, y: 0, width: 100, height: 200 },
      entrance: {
        family: "ken-burns",
        range: { startSec: 0, endSec: 0.5 },
        from: { crop: { x: 0, y: 0, width: 100, height: 200 } },
        to: { crop: { x: 6, y: 12, width: 88, height: 176 } },
      },
      exit: {
        family: "fade",
        range: { startSec: 1.5, endSec: 2 },
      },
    });
    expect(evaluateCompositionMotion(inserted.motion, 1, { reducedMotion: true }))
      .toMatchObject({
        animated: false,
        opacity: 1,
        scale: 1,
        crop: { x: 6, y: 12, width: 88, height: 176 },
      });

    const broll = result.plan.targets[0]!.scenes
      .flatMap((scene) => scene.layers)
		.find((layer) => layer.kind === "broll-media");
		expect(broll?.kind === "broll-media" ? broll.motion : null).toMatchObject({
      activeRange: { startSec: 3, endSec: 6 },
      entrance: { family: "pan", direction: "left" },
      exit: { family: "scale" },
    });
  });

	test("attaches B-roll motion only to the placement named by its target", () => {
		const firstPlacementId = "20000000-0000-4000-8000-000000000001";
		const secondPlacementId = "20000000-0000-4000-8000-000000000002";
		const placement = (id: string, assetId: string, startSec: number, endSec: number) => ({
			id,
			asset: { kind: "visual_asset" as const, id: assetId, fingerprint: "a".repeat(64) },
			provenance: "generated" as const,
			mediaKind: "image" as const,
			startSec,
			endSec,
			sourceStartSec: null,
			sourceEndSec: null,
		});
		const document = editorDocumentSchema.parse({
			...centerDocument(),
			brollPlacements: [
				placement(firstPlacementId, "20000000-0000-4000-8000-000000000003", 1, 3),
				placement(secondPlacementId, "20000000-0000-4000-8000-000000000004", 4, 6),
			],
			mediaMotions: [{
				schemaVersion: 1,
				id: "20000000-0000-4000-8000-000000000005",
				target: { kind: "broll", placementId: secondPlacementId },
				startSec: 4,
				endSec: 6,
				entrance: "pan-right",
				exit: "fade",
				enabled: true,
			}],
		});
		const result = planClipComposition({
			document,
			source: { identity: "source:placement-motion", kind: "video", width: 1920, height: 1080 },
			evidence: { automaticLayout: { state: "missing" } },
			assets: {
				backgroundImage: { state: "missing" },
				broll: {
					state: "available",
					placements: [
						{ id: firstPlacementId, ref: "broll:first", mediaKind: "image", startSec: 1, endSec: 3, sourceStartSec: null, sourceEndSec: null },
						{ id: secondPlacementId, ref: "broll:second", mediaKind: "image", startSec: 4, endSec: 6, sourceStartSec: null, sourceEndSec: null },
					],
				},
			},
			capabilities: {
				automaticSpeakerLayout: true,
				automaticSpeakerEngineVersion: "shot-layout-v1",
			},
			targets: [{ id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 }],
		});
		if (result.status === "invalid") throw new Error(result.error.code);
		const brollLayers = result.plan.targets[0]!.scenes
			.flatMap((scene) => scene.layers)
			.filter((layer) => layer.kind === "broll-media");
		expect(brollLayers.find((layer) => layer.sourceRef === "broll:first")?.motion).toBeNull();
		expect(brollLayers.find((layer) => layer.sourceRef === "broll:second")?.motion)
			.toMatchObject({ entrance: { family: "pan", direction: "right" } });
	});

	test("attaches URL-backed motion only to the stable manual composition target", () => {
		const document = editorDocumentSchema.parse({
			...centerDocument(),
			clipStartSec: 0,
			clipEndSec: 20,
			deletedRanges: [],
			brollUrl: "https://media.example.test/manual.mp4",
			mediaMotions: [{
				schemaVersion: 1,
				id: "20000000-0000-4000-8000-000000000001",
				target: { kind: "broll_url" },
				startSec: 5.6,
				endSec: 9.1,
				entrance: "ken-burns-in",
				exit: "fade",
				enabled: true,
			}],
		});
		const planForPlacement = (id: string) => planClipComposition({
			document,
			source: { identity: "source:url-motion", kind: "video", width: 1920, height: 1080 },
			evidence: { automaticLayout: { state: "missing" } },
			assets: {
				backgroundImage: { state: "missing" },
				broll: {
					state: "available",
					placements: [{
						id,
						ref: "broll:url",
						mediaKind: "video",
						startSec: 5.6,
						endSec: 9.1,
						sourceStartSec: 0,
						sourceEndSec: 3.5,
					}],
				},
			},
			capabilities: {
				automaticSpeakerLayout: true,
				automaticSpeakerEngineVersion: "shot-layout-v1",
			},
			targets: [{ id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 }],
		});
		const manual = planForPlacement(MANUAL_BROLL_COMPOSITION_ID);
		if (manual.status === "invalid") throw new Error(manual.error.code);
		const manualLayer = manual.plan.targets[0]!.scenes
			.flatMap((scene) => scene.layers)
			.find((layer) => layer.kind === "broll-media");
		expect(manualLayer?.motion).toMatchObject({
			activeRange: { startSec: 5.6, endSec: 9.1 },
			entrance: { family: "ken-burns" },
		});

		const automatic = planForPlacement("automatic-cutaway-0");
		if (automatic.status === "invalid") throw new Error(automatic.error.code);
		const automaticLayer = automatic.plan.targets[0]!.scenes
			.flatMap((scene) => scene.layers)
			.find((layer) => layer.kind === "broll-media");
		expect(automaticLayer?.motion).toBeNull();
	});

  test("keeps Ken Burns crop and scale phases orthogonal across mixed edges", () => {
    const motion = resolveCompositionMotion({
      motion: { entrance: "ken-burns-in", exit: "scale-out" },
      activeRange: { startSec: 0, endSec: 2 },
      clippingBounds: { x: 0, y: 0, width: 100, height: 200 },
    });
    if (!motion) throw new Error("expected resolved motion");

    expect(evaluateCompositionMotion(motion, 1)).toMatchObject({
      scale: 1,
      crop: { x: 6, y: 12, width: 88, height: 176 },
    });
    expect(evaluateCompositionMotion(motion, 2)).toMatchObject({
      scale: 1.08,
      crop: { x: 6, y: 12, width: 88, height: 176 },
    });
  });

  test("resolves every media-motion direction at exact short-interval boundaries", () => {
    const entrances = [
      ["fade", "fade", null],
      ["scale-in", "scale", "in"],
      ["pan-left", "pan", "left"],
      ["pan-right", "pan", "right"],
      ["pan-up", "pan", "up"],
      ["pan-down", "pan", "down"],
      ["ken-burns-in", "ken-burns", "in"],
    ] as const;
    const exits = [
      ["fade", "fade", null],
      ["scale-out", "scale", "out"],
      ["pan-left", "pan", "left"],
      ["pan-right", "pan", "right"],
      ["pan-up", "pan", "up"],
      ["pan-down", "pan", "down"],
      ["ken-burns-out", "ken-burns", "out"],
    ] as const;
    for (const [entrance, family, direction] of entrances) {
      const motion = resolveCompositionMotion({
        motion: { entrance, exit: "fade" },
        activeRange: { startSec: 2, endSec: 2.2 },
        clippingBounds: { x: 0, y: 0, width: 100, height: 200 },
      });
      expect(motion?.entrance).toMatchObject({
        family,
        direction,
        range: { startSec: 2, endSec: 2.1 },
      });
      expect(evaluateCompositionMotion(motion!, 2).animated).toBe(true);
    }
    for (const [exit, family, direction] of exits) {
      const motion = resolveCompositionMotion({
        motion: { entrance: "fade", exit },
        activeRange: { startSec: 2, endSec: 2.2 },
        clippingBounds: { x: 0, y: 0, width: 100, height: 200 },
      });
      expect(motion?.exit).toMatchObject({
        family,
        direction,
        range: { startSec: 2.1, endSec: 2.2 },
      });
      expect(evaluateCompositionMotion(motion!, 2.2).animated).toBe(true);
    }
    expect(resolveCompositionMotion({
      motion: { entrance: "none", exit: "none" },
      activeRange: { startSec: 2, endSec: 2.2 },
      clippingBounds: { x: 0, y: 0, width: 100, height: 200 },
    })).toBeNull();
  });

  test("suppresses a conflicting Scene entrance with one typed plan notice", () => {
    const sceneId = "8ab9d330-688f-4574-932c-27ac661245c1";
    const result = planClipComposition({
      document: editorDocumentSchema.parse({
        ...centerDocument(),
        clipStartSec: 0,
        clipEndSec: 3,
        deletedRanges: [],
        studioEdits: studioEditsSchema.parse({
          framing: { mode: "center" },
          transition: { type: "fade", durationSec: 0.4 },
        }),
        sceneBlocks: [{
          id: sceneId,
          schemaVersion: 1,
          anchorSec: 0,
          durationSec: 1,
          content: { kind: "color", color: "#111827" },
          motion: { entrance: "fade", exit: "none" },
          templateSnapshot: null,
        }],
      }),
      source: { identity: "source:conflict", kind: "video", width: 1920, height: 1080 },
      evidence: { automaticLayout: { state: "missing" } },
      assets: { backgroundImage: { state: "missing" } },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
      targets: [{ id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 }],
    });
    if (result.status === "invalid") throw new Error(result.error.code);
    const inserted = result.plan.targets[0]!.scenes[0]!.layers.find(
      (layer) => layer.kind === "inserted-scene",
    );
    expect(inserted?.kind === "inserted-scene" ? inserted.motion : "missing").toBeNull();
    expect(result.plan.notices).toContainEqual({
      code: "motion_scene_transition_conflict",
      fidelity: "degraded",
      targetId: "vertical",
      sceneId,
      effectiveFallback: "center",
      userActionPossible: true,
    });
  });
});
