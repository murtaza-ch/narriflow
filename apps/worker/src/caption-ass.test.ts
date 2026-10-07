import { describe, expect, test } from "bun:test";
import { deriveCaptionCues, planClipComposition, type CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import { CAPTION_PRESETS, captionPresetSchema, editorDocumentSchema, getCaptionPresetById, studioEditsSchema } from "@narriflow/validators";
import { serializeCaptionAss } from "./caption-ass";

function render(id: string, texts = ["READY", "TO", "GO"]) {
  const preset = getCaptionPresetById(id)!.preset;
  const cue: CompositionCaptionVisualLayer = {
    id: "caption:0", kind: "caption", cueIndex: 0,
    activeRange: { startSec: 0, endSec: 1.5 },
    anchor: { xPct: 50, yPct: 72 },
    destination: { x: 0, y: 0, width: 1080, height: 1920 },
    rotationDeg: 0, opacity: 1, zIndex: 40, preset,
    words: texts.map((text, index) => ({ text, emoji: null, startSec: index * 0.5, endSec: (index + 1) * 0.5 })),
  };
  return serializeCaptionAss({ layers: [cue], canvas: { width: 1080, height: 1920 } });
}

function events(ass: string) {
  return ass.split("\n").filter((line) => line.startsWith("Dialogue:")).map((line) => {
    const fields = line.split(",");
    return { layer: Number(fields[0]!.slice(10)), style: fields[3], text: fields.slice(9).join(",") };
  });
}

describe("caption ASS paint contract", () => {
  test("every catalog preset serializes without invalid numeric tags", () => {
    for (const preset of CAPTION_PRESETS) {
      const ass = render(preset.id);
      expect(ass).toContain("PlayResX: 1080");
      expect(ass).toContain("PlayResY: 1920");
      expect(ass).toContain("READY");
      expect(ass).not.toMatch(/NaN|Infinity|undefined/);
      expect(events(ass).length).toBeGreaterThan(0);
    }
  });

  test("Electric pills cover the active shadow and stay below its text", () => {
    const stack = events(render("electric"));
    const pill = stack.find((event) => event.style === "Shape")!;
    const active = stack.filter((event) => event.text.endsWith("READY") && event.layer > 5);
    expect(pill.layer).toBeGreaterThan(Math.min(...active.map((event) => event.layer)));
    expect(pill.layer).toBeLessThan(Math.max(...active.map((event) => event.layer)));
  });

  test("retains the sweep, letter reveal, flip, and glow export effects", () => {
    expect(render("karaoke")).toContain("\\kf50");
    expect(render("typewriter")).toContain("\\ko");
    expect(render("flip")).toContain("\\frx");
    expect(render("neon")).toContain("\\blur");
    expect(render("candy")).toContain("\\bord12");
    const block = events(render("block"));
    const extrusions = block.filter((event) => event.layer === 1);
    expect(extrusions.length).toBeGreaterThan(3);
    expect(new Set(extrusions.map((event) => event.text.match(/\\pos\(([^)]+)\)/)?.[1])).size)
      .toBeGreaterThan(1);
  });

  test("unsupported glyphs keep timed base text without measured decorations", () => {
    const stack = events(render("electric", ["READY💰", "TO", "GO"]));
    expect(stack.every((event) => event.style === "Caption" && event.layer <= 5)).toBe(true);
    expect(stack.some((event) => event.text.includes("READY💰"))).toBe(true);
  });

  test("transcript text cannot inject ASS override tags", () => {
    expect(render("karaoke", ["{\\pos(0,0)}READY"])).not.toContain("{\\pos(0,0)}");
    expect(serializeCaptionAss({ layers: [], canvas: { width: 1080, height: 1920 } })).toBe("");
  });
});

describe("burn-in and subtitle parity", () => {
  const scene = { schemaVersion: 1, id: "10000000-0000-4000-8000-000000000009", anchorSec: 0.7, durationSec: 2,
    content: { kind: "color", color: "#112233" }, motion: { entrance: "fade", exit: "fade", durationSec: 0.5 }, templateSnapshot: null };
  test.each([["without inserted scenes", []], ["with a scene splitting a cue", [scene]]] as const)("serialized caption text events cover exactly the subtitle cues %s", (_label, sceneBlocks) => {
    const word = (text: string, startSec: number, endSec: number) => ({ word: text, startSec, endSec, confidence: 0.9 });
    const document = editorDocumentSchema.parse({
      version: 1, clipStartSec: 0, clipEndSec: 12,
      captionPreset: captionPresetSchema.parse({ wordsPerCue: 3 }),
      transcriptSlice: [{ index: 0, speaker: 0, speakerLabel: "Speaker 1", confidence: 0.9, startSec: 0.5, endSec: 6.2, text: "Ready to go. Then we ship it.",
        words: [word("Ready", 0.5, 0.9), word("to", 1, 1.04), word("go.", 1.1, 1.13), word("Then", 3, 3.4), word("we", 3.5, 3.7), word("ship", 3.8, 4.4), word("it.", 6, 6.02)] }],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
      brollUrl: null, deletedRanges: [{ startSec: 4.6, endSec: 5.5 }], sceneBlocks,
    });
    const planned = planClipComposition({
      document, source: { identity: "source:ass-parity", kind: "video", width: 1920, height: 1080 },
      evidence: { automaticLayout: { state: "missing" } }, assets: { backgroundImage: { state: "missing" } },
      capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: "shot-layout-v1" },
      targets: [{ id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 }],
    });
    if (planned.status === "invalid") throw new Error(planned.error.code);
    const layers = planned.plan.targets[0]!.visualLayers.filter((layer): layer is CompositionCaptionVisualLayer => layer.kind === "caption");
    const ass = serializeCaptionAss({ layers, canvas: { width: 1080, height: 1920 } });
    const seconds = (value: string) => { const [h, m, s] = value.split(":"); return Number(h) * 3600 + Number(m) * 60 + Number(s); };
    const spans = ass.split("\n").filter((line) => line.startsWith("Dialogue:") && line.split(",")[3] === "Caption")
      .map((line) => ({ startSec: seconds(line.split(",")[1]!), endSec: seconds(line.split(",")[2]!) }))
      .sort((left, right) => left.startSec - right.startSec)
      .reduce<Array<{ startSec: number; endSec: number }>>((merged, span) => {
        const last = merged.at(-1);
        if (last && span.startSec <= last.endSec + 0.001) last.endSec = Math.max(last.endSec, span.endSec);
        else merged.push({ ...span });
        return merged;
      }, []);
    const cues = deriveCaptionCues(document);
    expect(cues.length).toBe(3 + sceneBlocks.length);
    expect(spans).toEqual(cues.map((cue) => ({ startSec: Math.round(cue.startSec * 100) / 100, endSec: Math.round(cue.endSec * 100) / 100 })));
  });
});
