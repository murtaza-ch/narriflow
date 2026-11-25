import { describe, expect, test } from "bun:test";
import { CAPTION_SCENE_BRAND_MIN_CONTRAST, captionColourContrast } from "@narriflow/validators";
import { describeSpeechConformance } from "./conformance-support";
import { demoCues, sceneEdgeDemo } from "./demo";
import { exportFrameTimes } from "./frame-grid";
import type { SceneCue } from "./input";
import { type Box, type Measure, type Piece, evaluatePiece, pieceBounds } from "./scene";
import { BENTO_DEMO, bentoProgram } from "./templates/bento";
import { fakeMeasure, sceneInput } from "./test-support";

describeSpeechConformance("bento", bentoProgram, { anchorLineY: 1290 });

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
const LONG = demoCues({ lines: [...LINES, ...LINES, ...LINES], options: { lead: 400, gap: 30, cueGap: 120, tail: 500 } }).cues;
const build = (cues: readonly SceneCue[], overrides: Parameters<typeof sceneInput>[1] = {}) =>
  bentoProgram.build(sceneInput(cues, { fps: 30, anchor: { xPct: 50, yPct: (1290 / 1920) * 100 }, ...overrides })).pieces;
const pieces = build(LONG);
const cueOf = (piece: Piece) => Number(piece.id.split(":")[1]);
const FACE = /^bento:\d+:w\d+(?:l\d+)?$/;
const meets = (a: Box, b: Box) => a.x1 + 0.5 < b.x2 && b.x1 + 0.5 < a.x2 && a.y1 + 0.5 < b.y2 && b.y1 + 0.5 < a.y2;
const shown = (piece: Piece, t: number) => (evaluatePiece(piece, t).visible ? pieceBounds(piece, t, fakeMeasure) : null);
const settledAt = (cue: SceneCue) => Math.max(...cue.words.map((word) => word.endMs)) - 20;

describe("Bento on real phrasing", () => {
  test("cards of one cue never overlap each other once they have landed", () => {
    for (const cue of LONG) {
      const t = settledAt(cue);
      const cards = pieces.filter((piece) => cueOf(piece) === cue.index && /:card\d+$/.test(piece.id)).flatMap((piece) => shown(piece, t) ?? []);
      expect(cards.length).toBeGreaterThan(0);
      for (const [i, a] of cards.entries()) for (const b of cards.slice(i + 1)) expect(meets(a, b), `cards overlap in cue ${cue.index}`).toBe(false);
    }
  });

  test("cards never cover each other on any frame, entrances and exits included, on tall Devanagari cues as well", () => {
    const hindi = demoCues({ lines: ["display:b glare:b बहुत:h@420", "और:m अगर:b इसे:m सीधा:h@400", "देखो:b तो:m इतना:h@380 ही:m कम:b है।:b"], language: "hi", options: { lead: 400, gap: 30, cueGap: 120, tail: 500 } }).cues;
    for (const [cues, out] of [[LONG, pieces], [hindi, build(hindi)]] as const) {
      for (const cue of cues) {
        const cards = out.filter((piece) => cueOf(piece) === cue.index && /:card\d+$/.test(piece.id));
        for (const t of exportFrameTimes(cue.startMs - 100, cue.endMs, 30)) {
          const boxes = cards.flatMap((piece) => shown(piece, t) ?? []);
          for (const [i, a] of boxes.entries()) for (const b of boxes.slice(i + 1)) expect(meets(a, b), `cards overlap in cue ${cue.index} at ${t}`).toBe(false);
        }
      }
    }
  });

  test("every word sits inside its own card and covers no other word", () => {
    for (const cue of LONG) {
      const t = settledAt(cue);
      const own = pieces.filter((piece) => cueOf(piece) === cue.index);
      const cards = own.filter((piece) => /:card\d+$/.test(piece.id)).flatMap((piece) => shown(piece, t) ?? []);
      const faces = own.filter((piece) => FACE.test(piece.id)).flatMap((piece) => shown(piece, t) ?? []);
      expect(faces.length).toBeGreaterThanOrEqual(cue.words.length);
      for (const face of faces) expect(cards.some((card) => card.x1 <= face.x1 + 1 && card.x2 >= face.x2 - 1 && card.y1 <= face.y1 + 1 && card.y2 >= face.y2 - 1), `a word leaves its card in cue ${cue.index}`).toBe(true);
      for (const [i, a] of faces.entries()) for (const b of faces.slice(i + 1)) expect(meets(a, b), `two words overlap in cue ${cue.index}`).toBe(false);
    }
  });

  test("a card widens as its words are spoken", () => {
    const cue = LONG[2]!;
    const card = pieces.find((piece) => piece.id === `bento:${cue.index}:card0`)!;
    const first = cue.words[0]!;
    const widthAt = (t: number) => {
      const box = shown(card, t)!;
      return box.x2 - box.x1;
    };
    // "the remote" shares a card: it holds one word at first and both once the second is said.
    expect(widthAt(first.startMs + 20)).toBeLessThan(widthAt(cue.words[1]!.endMs + 20) - 20);
  });

  test("the decorations (chip, ring, badges) never sit on a word and come back on every cue", () => {
    let decorations = 0;
    for (const cue of LONG) {
      const own = pieces.filter((piece) => cueOf(piece) === cue.index);
      const faces = own.filter((piece) => FACE.test(piece.id));
      const extras = own.filter((piece) => /:(chip|chiparrow|badge|badgeglyph|ring)\d/.test(piece.id) && !/:ring\d/.test(piece.id));
      expect(own.some((piece) => /:ring\d/.test(piece.id)), `cue ${cue.index} has no focus ring`).toBe(true);
      // A decoration crossing a word for one or two frames while it spins in is motion; sitting on it for three is a covered word.
      const runs = new Map<string, number>();
      for (const t of exportFrameTimes(cue.startMs, cue.endMs, 30)) {
        const ink = faces.flatMap((piece) => shown(piece, t) ?? []);
        for (const extra of extras) {
          const box = shown(extra, t);
          if (!box) {
            runs.set(extra.id, 0);
            continue;
          }
          decorations++;
          const over = ink.some((word) => meets(box, word));
          const run = over ? (runs.get(extra.id) ?? 0) + 1 : 0;
          runs.set(extra.id, run);
          expect(run, `${extra.id} sits on a word at ${t}`).toBeLessThan(3);
        }
      }
    }
    expect(decorations).toBeGreaterThan(300);
  });

  test("neighbouring cards of a cue differ in tone, and the tones keep cycling past the demo", () => {
    for (const cue of LONG) {
      const fills = pieces.filter((piece) => cueOf(piece) === cue.index && /:card\d+$/.test(piece.id)).map((piece) => (piece.kind === "shape" ? piece.fill!.colour : ""));
      // Two key words in a row share the accent card by design.
      for (const [i, fill] of fills.entries()) if (i > 0 && fill !== "#FFE9A8") expect(fill, `cue ${cue.index} repeats a tone`).not.toBe(fills[i - 1]!);
    }
    const all = new Set(pieces.filter((piece) => /:card\d+$/.test(piece.id) && piece.kind === "shape").map((piece) => (piece.kind === "shape" ? piece.fill!.colour : "")));
    expect(all.size).toBeGreaterThanOrEqual(5);
  });

  test("ink reads (the shared 3:1) on every card, even when a brand colour is dark or pale", () => {
    for (const brand of ["#0A0A0A", "#F8F8F8", "#7A7A7A", "#3B5BFF"]) {
      const out = build(demoCues(BENTO_DEMO).cues, { colours: { primary: brand, highlight: brand, accent: brand, shadow: "#000000" } });
      for (const face of out.filter((piece) => FACE.test(piece.id) && piece.kind === "text")) {
        if (face.kind !== "text") continue;
        const card = out.find((piece) => piece.id === `bento:${cueOf(face)}:card0`);
        expect(card).toBeDefined();
        // The card this word sits on is the one whose box holds it at rest.
        const t = Math.max(...demoCues(BENTO_DEMO).cues[cueOf(face)]!.words.map((word) => word.endMs)) - 20;
        const fb = shown(face, t)!;
        const holder = out.filter((piece) => cueOf(piece) === cueOf(face) && /:card\d+$/.test(piece.id) && piece.kind === "shape").find((piece) => {
          const box = shown(piece, t);
          return box && box.x1 <= fb.x1 + 1 && box.x2 >= fb.x2 - 1 && box.y1 <= fb.y1 + 1 && box.y2 >= fb.y2 - 1;
        });
        if (!holder || holder.kind !== "shape") continue;
        expect(captionColourContrast(face.fill, holder.fill!.colour), `${face.id} on brand ${brand}`).toBeGreaterThanOrEqual(CAPTION_SCENE_BRAND_MIN_CONTRAST);
      }
    }
  });
});

describe("Bento edge cases", () => {
  const faces = (cues: readonly SceneCue[], canvas = { width: 1080, height: 1920 }) =>
    build(cues, { canvas, anchor: { xPct: 50, yPct: (1290 / 1920) * 100 } }).filter((piece): piece is Extract<Piece, { kind: "text" }> => piece.kind === "text" && FACE.test(piece.id));

  test("a long word is broken into stacked lines at a readable size, never shrunk to fit the grid", () => {
    const cues = sceneEdgeDemo("long-word").cues;
    const out = faces(cues);
    const big = out.filter((piece) => piece.text.length >= 8 && cueOf(piece) === 1);
    // 45 letters cannot sit on one line of a 900 px grid at a readable size: they are cut into several lines of one card.
    expect(big.length).toBeGreaterThan(1);
    expect(big.map((piece) => piece.text).join("")).toBe("pneumonoultramicroscopicsilicovolcanoconiosis");
    for (const piece of out) expect(piece.sizePx, `${piece.id} is shrunk`).toBeGreaterThanOrEqual(0.7 * 72 * 0.99);
    // The lines of a broken word read top to bottom.
    const ys = big.map((piece) => evaluatePiece(piece, cues[1]!.words[0]!.endMs).y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
  });

  test("a long key word shrinks at most to 72 % before it is broken", () => {
    const out = faces(sceneEdgeDemo("long-word").cues).filter((piece) => cueOf(piece) === 0 && piece.text.length > 10);
    for (const piece of out) expect(piece.sizePx).toBeGreaterThanOrEqual(172 * 0.72 * 0.99);
  });

  test("nine words and the urdu demo keep every card inside the safe area, 9:16 and 16:9", () => {
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }]) {
      for (const cues of [sceneEdgeDemo("nine-words").cues, sceneEdgeDemo("urdu").cues]) {
        for (const piece of build(cues, { canvas })) {
          for (const t of exportFrameTimes(piece.fromMs, piece.toMs, 30)) {
            const box = shown(piece, t);
            if (!box) continue;
            expect(box.x1).toBeGreaterThanOrEqual(0.05 * canvas.width - 1);
            expect(box.x2).toBeLessThanOrEqual(0.95 * canvas.width + 1);
            expect(box.y1).toBeGreaterThanOrEqual(0.05 * canvas.height - 1);
            expect(box.y2).toBeLessThanOrEqual(0.95 * canvas.height + 1);
          }
        }
      }
    }
  });

  test("a right-to-left cue puts its first word on the right and grows its card leftwards", () => {
    const cues = sceneEdgeDemo("urdu").cues;
    const cue = cues[1]!;
    const out = build(cues);
    const t = Math.max(...cue.words.map((word) => word.endMs)) - 20;
    const words = out.filter((piece) => piece.id.startsWith(`bento:1:w`)).flatMap((piece) => {
      const box = shown(piece, t);
      return box ? [{ at: Number(/:w(\d+)/.exec(piece.id)![1]), x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 }] : [];
    });
    const sorted = [...words].sort((a, b) => a.at - b.at);
    let pairs = 0;
    for (let i = 1; i < sorted.length; i++) {
      if (Math.abs(sorted[i]!.y - sorted[i - 1]!.y) > 40) continue;
      pairs++;
      expect(sorted[i]!.x, "later words sit left of earlier ones in a row").toBeLessThan(sorted[i - 1]!.x);
    }
    expect(pairs).toBeGreaterThan(0);
  });
});

/** Plus Jakarta Sans is about 0.47 em a character with the template's tracking; ink 0.72 em up, 0.2 em down. */
const jakarta: Measure = (text, _face, sizePx) => ({ advance: [...text].length * 0.47 * sizePx, inkTop: -0.72 * sizePx, inkBottom: 0.2 * sizePx, ascent: 1.04 * sizePx, descent: 0.22 * sizePx });

describe("Bento review fixes", () => {
  const mk = (texts: string[], start: number, index: number, speaker: number | null, language = "en"): SceneCue => {
    const words = texts.map((text, i) => ({ text, startMs: start + i * 120, endMs: start + i * 120 + 100, role: (i === texts.length - 1 ? "hero" : i === 0 ? "body" : "minor") as "hero" | "body" | "minor" }));
    return { index, speaker, language, words, startMs: start, endMs: words.at(-1)!.endMs + 500 };
  };

  test("a compact cue keeps the sample's two-row grid when its cards fit at readable sizes", () => {
    const cues = demoCues(BENTO_DEMO).cues;
    const out = bentoProgram.build(sceneInput(cues, { fps: 30, measure: jakarta, anchor: { xPct: 50, yPct: (1290 / 1920) * 100 } })).pieces;
    for (const cue of [cues[0]!, cues[1]!, cues[3]!]) {
      const t = settledAt(cue);
      const rows = new Set(out.filter((piece) => cueOf(piece) === cue.index && /:card\d+$/.test(piece.id)).flatMap((piece) => {
        const box = pieceBounds(piece, t, jakarta);
        return box ? [Math.round((box.y1 + box.y2) / 2 / 40)] : [];
      }));
      expect(rows.size, `cue ${cue.index} is not two rows`).toBe(2);
    }
    // The squeeze stays readable: no word is set below 0.75 of the size its card asked for.
    const sizes = out.filter((piece): piece is Extract<Piece, { kind: "text" }> => piece.kind === "text" && FACE.test(piece.id)).map((piece) => piece.sizePx);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(0.74 * 72 * 0.999);
  });

  test("every word is backed by its tile on every painted frame, entrances included, at gaps 0 and 60", () => {
    for (const gap of [0, 60]) {
      const lines = ["right:m before:m it:m works:h", "most:m people:b quit:b right:m before:m it:m", "it's:b time:b to:m say:b goodbye:h"].map((line) => line.split(" ").map((token) => `${token}@100`).join(" "));
      const { cues } = demoCues({ lines, options: { lead: 400, gap: 0, cueGap: gap, tail: 400 } });
      for (const offset of [0, 7, 23]) {
        const run = cues.map((cue) => ({ ...cue, startMs: cue.startMs + offset, endMs: cue.endMs + offset, words: cue.words.map((word) => ({ ...word, startMs: word.startMs + offset, endMs: word.endMs + offset })) }));
        const out = build(run);
        for (const cue of run) {
          const own = out.filter((piece) => cueOf(piece) === cue.index);
          const cards = own.filter((piece) => /:card\d+$/.test(piece.id));
          for (const t of exportFrameTimes(cue.startMs - 100, cue.endMs, 30)) {
            for (const face of own.filter((piece) => FACE.test(piece.id))) {
              const pose = evaluatePiece(face, t);
              const box = shown(face, t);
              if (!box || pose.o < 0.2) continue;
              const backed = cards.some((card) => {
                const tile = shown(card, t);
                return tile && tile.x1 <= box.x1 + 1.5 && tile.x2 >= box.x2 - 1.5 && tile.y1 <= box.y1 + 1.5 && tile.y2 >= box.y2 - 1.5;
              });
              expect(backed, `${face.id} sticks out of its tile at ${t} (gap ${gap}, offset ${offset})`).toBe(true);
            }
          }
        }
      }
    }
  });

  test("overlapping speakers at 2x on 16:9 keep both lanes readable: the long word breaks instead of the type collapsing", () => {
    const long = "pneumonoultramicroscopicsilicovolcanoconiosis";
    const run = [mk(["extraordinary", "understanding", "occasionally", "direction", "in", "clear", "detail", "at", "once"], 400, 0, 0), mk(["ہمارا", "انتخاب", "سے", "یہ", "ہے", long], 680, 1, 1, "ur")];
    const out = build(run, { canvas: { width: 1920, height: 1080 }, scale: 2 });
    const sizeOf = (cue: number) => Math.min(...out.filter((piece): piece is Extract<Piece, { kind: "text" }> => piece.kind === "text" && FACE.test(piece.id) && cueOf(piece) === cue).map((piece) => piece.sizePx));
    // Each lane is half the 16:9 height; its type spends the lane's width first (the old build collapsed the Urdu lane to 28 px).
    expect(sizeOf(0)).toBeGreaterThan(44);
    expect(sizeOf(1)).toBeGreaterThan(44);
    expect(Math.max(sizeOf(0), sizeOf(1)) / Math.min(sizeOf(0), sizeOf(1)), "the lanes are comparable").toBeLessThan(2.2);
  });

  test("combining accents never separate from their letter when a long word is broken", () => {
    const word = "pneumonoultramicroscopicsilicovolcanoconiosis".normalize("NFD").replace(/o/g, "o\u0301");
    const cues = demoCues({ lines: [`${word}:h@900`], options: { lead: 400, gap: 0, cueGap: 0, tail: 400 } }).cues;
    const out = build(cues).filter((piece): piece is Extract<Piece, { kind: "text" }> => piece.kind === "text" && FACE.test(piece.id));
    expect(out.length).toBeGreaterThan(1);
    for (const piece of out) {
      expect(piece.text, `${piece.id} starts with a combining mark`).not.toMatch(/^\p{M}/u);
      expect(piece.sizePx).toBeGreaterThanOrEqual(0.7 * 172 * 0.999);
    }
    expect(out.map((piece) => piece.text).join("").normalize("NFD")).toBe(word.normalize("NFD"));
  });

  test("badges cycle through dot, plus and check across two-card cues, and a one-card cue still has a second beat", () => {
    const lines = Array.from({ length: 40 }, () => "so:m here:b is:m the:m thing:h@300");
    const { cues } = demoCues({ lines: lines.map((line) => line.replace("so:m here:b is:m the:m thing:h@300", "build:b it:h@300")), options: { lead: 400, gap: 30, cueGap: 120, tail: 400 } });
    const out = build(cues);
    const kinds = new Set(cues.map((cue) => out.filter((piece) => cueOf(piece) === cue.index && /:badgeglyph/.test(piece.id)).length));
    expect(kinds, "dot, plus and check all appear").toEqual(new Set([0, 1, 2]));
    const single = demoCues({ lines: ["oh.:b@300", "wow:h@300"], options: { lead: 400, gap: 30, cueGap: 200, tail: 400 } }).cues;
    const oneCard = build(single);
    for (const cue of single) {
      const own = oneCard.filter((piece) => cueOf(piece) === cue.index);
      expect(own.some((piece) => /:ring\d/.test(piece.id)), `cue ${cue.index} has no ring`).toBe(true);
      expect(own.some((piece) => /:badge\d/.test(piece.id)), `cue ${cue.index} has no second beat`).toBe(true);
    }
  });

  test("overlapping speakers at 2x on 16:9 never overlap and share one scale", () => {
    const long = "pneumonoultramicroscopicsilicovolcanoconiosis";
    const run = [mk(["extraordinary", "understanding", "occasionally", "direction", "in", "clear", "detail", "at", "once"], 400, 0, 0), mk(["ہمارا", "انتخاب", "سے", "یہ", "ہے", long], 680, 1, 1, "ur")];
    const out = build(run, { canvas: { width: 1920, height: 1080 }, scale: 2 });
    for (const t of exportFrameTimes(380, 1800, 30)) {
      const painted = out.flatMap((piece) => {
        const box = shown(piece, t);
        return box ? [{ piece, box }] : [];
      });
      for (const a of painted) for (const b of painted) {
        if (cueOf(a.piece) >= cueOf(b.piece)) continue;
        expect(meets(a.box, b.box), `${a.piece.id} meets ${b.piece.id} at ${t}`).toBe(false);
      }
    }
    // The same scale: the body words of both lanes are the same size, give or take the row squeeze.
    const body = (cue: number) => Math.max(...out.filter((piece): piece is Extract<Piece, { kind: "text" }> => piece.kind === "text" && FACE.test(piece.id) && cueOf(piece) === cue && !/:w(8|5l\d)$/.test(piece.id)).map((piece) => piece.sizePx));
    expect(Math.max(body(0), body(1)) / Math.min(body(0), body(1))).toBeLessThan(1.4);
  });

  test("back-to-back one-frame cues keep a tile under every word", () => {
    const cues = [331, 401, 471, 541, 611, 681, 751, 821].map((startMs, index): SceneCue => {
      const word = { text: ["go", "yes", "wait", "later"][index % 4]!, startMs, endMs: startMs + 70, role: "hero" as const };
      return { index, speaker: 0, language: "en", startMs, endMs: startMs + 70, words: [word] };
    });
    for (const fps of [24, 25, 30]) {
      const out = build(cues, { fps });
      let checked = 0;
      for (const t of exportFrameTimes(331, 891, fps)) {
        for (const face of out.filter((piece) => /^bento:\d+:w\d+$/.test(piece.id))) {
          const box = shown(face, t);
          if (!box || evaluatePiece(face, t).o < 0.2) continue;
          checked++;
          const backed = out.some((piece) => piece.kind === "shape" && cueOf(piece) === cueOf(face) && /:(card\d+|w\d+l\d+)$/.test(piece.id) && (() => {
            const tile = shown(piece, t);
            return tile !== null && tile.x1 <= box.x1 + 1.5 && tile.x2 >= box.x2 - 1.5 && tile.y1 <= box.y1 + 1.5 && tile.y2 >= box.y2 - 1.5;
          })());
          expect(backed, `${face.id} is bare at ${t} (${fps} fps)`).toBe(true);
        }
      }
      expect(checked).toBeGreaterThan(0);
    }
  });

  test("wrapped lines are spaced by their measured ink, so a descender never meets the accent below", () => {
    const tall: Measure = (text, _face, sizePx) => ({
      advance: [...text].length * 0.47 * sizePx,
      inkTop: (/\p{M}/u.test(text) ? -0.98 : -0.72) * sizePx,
      inkBottom: (/[pg]/.test(text) ? 0.3 : 0.2) * sizePx,
      ascent: 1.04 * sizePx,
      descent: 0.22 * sizePx,
    });
    const word = `${"p".repeat(11)}${"o\u0301".repeat(11)}${"p".repeat(11)}${"o\u0301".repeat(11)}`;
    const cues = demoCues({ lines: [`${word}:h@900`], options: { lead: 400, gap: 0, cueGap: 0, tail: 400 } }).cues;
    const out = build(cues, { measure: tall });
    const t = settledAt(cues[0]!);
    const lines = out.filter((piece) => FACE.test(piece.id)).flatMap((piece) => {
      const box = pieceBounds(piece, t, tall);
      return box ? [{ id: piece.id, box }] : [];
    }).sort((a, b) => a.box.y1 - b.box.y1);
    expect(lines.length).toBeGreaterThan(2);
    for (let i = 1; i < lines.length; i++) expect(lines[i - 1]!.box.y2, `${lines[i - 1]!.id} reaches ${lines[i]!.id}`).toBeLessThanOrEqual(lines[i]!.box.y1 + 0.5);
  });

  test("a grey brand colour that passes the shared 3:1 guard keeps white ink", () => {
    const out = build(demoCues(BENTO_DEMO).cues, { colours: { primary: "#F4F0E7", highlight: "#939393", accent: "#1A1D25", shadow: "#000000" } });
    const heroFaces = out.filter((piece): piece is Extract<Piece, { kind: "text" }> => piece.kind === "text" && /:w3$/.test(piece.id) && cueOf(piece) === 0);
    expect(heroFaces.length).toBeGreaterThan(0);
    for (const piece of heroFaces) expect(piece.fill).toBe("#FFFFFF");
  });
});
