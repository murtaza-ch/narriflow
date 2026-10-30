import { describe, expect, test } from "bun:test";
import { deriveCaptionCues, planClipComposition, type CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import { CAPTION_PRESETS, captionPresetSchema, editorDocumentSchema, getCaptionPresetById, studioEditsSchema } from "@narriflow/validators";
import { renderCaptionTrack } from "./caption-ass";

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
  return renderCaptionTrack({ layers: [cue], canvas: { width: 1080, height: 1920 } }).ass;
}

function track(id: string, words: Array<{ text: string; emoji: string | null }>) {
  const preset = getCaptionPresetById(id)!.preset;
  const cue: CompositionCaptionVisualLayer = {
    id: "caption:0", kind: "caption", cueIndex: 0,
    activeRange: { startSec: 0, endSec: words.length * 0.5 },
    anchor: { xPct: 50, yPct: 72 },
    destination: { x: 0, y: 0, width: 1080, height: 1920 },
    rotationDeg: 0, opacity: 1, zIndex: 40, preset,
    words: words.map((word, index) => ({ ...word, startSec: index * 0.5, endSec: (index + 1) * 0.5 })),
  };
  return renderCaptionTrack({ layers: [cue], canvas: { width: 1080, height: 1920 } });
}

function cue(id: string, words: Array<string | { text: string; spaceBefore?: boolean }>, options: { language?: string | null; yPct?: number } = {}) {
  const preset = getCaptionPresetById(id)!.preset;
  const layer: CompositionCaptionVisualLayer = {
    id: "caption:0", kind: "caption", cueIndex: 0,
    activeRange: { startSec: 0, endSec: words.length * 0.5 },
    anchor: { xPct: 50, yPct: options.yPct ?? 72 },
    destination: { x: 0, y: 0, width: 1080, height: 1920 },
    rotationDeg: 0, opacity: 1, zIndex: 40, preset,
    words: words.map((word, index) => ({ ...(typeof word === "string" ? { text: word } : word), emoji: null, startSec: index * 0.5, endSec: (index + 1) * 0.5 })),
    language: options.language ?? null,
  };
  return renderCaptionTrack({ layers: [layer], canvas: { width: 1080, height: 1920 } });
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

  test("text drawn by a fallback face is measured like any other: pill and overlay stay", () => {
    const result = track("electric", [{ text: "READY💰", emoji: null }, { text: "TO", emoji: null }, { text: "GO", emoji: null }]);
    expect(result.geometryUnavailable).toEqual([]);
    expect(events(result.ass).some((event) => event.style === "Shape")).toBe(true);
    // The money bag is not in Montserrat: it is drawn by the pinned monochrome emoji face, switched in and out explicitly.
    expect(events(result.ass).some((event) => /READY\{\\fnNoto Emoji Regular\\fs[\d.]+\}💰\{\\fnAnton Regular\\fs[\d.]+\}/.test(event.text))).toBe(true);
  });

  test("Latin text carries no font overrides and fallback runs name pinned faces", () => {
    expect(events(render("electric", ["READY", "TO", "GO"])).some((event) => event.text.includes("\\fn", event.text.indexOf("}")))).toBe(false);
    const arabic = render("electric", ["مرحبا"]);
    expect(arabic).toContain("{\\fnNoto Sans Arabic Regular\\fs");
    expect(arabic).not.toMatch(/Geeza|Nastaliq/);
    const mixed = render("electric", ["Hi你好"]);
    expect(mixed).toContain("{\\fnNoto Sans SC\\fs");
    expect(render("electric", ["안녕"])).toContain("{\\fnNoto Sans KR\\fs");
  });

  test("a long cue drawn by fallback faces still fits the frame", () => {
    const size = (ass: string) => Number(/\\fs([\d.]+)\\fsp/.exec(ass)![1]);
    const short = size(render("electric", ["你好"]));
    const long = size(render("electric", ["你好世界你好世界", "こんにちはこんにちは", "안녕하세요안녕하세요"]));
    expect(long).toBeLessThan(short);
  });

  test("a code point no pinned face has is left out alone and recorded, the cue still renders", () => {
    const result = track("electric", [{ text: "hel\u{13000}lo", emoji: null }, { text: "world", emoji: null }]);
    expect(result.omitted).toEqual([{ codePoint: "U+13000", cueIndex: 0 }]);
    expect(result.ass).not.toContain("\u{13000}");
    expect(result.ass).toContain("hello");
    expect(result.ass).toContain("world");
  });

  test("libass-reported code points are forced out of the text on a re-render", () => {
    const preset = getCaptionPresetById("electric")!.preset;
    const cue: CompositionCaptionVisualLayer = {
      id: "caption:0", kind: "caption", cueIndex: 2, activeRange: { startSec: 0, endSec: 1 }, anchor: { xPct: 50, yPct: 72 },
      destination: { x: 0, y: 0, width: 1080, height: 1920 }, rotationDeg: 0, opacity: 1, zIndex: 40, preset,
      words: [{ text: "AB\u2605", emoji: null, startSec: 0, endSec: 1 }],
    };
    const retried = renderCaptionTrack({ layers: [cue], canvas: { width: 1080, height: 1920 }, omitCodePoints: new Set([0x2605]) });
    expect(retried.ass).not.toContain("\u2605");
    expect(retried.ass).toContain("AB");
    expect(retried.omitted).toEqual([{ codePoint: "U+2605", cueIndex: 2 }]);
  });

  test("ZWJ, flag and skin-tone clusters are one typewriter letter", () => {
    const { ass, notices } = track("typewriter", [{ text: "👨\u200d👩\u200d👧", emoji: null }]);
    for (const event of events(ass).filter((candidate) => candidate.text.includes("\\ko"))) expect(event.text.match(/\\ko\d+/g)).toHaveLength(1);
    expect(notices.some((notice) => notice.code === "glyph_fallback_used" && notice.sequenceSplit)).toBe(true);
  });

  test("the active word's emoji is an atlas overlay above the word, not ASS text", () => {
    const { ass, emoji } = track("electric", [{ text: "MONEY", emoji: "💰" }, { text: "NOW", emoji: null }]);
    expect(ass).not.toContain("💰");
    expect(emoji).toHaveLength(1);
    const [overlay] = emoji;
    expect(overlay).toMatchObject({ key: "1f4b0", startSec: 0, endSec: 0.5, rotationDeg: 0 });
    // Bottom edge on the line box top (0.8em above the word), centred on the word, inside the 1080x1920 canvas.
    expect(overlay!.centerY + overlay!.heightPx / 2).toBeLessThan(0.72 * 1920);
    expect(overlay!.centerX).toBeGreaterThan(0);
    expect(overlay!.centerX).toBeLessThan(1080 / 2);
    expect(overlay!.widthPx / overlay!.heightPx).toBeCloseTo(1, 5);
  });

  test("a plan emoji outside the atlas falls back to a monochrome glyph or is skipped, never failing the render", () => {
    const fallback = track("electric", [{ text: "HELLO", emoji: "\u{1F600}" }]);
    expect(fallback.emoji).toHaveLength(0);
    expect(fallback.ass).toContain("\\fnNoto Emoji Regular");
    expect(fallback.notices).toEqual([expect.objectContaining({ code: "glyph_fallback_used", cluster: "\u{1F600}" })]);
    expect(fallback.emojiSkipped).toEqual([]);
    const flag = track("electric", [{ text: "HELLO", emoji: "🇵🇰" }]);
    expect(flag.emoji).toHaveLength(0);
    expect(flag.emojiSkipped).toEqual([{ emoji: "🇵🇰", cueIndex: 0 }]);
    expect(flag.ass).toContain("HELLO");
    expect(track("electric", [{ text: "HELLO", emoji: "\u{13000}" }]).emojiSkipped).toEqual([{ emoji: "\u{13000}", cueIndex: 0 }]);
  });

  test("transcript text cannot inject ASS override tags", () => {
    expect(render("karaoke", ["{\\pos(0,0)}READY"])).not.toContain("{\\pos(0,0)}");
    expect(renderCaptionTrack({ layers: [], canvas: { width: 1080, height: 1920 } }).ass).toBe("");
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
    const ass = renderCaptionTrack({ layers, canvas: { width: 1080, height: 1920 } }).ass;
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

describe("multilingual burn-in", () => {
  const pos = (text: string) => {
    const match = /\\pos\(([\d.]+),([\d.]+)\)/.exec(text)!;
    return { x: Number(match[1]), y: Number(match[2]) };
  };
  const firstPill = (ass: string) => events(ass).filter((event) => event.style === "Shape").map((event) => ({ ...pos(event.text), event }))
    .find((candidate) => candidate.event.text.includes("\\p1"));

  test("the Caption style asks libass for automatic base direction", () => {
    expect(cue("electric", ["READY"]).ass).toMatch(/^Style: Caption,.*,-1$/m);
  });

  test("the cue's language picks Noto Sans JP, Noto Sans TC and Nastaliq before the generic faces", () => {
    const faces = (ass: string) => [...new Set([...ass.matchAll(/\\fn(Noto[^\\}]*)/g)].map((match) => match[1]))];
    expect(faces(cue("electric", ["今日は"], { language: "ja" }).ass)).toEqual(["Noto Sans JP"]);
    expect(faces(cue("electric", ["今日は"], { language: "zh" }).ass)).toEqual(["Noto Sans SC"]);
    expect(faces(cue("electric", ["我哋"], { language: "yue" }).ass)).toEqual(["Noto Sans TC"]);
    expect(faces(cue("electric", ["زبان"], { language: "ur" }).ass)).toEqual(["Noto Nastaliq Urdu Regular"]);
    expect(faces(cue("electric", ["زبان"], { language: "ar" }).ass)).toEqual(["Noto Sans Arabic Regular"]);
    expect(faces(cue("electric", ["زبان"]).ass)).toEqual(["Noto Sans Arabic Regular"]);
  });

  test("an RTL cue puts the first word rightmost and its pill on the word the viewer sees", () => {
    const first = firstPill(cue("electric", ["مرحبا", "بالعالم", "في"]).ass)!;
    const second = events(cue("electric", ["مرحبا", "بالعالم", "في"]).ass).filter((event) => event.style === "Shape" && event.text.includes("\\p1"));
    expect(first.x).toBeGreaterThan(540);
    const xs = second.map((event) => pos(event.text).x);
    expect(xs).toHaveLength(3);
    expect(xs[0]!).toBeGreaterThan(xs[1]!);
    expect(xs[1]!).toBeGreaterThan(xs[2]!);
  });

  test("an LTR cue still walks left to right", () => {
    const xs = events(cue("electric", ["READY", "TO", "GO"]).ass).filter((event) => event.style === "Shape" && event.text.includes("\\p1")).map((event) => pos(event.text).x);
    expect(xs[0]!).toBeLessThan(xs[1]!);
    expect(xs[1]!).toBeLessThan(xs[2]!);
  });

  test("words without a space before them abut; a provider space is kept", () => {
    const base = events(cue("karaoke", [{ text: "今日" }, { text: "は", spaceBefore: false }, { text: "天気", spaceBefore: false }], { language: "ja" }).ass).find((event) => event.layer === 5)!;
    expect(base.text).not.toMatch(/[}ぁ-んー今日天気] +[{ぁ-ん今日天気]/);
    const spaced = events(cue("karaoke", [{ text: "สวัสดี" }, { text: "ครับ", spaceBefore: true }]).ass).find((event) => event.layer === 5)!;
    expect(spaced.text).toContain("} {");
  });

  test("cursive and complex scripts reveal typewriter text by word; Latin keeps per-letter reveal", () => {
    for (const text of ["مرحبا", "क्षत्रिय", "สวัสดี", "বাংলা"]) {
      expect(cue("typewriter", [text]).ass).not.toContain("\\ko");
    }
    expect(cue("typewriter", ["READY"]).ass).toContain("\\ko");
  });

  test("an RTL karaoke word sweeps with a clip growing from its right edge; an LTR word keeps libass's \\kf", () => {
    const rtl = cue("karaoke", ["مرحبا", "بالعالم"]).ass;
    expect(rtl).not.toContain("\\kf");
    const sweep = events(rtl).filter((event) => event.text.includes("\\clip("));
    expect(sweep.length).toBeGreaterThan(0);
    for (const event of sweep) {
      const [, startRight, , endLeft, endRight] = /\\clip\(([\d.]+),0,([\d.]+),\d+\)\\t\(0,500,\\clip\(([\d.]+),0,([\d.]+),\d+\)\)/.exec(event.text)!.slice(0, 5).map(Number) as [number, number, number, number, number];
      expect(endLeft).toBeLessThan(startRight);
      expect(endRight).toBeCloseTo(startRight, 1);
    }
    const ltr = cue("karaoke", ["READY", "GO"]).ass;
    expect(ltr).toContain("\\kf50");
    expect(ltr).not.toContain("\\clip(");
  });

  test("a Latin word in an RTL line sweeps with \\kf, an Arabic word in a Latin line with the clip", () => {
    expect(cue("karaoke", ["مرحبا", "Narriflow"]).ass).toContain("\\kf50");
    expect(cue("karaoke", ["Hello", "مرحبا"]).ass).toContain("\\clip(");
  });

  test("complex-script gaps take no letter spacing; Latin gaps keep it", () => {
    const text = (words: string[]) => events(cue("karaoke", words).ass).find((event) => event.layer === 5)!.text;
    expect(text(["مرحبا", "بالعالم"])).toContain("{\\fsp0} {");
    expect(text(["READY", "GO"])).not.toContain("{\\fsp0}");
  });

  test("an overlay holding one word sits at its own baseline when its faces' metrics differ from the line's", () => {
    const result = cue("electric", ["زبان", "READY"]);
    const overlay = events(result.ass).filter((event) => event.layer === 11);
    const latinOverlay = overlay.find((event) => event.text.endsWith("READY"))!;
    const line = events(result.ass).find((event) => event.layer === 5)!;
    expect(pos(latinOverlay.text).y).not.toBeCloseTo(pos(line.text).y, 1);
  });
});
