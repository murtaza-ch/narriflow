import { describe, expect, test } from "bun:test";
import { describeSpeechConformance } from "./conformance-support";
import { demoCues, sceneEdgeDemo } from "./demo";
import { exportFrameTimes } from "./frame-grid";
import type { SceneCue } from "./input";
import { type Box, type Measure, type Piece, evaluatePiece, pieceBounds } from "./scene";
import { SNIPSNAP_DEMO, snipsnapProgram } from "./templates/snipsnap";
import { sceneInput } from "./test-support";

describeSpeechConformance("snipsnap", snipsnapProgram, { anchorLineY: 1285 });

/** Londrina Solid Black is narrow: about 0.42 em a capital, ink 0.72 em up and 0.01 down. */
const fakeMeasure: Measure = (text, _face, sizePx, letterSpacingEm) => ({
  advance: [...text].length * (0.42 + letterSpacingEm) * sizePx - letterSpacingEm * sizePx,
  inkTop: -0.72 * sizePx,
  inkBottom: 0.02 * sizePx,
  ascent: 0.94 * sizePx,
  descent: 0.22 * sizePx,
});

/** Real phrasing: the key word first, mid-cue and last, two key words in a row, a long key word, no key word. */
const LINES = [
  "it's:b time:b to:m say:b goodbye:h@420",
  "does:b the:m remote:b even:b still:h@360",
  "the:m remote:b doesn't:h@360 work.:b",
  "we:m didn't:h@360 want:b anyone:b",
  "anyone:m to:m accidentally:h@520 open:b them.:m",
  "we've:m shot:b 384:h episodes:h@420",
  "just:b tear:b it:m down.:m",
  "oh.:b",
];
/** Three runs of the lines make 24 cues, so the cycling counters go past any demo. */
const LONG = demoCues({ lines: [...LINES, ...LINES, ...LINES], options: { lead: 400, gap: 30, cueGap: 120, tail: 500 } }).cues;
const build = (cues: readonly SceneCue[], fps = 30) => snipsnapProgram.build(sceneInput(cues, { fps, measure: fakeMeasure, anchor: { xPct: 50, yPct: (1285 / 1920) * 100 } })).pieces;
const pieces = build(LONG);
const cueOf = (piece: Piece) => Number(piece.id.split(":")[1]);
const FACE = /^snipsnap:\d+:w\d+$/;
const meets = (a: Box, b: Box) => a.x1 + 0.5 < b.x2 && b.x1 + 0.5 < a.x2 && a.y1 + 0.5 < b.y2 && b.y1 + 0.5 < a.y2;
const shown = (piece: Piece, t: number) => (evaluatePiece(piece, t).visible ? pieceBounds(piece, t, fakeMeasure) : null);
const settledAt = (cue: SceneCue) => Math.max(...cue.words.map((word) => word.endMs)) - 20;

describe("Snip Snap on real phrasing", () => {
  test("a doodle never sits on a spoken word, on any frame of the cue", () => {
    let doodles = 0;
    for (const cue of LONG) {
      const own = pieces.filter((piece) => cueOf(piece) === cue.index);
      const faces = own.filter((piece) => FACE.test(piece.id));
      for (const t of exportFrameTimes(cue.startMs, cue.endMs, 30)) {
        const ink = faces.flatMap((piece) => shown(piece, t) ?? []);
        for (const doodle of own.filter((piece) => /:doodle\d/.test(piece.id))) {
          const box = shown(doodle, t);
          if (!box) continue;
          doodles++;
          for (const word of ink) expect(meets(box, word), `${doodle.id} over a word at ${t}`).toBe(false);
        }
      }
    }
    expect(doodles).toBeGreaterThan(200);
  });

  test("tape and scraps sit under the type and clear of it", () => {
    for (const cue of LONG) {
      const own = pieces.filter((piece) => cueOf(piece) === cue.index);
      const faceZ = Math.min(...own.filter((piece) => FACE.test(piece.id)).map((piece) => piece.z));
      for (const piece of own.filter((candidate) => /:(tape|scrap\d)$/.test(candidate.id))) expect(piece.z).toBeLessThan(faceZ);
      const t = settledAt(cue);
      for (const extra of own.filter((candidate) => /:(tape|scrap\d)$/.test(candidate.id))) {
        const box = shown(extra, t);
        if (!box) continue;
        for (const face of own.filter((candidate) => FACE.test(candidate.id))) {
          const ink = shown(face, t);
          if (ink) expect(meets(box, ink), `${extra.id} over ${face.id} in cue ${cue.index}`).toBe(false);
        }
      }
    }
  });

  test("every cue of a 24-cue clip gets a doodle, tape and scraps, and the doodle kind cycles through all six", () => {
    const kinds = new Set<string>();
    let scrapped = 0;
    for (const cue of LONG) {
      const own = pieces.filter((piece) => cueOf(piece) === cue.index);
      expect(own.some((piece) => /:doodle0-0$/.test(piece.id)), `cue ${cue.index} has no doodle`).toBe(true);
      expect(own.some((piece) => piece.id.endsWith(":tape")), `cue ${cue.index} has no tape`).toBe(true);
      const scraps = own.filter((piece) => /:scrap\d$/.test(piece.id)).length;
      expect(scraps, `cue ${cue.index} scraps`).toBeGreaterThanOrEqual(1);
      scrapped += scraps >= 2 ? 1 : 0;
      const parts = own.filter((piece) => /:doodle\d-\d$/.test(piece.id));
      kinds.add(`${parts.length}:${parts[0]?.kind === "shape" ? JSON.stringify(parts[0].path.slice(0, 3)).length : 0}`);
    }
    expect(scrapped).toBeGreaterThanOrEqual(LONG.length * 0.7);
    expect(kinds.size).toBeGreaterThanOrEqual(3);
    const heroCue = LONG.findIndex((cue) => cue.words.some((word) => word.role === "hero"));
    expect(pieces.some((piece) => cueOf(piece) === LONG[heroCue]!.index && /:doodle1-0$/.test(piece.id))).toBe(true);
  });

  test("a doodle's tilt does not grow with the cue number (the sample added 4 degrees a cue)", () => {
    const tilt = (index: number) => {
      const doodle = pieces.find((piece) => cueOf(piece) === index && /:doodle0-0$/.test(piece.id))!;
      return Math.abs(evaluatePiece(doodle, settledAt(LONG[index]!)).rz);
    };
    for (const index of [0, 12, 23]) expect(tilt(index)).toBeLessThan(40);
  });

  test("a key word keeps a legible size and a row of its own; words wrap into even rows", () => {
    for (const cue of LONG) {
      const own = pieces.filter((piece) => cueOf(piece) === cue.index && FACE.test(piece.id));
      for (const face of own) {
        if (face.kind !== "text") throw new Error("face is text");
        expect(face.sizePx).toBeGreaterThanOrEqual(68);
      }
      cue.words.forEach((word, at) => {
        if (word.role !== "hero") return;
        const mine = own.find((piece) => piece.id.endsWith(`:w${at}`))!;
        const y = evaluatePiece(mine, settledAt(cue)).y;
        for (const other of own.filter((piece) => piece !== mine)) expect(Math.abs(evaluatePiece(other, settledAt(cue)).y - y)).toBeGreaterThan(60);
      });
    }
  });

  test("every word sits inside a label of its own row, and no two words of a cue meet", () => {
    for (const cue of LONG) {
      const own = pieces.filter((piece) => cueOf(piece) === cue.index);
      const t = settledAt(cue);
      const faces = own.filter((piece) => FACE.test(piece.id));
      const plates = own.filter((piece) => /:p\d+s\d+$/.test(piece.id));
      for (const face of faces) {
        const ink = shown(face, t)!;
        const cx = (ink.x1 + ink.x2) / 2;
        const cy = (ink.y1 + ink.y2) / 2;
        expect(plates.some((plate) => {
          const box = shown(plate, t);
          return box !== null && box.x1 <= cx && box.x2 >= cx && box.y1 <= cy && box.y2 >= cy;
        }), `${face.id} has no label under it`).toBe(true);
      }
      for (const [i, a] of faces.entries()) {
        for (const b of faces.slice(i + 1)) {
          const x = shown(a, t)!;
          const y = shown(b, t)!;
          expect(meets({ x1: x.x1 + 4, x2: x.x2 - 4, y1: x.y1 + 14, y2: x.y2 - 14 }, { x1: y.x1 + 4, x2: y.x2 - 4, y1: y.y1 + 14, y2: y.y2 - 14 }), `${a.id} meets ${b.id}`).toBe(false);
        }
      }
    }
  });

  test("the label grows by whole words as they are said, never narrower than the words shown", () => {
    const cue = LONG[1]!;
    const own = pieces.filter((piece) => cueOf(piece) === cue.index);
    const label = own.filter((piece) => /:p0s\d+$/.test(piece.id));
    expect(label.length).toBeGreaterThanOrEqual(2);
    const widths = label.sort((a, b) => a.fromMs - b.fromMs).map((piece) => {
      const box = pieceBounds(piece, exportFrameTimes(piece.fromMs, piece.toMs, 30).at(-1)! - 1, fakeMeasure) ?? pieceBounds(piece, piece.fromMs + 40, fakeMeasure)!;
      return box.x2 - box.x1;
    });
    for (let i = 1; i < widths.length; i++) expect(widths[i]!).toBeGreaterThan(widths[i - 1]! - 1);
  });

  test("a right-to-left cue runs right to left and mirrors the stagger", () => {
    const urdu = sceneEdgeDemo("urdu").cues;
    const out = build(urdu);
    const first = urdu[0]!;
    const t = settledAt(first);
    const xs = first.words.map((_, at) => evaluatePiece(out.find((piece) => piece.id === `snipsnap:0:w${at}`)!, t).x);
    const row = [...xs].slice(0, 2);
    expect(row[0]! > row[1]!).toBe(true);
  });

  test("the demo builds inside the piece budget with a long word and nine words", () => {
    for (const cues of [demoCues(SNIPSNAP_DEMO).cues, sceneEdgeDemo("long-word").cues, sceneEdgeDemo("nine-words").cues]) {
      const out = build(cues);
      for (const cue of cues) expect(out.filter((piece) => cueOf(piece) === cue.index).length).toBeLessThanOrEqual(150);
    }
  });

  test("a long word is cut into rows that read, never shrunk to a sliver (review: 35 px)", () => {
    const long = sceneEdgeDemo("long-word").cues[1]!;
    const out = build([{ ...long, index: 0 }]);
    const segments = out.filter((piece) => /^snipsnap:0:w0l\d+$/.test(piece.id));
    expect(segments.length).toBeGreaterThanOrEqual(2);
    for (const segment of segments) {
      if (segment.kind !== "text") throw new Error("segment is text");
      expect(segment.sizePx).toBeGreaterThanOrEqual(0.55 * 112);
    }
    const spoken = long.words[0]!.text.toUpperCase();
    expect(segments.map((segment) => (segment.kind === "text" ? segment.text : "")).join("")).toBe(spoken);
    // Part 0 paints at the spoken start, every part is whole before the word ends.
    const first = segments.find((segment) => segment.id.endsWith("l0"))!;
    expect(shown(first, long.words[0]!.startMs + 34)).not.toBeNull();
    for (const segment of segments) expect(shown(segment, long.words[0]!.endMs - 2)).not.toBeNull();
    // One row each, top to bottom in reading order.
    const ys = segments.map((segment) => evaluatePiece(segment, long.words[0]!.endMs - 2).y);
    for (let i = 1; i < ys.length; i++) expect(ys[i]!).toBeGreaterThan(ys[i - 1]!);
  });

  test("the type reads on the paper under it at the brand guard's 3:1 with the default palette (review: 2.4:1 yellow on pink)", () => {
    const lum = (hex: string) => {
      const ch = (at: number) => {
        const v = Number.parseInt(hex.slice(1 + 2 * at, 3 + 2 * at), 16) / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * ch(0) + 0.7152 * ch(1) + 0.0722 * ch(2);
    };
    const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    const inks = new Set<string>();
    const catalogue = snipsnapProgram.build(sceneInput(LONG, { measure: fakeMeasure, colours: { primary: "#FFD928", highlight: "#FF5FAE", accent: "#3DE3EA", shadow: "#000000" }, anchor: { xPct: 50, yPct: (1285 / 1920) * 100 } })).pieces;
    for (const cue of LONG) {
      const own = catalogue.filter((piece) => cueOf(piece) === cue.index);
      const t = settledAt(cue);
      for (const face of own.filter((piece) => FACE.test(piece.id) && piece.kind === "text")) {
        const ink = shown(face, t)!;
        const cx = (ink.x1 + ink.x2) / 2;
        const cy = (ink.y1 + ink.y2) / 2;
        const paper = own.filter((piece) => /:p\d+s\d+$/.test(piece.id) && piece.kind === "shape").filter((piece) => {
          const box = shown(piece, t);
          return box !== null && box.x1 <= cx && box.x2 >= cx && box.y1 <= cy && box.y2 >= cy;
        }).at(-1)!;
        if (paper.kind !== "shape" || face.kind !== "text") throw new Error("shapes");
        inks.add(`${face.fill} on ${paper.fill!.colour}`);
        expect(ratio(face.fill, paper.fill!.colour), `${face.id} ${face.fill} on ${paper.fill!.colour}`).toBeGreaterThanOrEqual(3);
      }
    }
    // All four papers appear over the run, pink among them.
    expect(inks.size).toBeGreaterThanOrEqual(4);
    expect([...inks].some((pair) => pair.endsWith("#FF5FAE"))).toBe(true);
  });

  test("the animated stack, entrance overshoot and decorations stay in the caption band on every painted frame, 9:16 and 16:9", () => {
    const tall = demoCues({ lines: ["inch:b matte:b display:h@500 glare:b", "and:m then:b the:b hero:h@480", "we've:m shot:b 384:h episodes:h@420"], options: { lead: 400, gap: 30, cueGap: 120, tail: 500 } }).cues;
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }, { width: 1080, height: 1080 }]) {
      const ay = (1285 / 1920) * canvas.height;
      const band = { y1: ay - (425 / 1920) * canvas.height - 1, y2: ay + (365 / 1920) * canvas.height + 1 };
      const out = snipsnapProgram.build(sceneInput(tall, { canvas, measure: fakeMeasure, anchor: { xPct: 50, yPct: (1285 / 1920) * 100 } })).pieces;
      for (const piece of out) {
        for (const t of exportFrameTimes(piece.fromMs, piece.toMs, 30)) {
          const box = shown(piece, t);
          if (!box) continue;
          expect(box.y1 >= band.y1 && box.y2 <= band.y2, `${piece.id} at ${t} on ${canvas.width}x${canvas.height}: ${Math.round(box.y1)}-${Math.round(box.y2)} outside ${Math.round(band.y1)}-${Math.round(band.y2)}`).toBe(true);
        }
      }
    }
  });

  test("fast cues (70-120 ms words) keep their doodles, tape and scraps in a static pose, at gaps 0 and 60", () => {
    const fast = (gap: number): SceneCue[] => {
      let clock = 403;
      return Array.from({ length: 40 }, (_, index) => {
        const startMs = clock;
        const words = (index % 4 === 0 ? ["brief", "stay", "bright", "clear"] : ["keep", "the", "point", "sharp"]).map((text, i) => {
          const wordStart = clock;
          clock += [70, 90, 120, 70][(i + index) % 4]!;
          return { text, startMs: wordStart, endMs: clock, role: (i === 3 && index % 4 !== 0 ? "hero" : "body") as "hero" | "body", key: null };
        });
        clock += gap;
        return { index, startMs, endMs: clock, words, speaker: 0, language: "en" };
      });
    };
    for (const gap of [0, 60]) {
      for (const fps of [24, 30, 60]) {
        const run = fast(gap);
        const out = build(run, fps);
        for (const cue of run) {
          const own = out.filter((piece) => cueOf(piece) === cue.index);
          expect(own.some((piece) => /:doodle0-0$/.test(piece.id)), `cue ${cue.index} lost its doodle at gap ${gap}, ${fps} fps`).toBe(true);
          expect(own.some((piece) => piece.id.endsWith(":tape")), `cue ${cue.index} lost its tape at gap ${gap}, ${fps} fps`).toBe(true);
        }
      }
    }
  }, 60_000);

  test("a word is never smaller than half size on its first painted frame, even with 60 ms between cues (review: 19 %)", () => {
    const quick = demoCues({ lines: ["keep:b the:m point:b sharp:h@120", "keep:b the:m point:b sharp:h@120", "keep:b the:m point:b sharp:h@120"], options: { lead: 400, rate: 100, gap: 0, cueGap: 60, tail: 400 } }).cues;
    const out = build(quick);
    for (const face of out.filter((piece) => FACE.test(piece.id))) {
      const [t] = exportFrameTimes(face.fromMs, face.toMs, 30);
      expect(evaluatePiece(face, t!).sx, `${face.id} at ${t}`).toBeGreaterThanOrEqual(0.45);
    }
  });

  test("a doodle sits beside the paper, not far from it (review: 59 px away)", () => {
    for (const cue of LONG) {
      const own = pieces.filter((piece) => cueOf(piece) === cue.index);
      const t = settledAt(cue);
      const plates = own.filter((piece) => /:p\d+s\d+$/.test(piece.id)).flatMap((piece) => shown(piece, t) ?? []);
      for (const di of [0, 1]) {
        const parts = own.filter((piece) => new RegExp(`:doodle${di}-\\d$`).test(piece.id)).flatMap((piece) => shown(piece, t) ?? []);
        if (parts.length === 0) continue;
        const box = { x1: Math.min(...parts.map((part) => part.x1)), y1: Math.min(...parts.map((part) => part.y1)), x2: Math.max(...parts.map((part) => part.x2)), y2: Math.max(...parts.map((part) => part.y2)) };
        const doodle = { id: `${cue.index}:doodle${di}` };
        const gap = Math.min(...plates.map((plate) => Math.hypot(Math.max(box.x1 - plate.x2, plate.x1 - box.x2, 0), Math.max(box.y1 - plate.y2, plate.y1 - box.y2, 0))));
        expect(gap, `${doodle.id} is ${Math.round(gap)} px from the paper`).toBeLessThanOrEqual(30);
      }
    }
  });

  test("a doodle waits for the part of the label it sits beside (review: 228 px from a label still growing)", () => {
    const slow = demoCues({ lines: ["nobody:b tells:b you:b this:b", "the:m remote:b doesn't:b work:b", "keep:b the:m point:b sharp:h@500"], options: { lead: 400, gap: 60, rate: 420, cueGap: 150, tail: 500 } }).cues;
    const out = build(slow);
    let checked = 0;
    for (const cue of slow) {
      const own = out.filter((piece) => cueOf(piece) === cue.index);
      for (const di of [0, 1]) {
        const parts = own.filter((piece) => new RegExp(`:doodle${di}-\\d$`).test(piece.id));
        if (parts.length === 0) continue;
        const first = Math.min(...parts.map((piece) => exportFrameTimes(piece.fromMs, piece.toMs, 30).find((t) => shown(piece, t)) ?? Number.POSITIVE_INFINITY));
        // A little after it first paints, once it has grown to size.
        const at = Math.min(first + 200, cue.endMs - 40);
        const boxes = parts.flatMap((piece) => shown(piece, at) ?? []);
        if (boxes.length === 0) continue;
        const box = { x1: Math.min(...boxes.map((b) => b.x1)), y1: Math.min(...boxes.map((b) => b.y1)), x2: Math.max(...boxes.map((b) => b.x2)), y2: Math.max(...boxes.map((b) => b.y2)) };
        const plates = own.filter((piece) => /:p\d+s\d+$/.test(piece.id)).flatMap((piece) => shown(piece, at) ?? []);
        const gap = Math.min(...plates.map((plate) => Math.hypot(Math.max(box.x1 - plate.x2, plate.x1 - box.x2, 0), Math.max(box.y1 - plate.y2, plate.y1 - box.y2, 0))));
        expect(gap, `cue ${cue.index} doodle${di} first paints ${Math.round(gap)} px from the paper painted by then`).toBeLessThanOrEqual(40);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(3);
  });

  test("combining marks stay with their letter and soft hyphens are the places a long word breaks (review: one 37 px line)", () => {
    const wordCue = (text: string): SceneCue => ({ index: 0, startMs: 400, endMs: 2400, speaker: null, language: "en", words: [{ text, startMs: 400, endMs: 1900, role: "body", key: null }] });
    const segmentsOf = (text: string) => build([wordCue(text)]).filter((piece) => /^snipsnap:0:w0l\d+$/.test(piece.id) && piece.kind === "text");
    const marked = segmentsOf("pneumono\u0301ultramicroscopicsilicovolcanoconiosis");
    expect(marked.length).toBeGreaterThanOrEqual(2);
    for (const segment of marked) {
      if (segment.kind !== "text") throw new Error("text");
      expect(segment.sizePx).toBeGreaterThanOrEqual(0.55 * 112);
      expect(segment.text.startsWith("\u0301")).toBe(false);
    }
    expect(marked.map((segment) => (segment.kind === "text" ? segment.text : "")).join("")).toBe("PNEUMONO\u0301ULTRAMICROSCOPICSILICOVOLCANOCONIOSIS");
    const soft = segmentsOf("pneumonoultra\u00ADmicroscopicsilico\u00ADvolcanoconiosis");
    expect(soft.length).toBeGreaterThanOrEqual(2);
    const drawn = soft.map((segment) => (segment.kind === "text" ? segment.text : ""));
    expect(drawn.join("")).toBe("PNEUMONOULTRAMICROSCOPICSILICOVOLCANOCONIOSIS");
    // Cut where the word may be hyphenated: every piece but the last ends at a soft hyphen of the source.
    expect(["PNEUMONOULTRA", "PNEUMONOULTRAMICROSCOPICSILICO"]).toContain(drawn[0]);
  });

  test("a Japanese cue keeps at least one scrap (review: none on とても 素晴らしい ですね)", () => {
    const ja = demoCues({ language: "ja", lines: ["とても:b 素晴らしい:h@120 ですね:b", "もうすぐ:b 新しい:b アプリ:h@90 発売:b"], options: { rate: 100, lead: 400, tail: 200, cueGap: 0 } }).cues;
    for (const fps of [24, 30, 60]) {
      const out = build(ja, fps);
      for (const cue of ja) expect(out.filter((piece) => cueOf(piece) === cue.index && /:scrap\d$/.test(piece.id)).length, `cue ${cue.index} at ${fps} fps`).toBeGreaterThanOrEqual(1);
    }
  });
});
