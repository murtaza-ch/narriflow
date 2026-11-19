import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CompositionCaptionVisualLayer, planClipComposition } from "@narriflow/composition-plan";
import { captionPresetSchema, editorDocumentSchema, getCaptionPresetById, studioEditsSchema } from "@narriflow/validators";

/**
 * The dynamic caption fixture cases (spec section 9) as caption layers, built
 * through the real composition plan so the worker paints what an export would.
 * Shared by `caption-frames.ts` and the real-libass block test.
 */

export const DYNAMIC_CAPTION_FIXTURES_DIRECTORY = fileURLToPath(
  new URL("../../../packages/composition-plan/src/__fixtures__/dynamic-captions", import.meta.url),
);

/**
 * Pinned 1080x1920 frames the cases are burned over, stored at 540x960 and scaled 2x. They are the
 * Studio's own preset backdrops `dark-studio`, `bright-room` and `brick-street` (apps/web/public/images/caption-backdrops).
 */
export const DYNAMIC_CAPTION_BACKGROUNDS = ["dark", "bright", "busy"] as const;
export type DynamicCaptionBackground = (typeof DYNAMIC_CAPTION_BACKGROUNDS)[number];

export function dynamicCaptionBackgroundPath(background: DynamicCaptionBackground): string {
  return join(DYNAMIC_CAPTION_FIXTURES_DIRECTORY, "backgrounds", `${background}.jpg`);
}

interface FixtureWord {
  readonly word: string;
  readonly key: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly spaceBefore?: boolean;
}

export interface DynamicCaptionFixture {
  readonly id: string;
  readonly presetId: string;
  readonly preset: Record<string, unknown>;
  readonly language: string;
  readonly words: readonly FixtureWord[];
  readonly overrides: Record<string, "hero" | "pair" | "plain">;
}

export const CANVAS = { width: 1080, height: 1920 } as const;

export function dynamicCaptionFixtures(): readonly DynamicCaptionFixture[] {
  const manifest = JSON.parse(readFileSync(join(DYNAMIC_CAPTION_FIXTURES_DIRECTORY, "manifest.json"), "utf8")) as {
    cases: DynamicCaptionFixture[];
  };
  return manifest.cases;
}

/** The case's caption layers on a 1080x1920 target: one utterance, normally one cue. */
export function dynamicCaptionLayers(fixture: DynamicCaptionFixture): CompositionCaptionVisualLayer[] {
  const named = getCaptionPresetById(fixture.presetId);
  if (!named) throw new Error(`${fixture.id}: unknown preset ${fixture.presetId}`);
  const words = fixture.words;
  const document = editorDocumentSchema.parse({
    version: 1,
    clipStartSec: 0,
    clipEndSec: Math.ceil(words[words.length - 1]!.endSec) + 1,
    captionPreset: captionPresetSchema.parse({ ...named.preset, ...fixture.preset }),
    transcriptSlice: [
      {
        index: 0,
        speaker: 0,
        speakerLabel: "Speaker 1",
        startSec: words[0]!.startSec,
        endSec: words[words.length - 1]!.endSec,
        text: words.map((word) => word.word).join(" "),
        confidence: 1,
        words: words.map(({ key: _key, ...word }) => ({ ...word, confidence: 1 })),
      },
    ],
    studioEdits: studioEditsSchema.parse({
      framing: { mode: "center" },
      ...(Object.keys(fixture.overrides).length > 0 ? { captionEmphasis: fixture.overrides } : {}),
    }),
    brollUrl: null,
    deletedRanges: [],
  });
  const result = planClipComposition({
    document,
    captionLanguage: fixture.language,
    source: { identity: `source:${fixture.id}`, kind: "video", width: 1920, height: 1080 },
    evidence: { automaticLayout: { state: "missing" } },
    assets: { backgroundImage: { state: "missing" }, music: { state: "missing" } },
    capabilities: { automaticSpeakerLayout: false, automaticSpeakerEngineVersion: "shot-layout-v1" },
    targets: [{ id: "vertical", aspectRatio: "9:16", width: CANVAS.width, height: CANVAS.height }],
  });
  if (result.status === "invalid") throw new Error(`${fixture.id}: ${result.error.code}`);
  return result.plan.targets[0]!.visualLayers.flatMap((layer): CompositionCaptionVisualLayer[] => (layer.kind === "caption" ? [layer] : []));
}
