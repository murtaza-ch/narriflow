import { describe, expect, test } from "bun:test";
import {
  CAPTION_BEHIND,
  captionPresetSchema,
  captionWordKey,
  editorDocumentSchema,
  getCaptionPresetById,
  studioEditsSchema,
} from "@narriflow/validators";
import { type CompositionCaptionVisualLayer, planClipComposition, splitLayoutInputFingerprint } from "./clip-composition-plan";

// Heroes behind the speaker (dynamic captions spec 5.12): `block.behind` and the target's `mattes`.

const depth = getCaptionPresetById("depth")!.preset;

/** Phrases of three words, 0.4 s per word, 0.6 s apart; the middle word is forced to be the hero. */
function transcript(phrases: number, startSec = 0.5) {
  const words: { word: string; startSec: number; endSec: number; confidence: number }[] = [];
  const emphasis: Record<string, "hero"> = {};
  let t = startSec;
  for (let phrase = 0; phrase < phrases; phrase++) {
    for (const [index, word] of ["the", "biggest", "secret"].entries()) {
      words.push({ word: index === 2 ? `${word}.` : word, startSec: t, endSec: t + 0.35, confidence: 1 });
      if (index === 1) emphasis[captionWordKey(t)] = "hero";
      t = Math.round((t + 0.4) * 1000) / 1000;
    }
    t = Math.round((t + 0.6) * 1000) / 1000;
  }
  return { words, emphasis };
}

function plan(input: {
  preset?: Record<string, unknown>;
  phrases?: number;
  deletedRanges?: { startSec: number; endSec: number }[];
  framing?: Record<string, unknown>;
  evidence?: Parameters<typeof planClipComposition>[0]["evidence"];
  capabilities?: Parameters<typeof planClipComposition>[0]["capabilities"];
  clipEndSec?: number;
}) {
  const { words, emphasis } = transcript(input.phrases ?? 2);
  const clipEndSec = input.clipEndSec ?? 8;
  const document = editorDocumentSchema.parse({
    version: 1, clipStartSec: 0, clipEndSec,
    captionPreset: captionPresetSchema.parse(input.preset ?? depth),
    transcriptSlice: [{
      index: 0, speaker: 0, speakerLabel: "Speaker 1", startSec: words[0]!.startSec, endSec: words.at(-1)!.endSec,
      text: words.map((word) => word.word).join(" "), confidence: 1, words,
    }],
    studioEdits: studioEditsSchema.parse({ framing: input.framing ?? { mode: "center" }, captionEmphasis: emphasis }),
    brollUrl: null,
    deletedRanges: input.deletedRanges ?? [],
  });
  const result = planClipComposition({
    document,
    captionLanguage: "en",
    source: { identity: "source:behind", kind: "video", width: 1920, height: 1080 },
    evidence: input.evidence ?? { automaticLayout: { state: "missing" } },
    assets: { backgroundImage: { state: "missing" }, music: { state: "missing" } },
    capabilities: input.capabilities ?? { automaticSpeakerLayout: false, automaticSpeakerEngineVersion: "shot-layout-v1" },
    targets: [{ id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 }],
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  return result.plan.targets[0]!;
}

const captions = (target: ReturnType<typeof plan>) =>
  target.visualLayers.filter((layer): layer is CompositionCaptionVisualLayer => layer.kind === "caption");

describe("block.behind", () => {
  test("Depth marks every cue with a hero, and only those", () => {
    const layers = captions(plan({}));
    expect(layers.length).toBe(2);
    for (const layer of layers) {
      expect(layer.block?.roles).toContain("hero");
      expect(layer.block?.behind).toBe(true);
    }
  });

  test("the toggle off, or a style that is not a centred stack, draws no cue behind and asks for no matte", () => {
    for (const preset of [{ ...depth, heroBehind: false }, { ...getCaptionPresetById("marker")!.preset, heroBehind: true }, { ...getCaptionPresetById("cutout")!.preset, heroBehind: true }]) {
      const target = plan({ preset });
      expect(captions(target).some((layer) => layer.block?.behind)).toBe(false);
      expect(target.mattes).toBeUndefined();
    }
  });

  test("a stack style with the toggle on behaves like Depth", () => {
    const target = plan({ preset: { ...getCaptionPresetById("headline")!.preset, heroBehind: true } });
    expect(captions(target).every((layer) => layer.block?.behind === true)).toBe(true);
    expect(target.mattes?.length).toBeGreaterThan(0);
  });
});

describe("mattes", () => {
  test("each hero's onset to its cue's end, padded, merged when close, with the visible crop as the region", () => {
    const target = plan({});
    const [first, second] = captions(target);
    const hero = (layer: CompositionCaptionVisualLayer) => layer.words[layer.block!.roles.indexOf("hero")]!.startSec;
    const ms = (value: number) => Math.round(value * 1000) / 1000;
    // Heroes at 0.9 s and 2.9 s; cue ends at 1.65 s and 3.65 s; padding 0.2 s keeps them apart.
    expect(target.mattes).toEqual([
      { sourceStartSec: ms(hero(first!) - CAPTION_BEHIND.paddingSec), sourceEndSec: ms(first!.activeRange.endSec + CAPTION_BEHIND.paddingSec), region: [{ x: 656, y: 0, width: 608, height: 1080 }] },
      { sourceStartSec: ms(hero(second!) - CAPTION_BEHIND.paddingSec), sourceEndSec: ms(second!.activeRange.endSec + CAPTION_BEHIND.paddingSec), region: [{ x: 656, y: 0, width: 608, height: 1080 }] },
    ]);
  });

  test("overlapping padded windows merge into one range", () => {
    const target = plan({ phrases: 2, preset: { ...depth, wordsPerCue: 2 } });
    const mattes = target.mattes!;
    for (let index = 1; index < mattes.length; index++) expect(mattes[index]!.sourceStartSec).toBeGreaterThan(mattes[index - 1]!.sourceEndSec);
  });

  test("ranges are mapped through cuts to source time and split at the cut", () => {
    // Cut 1.2 s to 1.4 s, inside the first cue (hero 0.9 s, cue end 1.65 s source).
    const target = plan({ deletedRanges: [{ startSec: 1.2, endSec: 1.4 }] });
    const mattes = target.mattes!;
    expect(mattes[0]!.sourceEndSec).toBeCloseTo(1.2, 3);
    expect(mattes[1]!.sourceStartSec).toBeCloseTo(1.4, 3);
    for (const matte of mattes) expect(matte.sourceEndSec).toBeGreaterThan(matte.sourceStartSec);
  });

  test("a two-up scene gives two regions; a window crossing into a single scene is split at the cut", () => {
    const engineVersion = "explicit-split-v1";
    const source = { identity: "source:behind" };
    const target = plan({
      framing: { mode: "split" },
      phrases: 3,
      clipEndSec: 8,
      evidence: {
        automaticLayout: { state: "missing" },
        splitLayout: {
          state: "available",
          value: {
            sourceIdentity: source.identity,
            inputFingerprint: splitLayoutInputFingerprint({ sourceIdentity: source.identity, clipStartSec: 0, clipEndSec: 8, deletedRanges: [], engineVersion }),
            engineVersion,
            source: "explicit-detector",
            segments: [
              { subjects: [{ id: "person-0", cxNorm: 0.2, cyNorm: 0.5, zoom: 1 }, { id: "person-1", cxNorm: 0.8, cyNorm: 0.5, zoom: 1 }], startSec: 0, endSec: 2.8, layout: "two-up", topCxNorm: 0.2, bottomCxNorm: 0.8 },
              { subjects: [{ id: "person-0", cxNorm: 0.72, cyNorm: 0.5, zoom: 1 }], startSec: 2.8, endSec: 8, layout: "single", cxNorm: 0.72 },
            ],
            fallbackSegments: [
              { subjects: [{ id: "person-0", cxNorm: 0.2, cyNorm: 0.5, zoom: 1 }], startSec: 0, endSec: 2.8, layout: "single", cxNorm: 0.2 },
              { subjects: [{ id: "person-0", cxNorm: 0.72, cyNorm: 0.5, zoom: 1 }], startSec: 2.8, endSec: 8, layout: "single", cxNorm: 0.72 },
            ],
          },
        },
      },
      capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: "shot-layout-v1", explicitSplitLayout: true, splitEngineVersion: engineVersion },
    });
    expect(target.effectiveMode).toBe("split");
    const mattes = target.mattes!;
    expect(mattes[0]!.region.length).toBe(2);
    expect(mattes[0]!.region[0]).not.toEqual(mattes[0]!.region[1]);
    expect(mattes.at(-1)!.region.length).toBe(1);
    // The second hero's window (2.7 s to 3.85 s) crosses the scene boundary at 2.8 s: it is split
    // there, each part with its scene's regions, so smoothing restarts at the camera cut.
    const atCut = mattes.findIndex((matte) => Math.abs(matte.sourceEndSec - 2.8) < 1e-6);
    expect(atCut).toBeGreaterThan(-1);
    expect(mattes[atCut]!.region.length).toBe(2);
    expect(mattes[atCut + 1]!.sourceStartSec).toBeCloseTo(2.8, 6);
    expect(mattes[atCut + 1]!.region.length).toBe(1);
    for (let index = 1; index < mattes.length; index++) expect(mattes[index]!.sourceStartSec).toBeGreaterThanOrEqual(mattes[index - 1]!.sourceEndSec);
  });
});
