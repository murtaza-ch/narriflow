import { describe, expect, test } from "bun:test";
import { captionSceneMeta, getCaptionPresetById } from "@narriflow/validators";
import { describeSpeechConformance, fastRun } from "./conformance-support";
import { demoCues, sceneEdgeDemo } from "./demo";
import { exportFrameAtOrAfter, exportFrameAtOrBefore, exportFrameTimes } from "./frame-grid";
import { evaluatePiece, pieceBounds, SCENE_PIECE_BUDGET, type Piece } from "./scene";
import { buildCaptionScene, captionSceneDemo } from "./registry";
import { SQUASH_DEMO, squashHash, squashLines, squashPlans } from "./templates/squash";
import { ease, kf } from "./ease";
import { fakeMeasure, sceneInput } from "./test-support";

describeSpeechConformance("squash", (await import("./templates/squash")).squashProgram, { anchorLineY: 1470 });

const build = (cues: ReturnType<typeof demoCues>["cues"], overrides: Parameters<typeof sceneInput>[1] = {}) =>
  buildCaptionScene("squash", sceneInput(cues, { anchor: { xPct: 50, yPct: (1470 / 1920) * 100 }, ...overrides })).pieces;
const piece = (pieces: readonly Piece[], id: string) => pieces.find((p) => p.id === id);

describe("Squash", () => {
  test("the preset and sample register the tall condensed face, the floor as anchor and the ink and paper colours", () => {
    expect(getCaptionPresetById("squash")!.preset).toMatchObject({ scene: "squash", fontName: "Anton" });
    expect(captionSceneMeta("squash")).toMatchObject({ bodyPx: 168, anchorLineY: 1470, colours: { primary: "#FFFFFF", accent: "#0B0B0C" } });
  });

  test("rows come from the words: at most three a line, a key word closes its line with at most one companion", () => {
    const full = () => 1;
    expect(squashLines(["minor", "body", "body", "body", "body"], full)).toEqual([[0, 1, 2], [3, 4]]);
    expect(squashLines(["minor", "body", "body", "hero", "body"], full)).toEqual([[0, 1, 2], [3], [4]]);
    expect(squashLines(["minor", "body", "hero"], full)).toEqual([[0, 1], [2]]);
    expect(squashLines(["body", "hero", "body"], full)).toEqual([[0, 1], [2]]);
    expect(squashLines(["body", "hero", "hero", "body"], full)).toEqual([[0, 1, 2], [3]]);
    // A line that would have to shrink under 70 % of its cap breaks (85 % for a third word).
    expect(squashLines(["body", "body", "body"], (words) => (words.length === 2 ? 0.8 : 0.8))).toEqual([[0, 1], [2]]);
    expect(squashLines(["body", "body"], (words) => (words.length === 2 ? 0.6 : 1))).toEqual([[0], [1]]);
    expect(squashLines([], full)).toEqual([]);
    // Every word is on exactly one line, in order, for any role string.
    const roles = ["minor", "hero", "body", "body", "hero", "hero", "minor", "body", "body", "minor"] as const;
    expect(squashLines(roles, () => 0.9).flat()).toEqual(roles.map((_, i) => i));
  });

  test("a word stretches along the sample's keyframes: 0.1 at the lead, 1.07 at the peak, 0.98, then 1", () => {
    const { cues } = demoCues({ lines: ["slow:b@900 words:b@900"], options: { lead: 1000 } });
    const first = cues[0]!.words[0]!;
    const pieces = build(cues);
    const face = piece(pieces, "squash:0:w0")!;
    // Lead 80 ms, 230 ms rise (the word is long enough for the sample's full curve).
    const from = first.startMs - 80;
    const sample = (t: number) => kf(t, [[from, 0.1], [from + 230, 1.07, "out"], [from + 350, 0.98, "inOut"], [from + 440, 1, "inOut"]]);
    for (const dt of [0, 40, 120, 230, 290, 350, 400, 440, 600]) expect(evaluatePiece(face, from + dt).sy).toBeCloseTo(sample(from + dt), 1);
    expect(ease("out", 0.5)).toBeGreaterThan(0.5);
  });

  test("the plate is black then white, the words ink the other way, and it sits on the anchor line with the sample's padding", () => {
    const { cues } = captionSceneDemo("squash");
    const pieces = build(cues, { colours: { primary: "#FFFFFF", highlight: "#FFE600", accent: "#0B0B0C", shadow: "#000000" } });
    const colour = (id: string) => {
      const p = piece(pieces, id)!;
      return p.kind === "shape" ? p.fill!.colour : p.fill;
    };
    expect([0, 1, 2, 3].map((n) => colour(`squash:${n}:plate`))).toEqual(["#0B0B0C", "#FFFFFF", "#0B0B0C", "#FFFFFF"]);
    expect([0, 1].map((n) => colour(`squash:${n}:w0`))).toEqual(["#FFFFFF", "#0B0B0C"]);
    const plate = piece(pieces, "squash:0:plate")!;
    const rest = pieceBounds(plate, cues[0]!.endMs - 300, fakeMeasure)!;
    // The plate's floor: anchor line 1470 plus the 34 px padding; centred on 540.
    expect(rest.y2).toBeCloseTo(1470 + 34, 0);
    expect((rest.x1 + rest.x2) / 2).toBeCloseTo(540, 0);
  });

  test("a pushed line squashes only after its words were spoken and read, then its wide copy opens and the tall one is gone", () => {
    const { cues } = demoCues({ lines: ["keep:b@300 going:b@300 now:h@300"], options: { cueGap: 0 } });
    const [a, b] = [cues[0]!.words[0]!, cues[0]!.words[2]!];
    const pieces = build(cues);
    // Two lines: [keep going] [now].
    const tall = piece(pieces, "squash:0:w1")!;
    const wide = piece(pieces, "squash:0:wide0")!;
    expect(wide).toBeDefined();
    const morph = Math.max(b.startMs, cues[0]!.words[1]!.endMs + 150);
    // Full height until the squash starts, none of the wide copy before the tall one has shut.
    expect(evaluatePiece(tall, morph - 1).sy).toBeGreaterThan(0.99);
    expect(wide.fromMs).toBeGreaterThanOrEqual(morph + 110);
    expect(evaluatePiece(tall, morph + 60).sy).toBeLessThan(0.9);
    expect(tall.toMs).toBeLessThanOrEqual(wide.fromMs);
    expect(a.startMs).toBeLessThan(morph);
  });

  test("a cue first paints no earlier than the end of the cue it replaces; the cue before is cut on that frame", () => {
    const plans = squashPlans(fastRun(0), 30);
    for (let n = 1; n < plans.length; n++) {
      expect(plans[n]!.from).toBeGreaterThanOrEqual(fastRun(0)[n - 1]!.words.at(-1)!.endMs);
      expect(plans[n - 1]!.to).toBeLessThanOrEqual(Math.ceil((plans[n]!.from * 30) / 1000) * (1000 / 30) + 1);
    }
    // With room the incoming strip keeps the sample's 80 ms lead.
    const roomy = squashPlans(demoCues(SQUASH_DEMO).cues, 30);
    expect(roomy[1]!.from).toBe(demoCues(SQUASH_DEMO).cues[1]!.words[0]!.startMs - 80);
  });

  test("a long clip keeps its beats on every cue and varies them: tabs and skid marks, sides, widths and styles", () => {
    const cues = Array.from({ length: 6 }, () => fastRun(60)).flatMap((run, n) => run.map((cue) => ({ ...cue, index: cue.index + n * 12, startMs: cue.startMs + n * 20000, endMs: cue.endMs + n * 20000, words: cue.words.map((w) => ({ ...w, startMs: w.startMs + n * 20000, endMs: w.endMs + n * 20000 })) })));
    expect(cues.length).toBeGreaterThanOrEqual(60);
    const pieces = build(cues);
    for (let n = 0; n < cues.length; n++) {
      expect(piece(pieces, `squash:${n}:plate`), `plate ${n}`).toBeDefined();
      expect(piece(pieces, `squash:${n}:tab`), `tab ${n}`).toBeDefined();
      expect(pieces.some((p) => p.id.startsWith(`squash:${n}:skid`)), `skid ${n}`).toBe(true);
    }
    const tabs = pieces.filter((p) => p.id.endsWith(":tab") && p.kind === "shape");
    const widths = new Set(tabs.map((p) => Math.round(pieceBounds(p, p.toMs - 1, fakeMeasure)!.x2 - pieceBounds(p, p.toMs - 1, fakeMeasure)!.x1)));
    expect(widths.size).toBeGreaterThan(2);
    const centreOf = (p: Piece) => {
      const box = pieceBounds(p, Math.min(p.fromMs + 400, p.toMs - 1), fakeMeasure)!;
      return Math.sign(Math.round((box.x1 + box.x2) / 2 - 540));
    };
    const sides = new Set(tabs.map(centreOf));
    expect(sides.size).toBeGreaterThan(1);
    // Styles: flat dashes, slanted ticks (a turn), dots (a third piece per group).
    const skidStyles = new Set(
      pieces
        .filter((p) => /:skid\d[a-c]$/.test(p.id) && p.kind === "shape")
        .map((p) => {
          const box = pieceBounds(p, p.fromMs + 1, fakeMeasure) ?? pieceBounds(p, p.toMs - 1, fakeMeasure)!;
          const flat = box.x2 - box.x1 > 2 * (box.y2 - box.y1);
          return `${flat}:${Math.round(evaluatePiece(p, p.fromMs + 1).rz)}`;
        }),
    );
    expect(skidStyles.size).toBeGreaterThan(2);
    // Hero cues get the highlight tab, the others the text colour.
    const heroTab = tabs.find((p) => cues[Number(p.id.split(":")[1])]!.words.some((w) => w.role === "hero"))!;
    expect(heroTab.kind === "shape" && heroTab.fill!.colour).toBe("#FFE9A8");
  });

  test("everything stays deterministic: no random numbers, the same cues build the same pieces", () => {
    const cues = fastRun(60);
    expect(JSON.stringify(build(cues))).toBe(JSON.stringify(build(cues)));
    expect(squashHash("a")).not.toBe(squashHash("b"));
  });

  test("a nine word cue wraps into lines, keeps every word whole and stays inside the piece budget", () => {
    const { cues } = sceneEdgeDemo("nine-words");
    const pieces = build(cues);
    const first = pieces.filter((p) => p.id.startsWith("squash:0:"));
    expect(first.length).toBeLessThanOrEqual(SCENE_PIECE_BUDGET);
    const faces = first.filter((p): p is Extract<Piece, { kind: "text" }> => p.kind === "text" && /^squash:0:w\d+$/.test(p.id));
    expect(faces.map((p) => p.text.toLowerCase())).toEqual(cues[0]!.words.map((w) => w.text.toLowerCase()));
    expect(new Set(faces.map((p) => p.sizePx)).size).toBeGreaterThan(1);
  });

  test("caps for cased scripts only; joined scripts stay whole and run right to left, landing from the right", () => {
    const urdu = sceneEdgeDemo("urdu");
    const pieces = build(urdu.cues);
    const faces = pieces.filter((p): p is Extract<Piece, { kind: "text" }> => p.kind === "text" && /^squash:0:w\d+$/.test(p.id));
    expect(faces.map((p) => p.text)).toEqual(urdu.cues[0]!.words.map((w) => w.text));
    // The first spoken word of the first line is the rightmost of its line.
    const x = (id: string) => pieceBounds(piece(pieces, id)!, piece(pieces, id)!.fromMs + 600, fakeMeasure)!.x1;
    expect(x("squash:0:w0")).toBeGreaterThan(x("squash:0:w1"));
    const turkish = demoCues({ lines: ["it:b@300 işte:b@300"], language: "tr" });
    const tr = build(turkish.cues).filter((p): p is Extract<Piece, { kind: "text" }> => p.kind === "text" && /^squash:0:w\d+$/.test(p.id));
    expect(tr.map((p) => p.text)).toEqual(["İT", "İŞTE"]);
  });

  test("a cue starting while another is still spoken stacks above it and neither covers the other", () => {
    const { cues } = demoCues({ lines: ["first:b@600 late:b@600", "wait:b@500"], options: { lead: 400, gap: 0, cueGap: 0 } });
    const run = [cues[0]!, { ...cues[1]!, startMs: 700, endMs: 1600, words: cues[1]!.words.map((w) => ({ ...w, startMs: 700, endMs: 1200 })) }];
    const pieces = build(run, { fps: 30 });
    const a = pieceBounds(piece(pieces, "squash:0:plate")!, 1000, fakeMeasure)!;
    const b = pieceBounds(piece(pieces, "squash:1:plate")!, 1000, fakeMeasure)!;
    expect(b.y2).toBeLessThan(a.y1);
  });

  test("the exit squash waits for the last word to be spoken and read; with no room it is a cut", () => {
    const { cues } = demoCues({ lines: ["so:b@300 it:b@300"], options: { tail: 900 } });
    const plate = piece(build(cues), "squash:0:plate")!;
    const end = cues[0]!.words[1]!.endMs;
    // Whole until the last word has been spoken and read for 150 ms, then squashed into its floor.
    const rest = evaluatePiece(plate, end + 100).sy;
    expect(evaluatePiece(plate, end + 140).sy).toBeCloseTo(rest, 3);
    expect(evaluatePiece(plate, plate.toMs - 2).sy).toBeLessThan(rest * 0.5);
    const tight = demoCues({ lines: ["go:b@150", "now:b@150"], options: { cueGap: 0, gap: 0 } }).cues;
    const face = piece(build(tight, { fps: 30 }), "squash:0:w0")!;
    expect(evaluatePiece(face, exportFrameAtOrBefore(face.toMs - 1, 30)).sy).toBeGreaterThan(0.9);

    const demo = demoCues(SQUASH_DEMO).cues;
    const hero = piece(build(demo, { fps: 30 }), "squash:0:w3")!;
    for (const t of exportFrameTimes(demo[0]!.words[3]!.endMs, hero.toMs, 30)) expect(evaluatePiece(hero, t).sy).toBeGreaterThan(0.95);
  });

  test("a one-frame cue keeps its full-height word on a static plate", () => {
    const fps = 24;
    const { cues } = demoCues({ lines: ["yes:b@110", "no:h@70", "wait:b@100"], options: { lead: 400, gap: 0, cueGap: 0, tail: 450 } });
    const pieces = build(cues, { fps, colours: { primary: "#FFFFFF", accent: "#0B0B0C", highlight: "#FFE600", shadow: "#000000" } });
    const word = piece(pieces, "squash:1:w0")!;
    const plate = piece(pieces, "squash:1:plate")!;
    expect(exportFrameTimes(word.fromMs, word.toMs, fps)).toEqual([542]);
    expect(evaluatePiece(word, 542).sy).toBe(1);
    expect(plate?.kind === "shape" && plate.fill?.colour).toBe("#FFFFFF");
    expect(evaluatePiece(plate, 542)).toEqual(evaluatePiece(plate, plate.fromMs));
    const paper = pieceBounds(plate, 542, fakeMeasure)!;
    const ink = pieceBounds(word, 542, fakeMeasure)!;
    expect(paper.x1).toBeLessThan(ink.x1);
    expect(paper.x2).toBeGreaterThan(ink.x2);
    expect(paper.y1).toBeLessThan(ink.y1);
    expect(paper.y2).toBeGreaterThan(ink.y2);
    for (const id of ["tab", "skid0a", "skid0b"]) {
      expect(piece(pieces, `squash:1:${id}`)).toBeUndefined();
    }
  });

  test("a mixed RTL row reveals the whole Latin word by its spoken onset", () => {
    const fps = 30;
    const { cues } = demoCues({ lines: ["یہ:b@90 AI:b@80 GPT:b@80 مثال:h@120"], language: "ur", options: { lead: 407, gap: 0, tail: 450 } });
    const measure: typeof fakeMeasure = (text, face, size, ls) => ({
      ...fakeMeasure(text, face, size, ls),
      advance: [...text].reduce((width, c) => width + (c === "I" ? 0.22 : c === "A" || c === " " ? 0.34 : 0.48) * size, 0),
    });
    const pieces = build(cues, { fps, measure });
    const words = cues[0]!.words;
    const ai = piece(pieces, "squash:0:w1")!;
    const t = exportFrameAtOrAfter(words[1]!.startMs, fps);
    expect(t).toBe(500);
    expect(pieceBounds(ai, t, measure)).toEqual(pieceBounds({ ...ai, clip: undefined }, t, measure));
    const gptAt = exportFrameAtOrAfter(words[2]!.startMs, fps);
    expect(evaluatePiece(ai, gptAt).x).toBeLessThan(evaluatePiece(piece(pieces, "squash:0:w2")!, gptAt).x);
  });

  test("the plate clears a fallback word that stretches taller than the first word of its row", () => {
    const { cues } = demoCues({ lines: ["یہ:b@90 بہت:b@350"], language: "ur", options: { lead: 400, gap: 0, tail: 450 } });
    const measure: typeof fakeMeasure = (text, face, size, ls) => ({
      ...fakeMeasure(text, face, size, ls),
      inkTop: (text === "بہت" ? -1.1 : -0.5) * size,
      inkBottom: (text === "یہ" ? 0.65 : 0.1) * size,
    });
    const pieces = build(cues, { measure });
    const plate = piece(pieces, "squash:0:plate")!;
    const word = piece(pieces, "squash:0:w1")!;
    for (const t of exportFrameTimes(word.fromMs, cues[0]!.words[1]!.endMs + 150)) {
      const box = pieceBounds(word, t, measure);
      if (box) expect(pieceBounds(plate, t, measure)!.y1).toBeLessThan(box.y1);
    }
  });

  test("a run of 70 to 120 ms words keeps a tab and a skid beat on each cue", () => {
    const staccato = ["yes:h@70", "go:b@90", "now:h@100", "we:m@70 can:b@95", "you:b@85 should:m@120 try:h@80"];
    const lines = Array.from({ length: 40 }, (_, i) => staccato[i % staccato.length]!);
    for (const fps of [24, 25, 30, 60]) for (const cueGap of [0, 60]) {
      const { cues } = demoCues({ lines, options: { lead: 407, gap: 0, cueGap, tail: 450 } });
      const pieces = build(cues, { fps });
      for (const { index } of cues) {
        const plate = piece(pieces, `squash:${index}:plate`)!;
        const frames = exportFrameTimes(plate.fromMs, plate.toMs, fps);
        for (const id of ["tab", "skid0a", "skid0b"]) {
          const accent = piece(pieces, `squash:${index}:${id}`);
          const label = `cue ${index} ${id} @${fps} with gap ${cueGap}`;
          if (frames.length < 2) {
            expect(accent, label).toBeUndefined();
          } else {
            expect(accent, label).toBeDefined();
            expect(exportFrameTimes(accent!.fromMs, accent!.toMs, fps).filter((t) => pieceBounds(accent!, t, fakeMeasure)).length, label).toBeGreaterThanOrEqual(2);
          }
        }
      }
    }
  });

  test("no piece paints on a single frame at any frame rate", () => {
    for (const fps of [24, 25, 30, 60]) {
      const pieces = build(fastRun(60), { fps });
      for (const p of pieces) {
        const frames = exportFrameTimes(p.fromMs, p.toMs, fps).filter((t) => pieceBounds(p, t, fakeMeasure));
        expect(frames.length, `${p.id} @${fps}`).not.toBe(1);
      }
    }
  });
});
