import { describe, expect, test } from "bun:test";
import type { CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import { CAPTION_PRESETS, getCaptionPresetById } from "@narriflow/validators";
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
