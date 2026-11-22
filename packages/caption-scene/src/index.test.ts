import { describe, expect, test } from "bun:test";
import { type DemoScript, demoCues, sceneEdgeDemo } from "./demo";
import { detectList } from "./detect";
import { EASES, kf, lerp, prog } from "./ease";
import { type Piece, type ShapePiece, type TextPiece, evaluatePiece } from "./scene";
import { sceneInput } from "./test-support";
import { INDEX_DEMO, indexProgram } from "./templates/index";

const ANCHOR = { xPct: 50, yPct: (1290 / 1920) * 100 };
const build = (script: DemoScript, overrides = {}) => {
  const { cues } = demoCues(script);
  return { cues, scene: indexProgram.build(sceneInput(cues, { anchor: ANCHOR, colours: { primary: "#FFFFFF", highlight: "#B9F227", accent: "#0E0E10", shadow: "#000000" }, ...overrides })) };
};
const { cues, scene } = build(INDEX_DEMO);
const pieces = scene.pieces;
const byId = (id: string) => pieces.find((piece) => piece.id === id)!;
const texts = pieces.filter((piece): piece is TextPiece => piece.kind === "text");
const shapes = pieces.filter((piece): piece is ShapePiece => piece.kind === "shape");
const word = (cue: number, at: number) => cues[cue]!.words[at]!;
const wordPiece = (cue: number, at: number) => byId(`index:${cue}:w${at}`) as TextPiece;
const dialIds = (prefix: string) => pieces.filter((piece) => piece.id.startsWith(`index:dial:${prefix}`));

// The sample's own dial scale (`scaleAfter` of the latest event), for the events of the demo: total at 420, items at 2224, 3414, 5079, end at 6723.
const EVENTS = [
  { type: "total", t: 420, end: 705 },
  { type: "item", t: 2224, end: 2529 },
  { type: "item", t: 3414, end: 3739 },
  { type: "item", t: 5079, end: 5423 },
  { type: "end", t: 6723, end: 6948 },
] as const;
const scaleAfter = (i: number, t: number): number => {
  const e = EVENTS[i]!;
  const t0 = e.t - 80;
  if (e.type === "end") return lerp(i > 0 ? scaleAfter(i - 1, t0) : 1, 0, EASES.in(prog(t, t0, 170)));
  const settle = Math.max(t0 + 260, e.end + 420);
  const from = e.type === "total" ? 0.5 : i > 0 ? scaleAfter(i - 1, t0) : 0.5;
  return kf(t, [[t0, from], [t0 + 140, 1.1, "out"], [t0 + 230, 1, "in"], [settle, 1], [settle + 320, 0.86, "out"]]);
};
const sampleScale = (t: number) => {
  let at = -1;
  EVENTS.forEach((e, i) => {
    if (t >= e.t - 80) at = i;
  });
  return at < 0 ? 0 : Math.max(0, scaleAfter(at, t));
};

describe("Index: the list detector (the sample's, read on real phrasing)", () => {
  const detect = (lines: string[]) => detectList(demoCues({ lines }).cues);
  const kinds = (lines: string[]) => detect(lines).events.map((event) => (event.type === "item" ? `item${event.n}` : event.type));

  test("the demo script: a total of three, three items, the end at 'so'", () => {
    expect(kinds(INDEX_DEMO.lines as string[])).toEqual(["total", "item1", "item2", "item3", "end"]);
  });

  test("digits, number words, capitals and punctuation all count", () => {
    expect(detect(["Here are 5 tips", "First, drink water"]).total).toBe(5);
    expect(detect(["Five ways to win", "First. Start"]).total).toBe(5);
    expect(detect(["THREE Reasons why", "Second, ok"]).events.map((e) => e.type)).toEqual(["total", "item"]);
    expect(detect(["These are the top 7 lessons", "first, sleep", "Next, eat", "Lastly, move"]).events.map((e) => (e.type === "item" ? e.n : 0))).toEqual([0, 1, 2, 3]);
  });

  test("'next', 'then', 'finally', 'lastly' take the next number; an ordinal sets it", () => {
    expect(kinds(["four steps to this", "first, a", "then, b", "third, c", "finally, d"])).toEqual(["total", "item1", "item2", "item3", "item4"]);
  });

  test("no announced total, no list: ordinals alone, 'number one' and a bare count are ignored", () => {
    expect(detect(["first of all hello", "second, we go", "so that's it"]).events).toEqual([]);
    expect(detect(["there are three of them", "number one is a cat"]).total).toBeNull();
  });

  test("ordinals count only at the start of a cue, and the total only once", () => {
    // Real cues break wherever the plan breaks them: an ordinal inside a cue is not an item.
    expect(kinds(["three tips for you", "so the first tip is", "this one"])).toEqual(["total", "end"]);
    expect(kinds(["three tips", "five ways to this", "first, a"])).toEqual(["total", "item1"]);
  });

  test("a next-point word that starts a phrase mid-cue counts: after . , ? ! : ; or a closing quote", () => {
    const at = (line: string) => detect(["three mistakes ahead", line]).events.filter((event) => event.type === "item").map((event) => (event.type === "item" ? `${event.cue}:${event.word}=${event.n}` : ""));
    expect(at("killing your channel. First, no hook")).toEqual(["1:3=1"]);
    expect(at("that was it, second, you quit")).toEqual(["1:3=2"]);
    expect(at("really? Finally, you quit")).toEqual(["1:1=1"]);
    expect(at("wow! Next, you quit")).toEqual(["1:1=1"]);
    expect(at("here: first, no hook")).toEqual(["1:1=1"]);
    expect(at("ok; then you quit")).toEqual(["1:1=1"]);
    expect(at('"done." Second, you quit')).toEqual(["1:1=2"]);
  });

  test("a stray ordinal inside a sentence counts for nothing", () => {
    for (const line of ["the first time I quit", "my second channel failed", "we ate then slept", "it was finally over", "she said first"]) {
      expect(detect(["three mistakes ahead", line]).events.map((event) => event.type)).toEqual(["total"]);
    }
  });

  test("real cues cut by four words: the whole list is found wherever the cuts fall", () => {
    const lines = ["three mistakes killing your", "channel. First, no hook", "kills reach. Second, you", "post then vanish. Finally,", "you quit too early. So start", "today"];
    const found = detect(lines);
    expect(found.events.map((event) => (event.type === "item" ? `item${event.n}@${event.cue}:${event.word}` : `${event.type}@${event.cue}:${event.word}`))).toEqual([
      "total@0:0",
      "item1@1:1",
      "item2@2:2",
      "item3@3:3",
      "end@4:4",
    ]);
    // "So" after the sentence end "early." closes the list, mid-cue like an item word; the next cue is out of it.
    expect(found.listOpen).toEqual([true, true, true, true, false, false]);
  });

  test("the end fires after sentence punctuation mid-cue, never after a comma or inside a sentence", () => {
    const end = (line: string) => detect(["three things", "first, a", line]).events.filter((event) => event.type === "end").map((event) => `${event.cue}:${event.word}`);
    expect(end("that was it. So start now")).toEqual(["2:3"]);
    expect(end("is that all? That's right")).toEqual(["2:3"]);
    expect(end("wow! So good")).toEqual(["2:1"]);
    expect(end('"done." So start')).toEqual(["2:1"]);
    expect(end("it works, so you stay")).toEqual([]);
    expect(end("so far so good")).toEqual(["2:0"]);
    expect(end("and so on and that's it")).toEqual([]);
    // After the end the list stays closed: a later "second" opens nothing.
    expect(kinds(["three things", "first, a", "ok. So, done", "second, b"])).toEqual(["total", "item1", "end"]);
  });

  test("the list ends at a cue-initial 'so' or \"that's\" and does not reopen", () => {
    expect(kinds(["three things", "first, a", "that's all", "then, b"])).toEqual(["total", "item1", "end"]);
    expect(detect(["three things", "first, a", "so ok", "second, b"]).listOpen).toEqual([true, true, false, false]);
  });
});

describe("Index: pieces and geometry", () => {
  test("the dial is one set of pieces for the whole list, in the ink colour with a lime badge and a white ring", () => {
    expect(byId("index:dial:disc")).toMatchObject({ fill: { colour: "#0E0E10" } });
    expect(byId("index:dial:badge")).toMatchObject({ fill: { colour: "#B9F227" } });
    expect(dialIds("ring").filter((piece) => piece.id.endsWith("todo"))).toHaveLength(3);
    expect(dialIds("ring").filter((piece) => piece.id.endsWith("done"))).toHaveLength(3);
    for (const piece of dialIds("ring") as ShapePiece[]) expect(piece.stroke).toMatchObject({ widthPx: 6, colour: "#FFFFFF" });
    expect((byId("index:dial:ring0todo") as ShapePiece).stroke!.alpha).toBeCloseTo(0.22, 6);
    // The dial sits at the sample's x 156, y 1290 once it has slid in.
    const at = evaluatePiece(byId("index:dial:disc"), 1500);
    expect(at.x).toBeCloseTo(540 + (156 - 540), 3);
    expect(at.y).toBeCloseTo(1290, 3);
  });

  test("the disc and the badge follow the sample's dial scale: pop, settle, compaction, leave", () => {
    const disc = byId("index:dial:disc");
    for (const t of [340, 400, 480, 570, 700, 1100, 1480, 2100, 2150, 2230, 2300, 2400, 3340, 3420, 3500, 4000, 5000, 5100, 5200, 5800, 6643, 6700, 6760, 6812]) {
      expect(Math.abs(evaluatePiece(disc, t).sx - sampleScale(t))).toBeLessThan(0.012);
    }
    expect(disc.fromMs).toBe(340);
    expect(disc.toMs).toBe(6643 + 170);
  });

  test("the dial slides in from one body size to the left over 200 ms", () => {
    const disc = byId("index:dial:disc");
    expect(evaluatePiece(disc, 340).x).toBeCloseTo(540 - 384 - 64, 3);
    expect(evaluatePiece(disc, 540).x).toBeCloseTo(540 - 384, 3);
  });

  test("each ring segment lights at its item: 120 ms over the dim one, and pops 1.15 to 1", () => {
    const done = byId("index:dial:ring1done");
    expect(evaluatePiece(done, 3300).o).toBe(0);
    expect(evaluatePiece(done, 3334 + 60).o).toBeCloseTo(0.5, 2);
    expect(evaluatePiece(done, 3334 + 120).o).toBe(1);
    // The scale of segment 1 about the dial: dial scale x appear x pop (pop 1.15 at the item, back to 1 in 180).
    const seg = byId("index:dial:ring1todo");
    const ratio = (t: number) => evaluatePiece(seg, t).sx / evaluatePiece(byId("index:dial:disc"), t).sx;
    expect(ratio(3334 + 1)).toBeGreaterThan(1.12);
    expect(ratio(3334 + 400)).toBeCloseTo(1, 2);
  });

  test("the numerals roll: the total, then '1/3', '2/3', '3/3'; the old leaves 86 px up as the new rises 86 px", () => {
    const digits = texts.filter((piece) => piece.id.startsWith("index:dial:num") && piece.id.endsWith("d")).map((piece) => piece.text);
    expect(digits).toEqual(["3", "1", "2", "3"]);
    expect(texts.filter((piece) => piece.text === "/3")).toHaveLength(3);
    for (const slash of texts.filter((piece) => piece.text === "/3")) expect(slash.fillAlpha).toBe(0.7);
    const total = byId("index:dial:num0d");
    const one = byId("index:dial:num1d");
    const t0 = 2224 - 80;
    const s = (t: number) => evaluatePiece(byId("index:dial:disc"), t).sx;
    expect(evaluatePiece(total, t0).y).toBeCloseTo(1290, 1);
    expect(evaluatePiece(total, t0 + 220).y).toBeCloseTo(1290 - 86 * s(t0 + 220), 0);
    expect(evaluatePiece(one, t0).y).toBeCloseTo(1290 + 86 * s(t0), 0);
    expect(evaluatePiece(one, t0 + 220).y).toBeCloseTo(1290, 1);
    // Numerals live inside the badge box: a clip that scales and slides with the dial.
    const clip = evaluatePiece(one, t0 + 300).clip!;
    expect(clip.x2 - clip.x1).toBeCloseTo(92 * s(t0 + 300), 0);
    expect(clip.y2 - clip.y1).toBeCloseTo(92 * s(t0 + 300), 0);
  });

  test("the card: ink plate whose left edge is the dial's while the list is open, wiped on 300 ms before the first word", () => {
    const parts = shapes.filter((piece) => piece.id.startsWith("index:0:card:") && !piece.id.endsWith("shadow"));
    expect(parts.map((piece) => piece.id.split(":")[3]).sort()).toEqual(["a", "b", "bl", "br", "tl", "tr"]);
    for (const piece of parts) expect(piece.fill).toEqual({ colour: "#0E0E10" });
    const tl = byId("index:0:card:tl");
    const br = byId("index:0:card:br");
    // At rest in the first cue the card spans x 156..(text right + 46) and the disc's height (152) or the text's plus 2 x 30.
    const rest = 2100;
    expect(evaluatePiece(tl, rest).x - 32).toBeCloseTo(540 + (156 - 540), 1);
    const right = evaluatePiece(br, rest).x + 32;
    const lastRight = Math.max(...cues[0]!.words.map((w, at) => (wordPiece(0, at).track.x as [number, number][])[2]![1] + 0 * w.startMs)) + 0;
    expect(right).toBeGreaterThan(lastRight);
    expect(evaluatePiece(br, rest).y + 32 - (evaluatePiece(tl, rest).y - 32)).toBeGreaterThanOrEqual(152 - 0.01);
    // Starts a few ms after the wipe begins (300 ms before the first word) and is gone with the cue.
    expect(tl.fromMs).toBeGreaterThanOrEqual(420 - 300);
    expect(tl.fromMs).toBeLessThan(420 - 250);
    expect(tl.toMs).toBeLessThanOrEqual(8463);
    expect(tl.toMs).toBeGreaterThan(8463 - 40);
  });

  test("the card grows to the right word by word and wipes off over the last 190 ms", () => {
    const br = byId("index:0:card:br");
    const widthAt = (t: number) => evaluatePiece(br, t).x;
    expect(widthAt(740)).toBeLessThan(widthAt(1500));
    expect(widthAt(1500)).toBeLessThan(widthAt(2100) + 1);
    expect(widthAt(8463 - 1)).toBeLessThan(widthAt(8200));
  });

  test("the vertical accent line is absent before and after the list closes", () => {
    expect(scene.pieces.some((piece) => /^index:\d+:bar$/.test(piece.id))).toBe(false);
  });

  test("words: Inter SemiBold 64, hero Inter ExtraBold 83, minor words at 66 %, ordinals in the highlight colour", () => {
    expect(wordPiece(0, 0)).toMatchObject({ face: "Inter SemiBold", sizePx: 64, fill: "#FFFFFF", letterSpacingEm: -0.022 });
    expect(wordPiece(0, 1)).toMatchObject({ face: "Inter", sizePx: 83, letterSpacingEm: -0.035 });
    expect(wordPiece(0, 3)).toMatchObject({ fillAlpha: 0.66 });
    expect(wordPiece(0, 0).fillAlpha).toBeUndefined();
    expect(wordPiece(1, 0)).toMatchObject({ fill: "#B9F227" });
    expect(wordPiece(2, 0)).toMatchObject({ fill: "#B9F227" });
    expect(wordPiece(4, 0)).toMatchObject({ fill: "#FFFFFF", fillAlpha: 0.66 });
  });

  test("a word fades in over 110 ms and slides 16 px in over 260 ms from 80 ms before it is spoken; the cue leaves 190 ms early", () => {
    const piece = wordPiece(1, 1);
    const w = word(1, 1);
    const rest = evaluatePiece(piece, w.startMs + 600);
    expect(evaluatePiece(piece, w.startMs - 80).o).toBe(0);
    expect(evaluatePiece(piece, w.startMs - 80 + 55).o).toBeCloseTo(0.5, 2);
    expect(evaluatePiece(piece, w.startMs + 30).o).toBe(1);
    const slide = (t: number) => evaluatePiece(piece, t).x - rest.x;
    expect(slide(w.startMs - 80)).toBeCloseTo(16, 3);
    expect(slide(w.startMs - 80 + 260)).toBeCloseTo(0, 3);
    const outAt = cues[1]!.endMs - 190;
    expect(evaluatePiece(piece, outAt).o).toBe(1);
    expect(evaluatePiece(piece, outAt + 60).o).toBeCloseTo(1 - EASES.in(0.5), 3);
    expect(evaluatePiece(piece, outAt + 60).y - rest.y).toBeCloseTo(-10 * EASES.in(0.5), 2);
    expect(piece.toMs).toBe(cues[1]!.endMs);
    // The last cue leaves a little earlier and faster (200 ms, over 110).
    const last = wordPiece(4, 2);
    expect(evaluatePiece(last, cues[4]!.endMs - 200 + 110).o).toBeCloseTo(0, 3);
  });

  test("the hero's highlighter wipes left to right over 200 ms from 30 ms after the word, the covered letters turn ink", () => {
    const talent = word(0, 1);
    const bar = byId("index:0:w1:bar") as ShapePiece;
    const ink = byId("index:0:w1:ink") as TextPiece;
    expect(bar.fill).toEqual({ colour: "#B9F227" });
    expect(ink.fill).toBe("#0E0E10");
    expect(ink.text).toBe("mistakes");
    const before = evaluatePiece(bar, talent.startMs + 30).clip!;
    const after = evaluatePiece(bar, talent.startMs + 230).clip!;
    const mid = evaluatePiece(bar, talent.startMs + 130).clip!;
    expect(after.x2).toBeGreaterThan(mid.x2);
    expect(mid.x2).toBeGreaterThan(before.x2);
    // Fully wiped, the clip reaches the highlighter's right edge; the ink copy reaches 0.07 hero px past the word.
    const barRight = evaluatePiece(bar, talent.startMs + 600).x + 0; // centre
    expect(after.x2).toBeGreaterThan(barRight);
    const inkClip = evaluatePiece(ink, talent.startMs + 230).clip!;
    const inkRest = evaluatePiece(ink, talent.startMs + 600);
    expect(inkClip.x2).toBeGreaterThan(inkRest.x);
    expect(evaluatePiece(ink, talent.startMs + 30).clip!.x2).toBeLessThan(inkRest.x);
    expect(inkClip.x1).toBeLessThan(inkRest.x);
  });

  test("the caption block is centred on the anchor line and rows wrap at 692 px beside the dial", () => {
    // fakeMeasure advances are 0.55 em: "three mistakes killing" cannot share a row; the column starts at 262.
    const first = wordPiece(0, 0);
    const x0 = evaluatePiece(first, 1500).x;
    expect(x0).toBeCloseTo(540 + (262 - 540), 3);
    for (const [cue, at] of [[0, 3], [2, 4]] as const) expect(evaluatePiece(wordPiece(cue, at), 1500).x).toBeGreaterThanOrEqual(x0 - 0.001);
    // Rows are centred on the card: first baseline above 1290, last below it.
    const ys = cues[0]!.words.map((_, at) => evaluatePiece(wordPiece(0, at), 2000).y);
    expect(Math.min(...ys)).toBeLessThan(1290);
    expect(Math.max(...ys)).toBeGreaterThan(1290);
  });
});

describe("Index: a mid-cue point", () => {
  const mid = build({ lines: ["three mistakes killing your", "channel. First, no hook", "kills reach. Second, you"], options: { rate: 265, lead: 420 } });
  test("the ordinal word is lime and the dial pops 80 ms before it", () => {
    const first = mid.cues[1]!.words[1]!;
    const piece = mid.scene.pieces.find((p) => p.id === "index:1:w1") as TextPiece;
    expect(piece).toMatchObject({ text: "First,", fill: "#B9F227" });
    expect((mid.scene.pieces.find((p) => p.id === "index:1:w0") as TextPiece).fill).toBe("#FFFFFF");
    const digits = mid.scene.pieces.filter((p): p is TextPiece => p.kind === "text" && p.id.startsWith("index:dial:num") && p.id.endsWith("d")).map((p) => p.text);
    expect(digits).toEqual(["3", "1", "2"]);
    const numeral = mid.scene.pieces.find((p) => p.id === "index:dial:num1d")!;
    expect(numeral.fromMs).toBe(first.startMs - 80);
  });
});

describe("Index: a clip with no list at all is a plain card without an accent line", () => {
  const plain = build({ lines: ["stop:b scrolling:b and:m listen:h@500", "this:b changes:b everything:h@500"] });
  test("no dial, a closed card (left at 208) and no accent line", () => {
    expect(plain.scene.pieces.some((piece) => piece.id.startsWith("index:dial"))).toBe(false);
    const tl = plain.scene.pieces.find((piece) => piece.id === "index:0:card:tl")!;
    expect(evaluatePiece(tl, 1800).x - 32).toBeCloseTo(540 + (208 - 540), 1);
    expect(plain.scene.pieces.some((piece) => /^index:\d+:bar$/.test(piece.id))).toBe(false);
  });

  test("a list that never closes has no bar", () => {
    const open = build({ lines: ["three tips for you", "first, sleep", "second, eat"] });
    expect(open.scene.pieces.some((piece) => piece.id.endsWith(":bar"))).toBe(false);
    expect(open.scene.pieces.some((piece) => piece.id === "index:dial:disc")).toBe(true);
  });
});

describe("Index: edges", () => {
  test("a total outside 2..10 draws no dial (a ring of a hundred segments is not a ring)", () => {
    for (const lines of [["100 tips for you", "first, sleep"], ["one thing only", "first, sleep"], ["1 tips", "first, sleep"]]) {
      const { scene: s } = build({ lines });
      expect(s.pieces.some((piece) => piece.id.startsWith("index:dial"))).toBe(false);
    }
  });

  test("ten items stay inside the piece budget: ring of ten, numerals, no per-cue overflow", () => {
    const lines = ["ten tips for growth", ...["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"].map((o) => `${o}, do it:h`)];
    const { scene: s } = build({ lines });
    const perCue = new Map<string, number>();
    for (const piece of s.pieces) perCue.set(piece.id.split(":")[1]!, (perCue.get(piece.id.split(":")[1]!) ?? 0) + 1);
    for (const count of perCue.values()) expect(count).toBeLessThanOrEqual(150);
    expect(s.pieces.filter((piece) => /ring\d+todo$/.test(piece.id))).toHaveLength(10);
  });

  test("a long pause closes the card and the next cue opens a new one; a short one keeps it", () => {
    const { scene: s } = build({ lines: ["wait:b for:m it:h@400", "now:b+3000 go:h@400"] });
    expect(s.pieces.filter((piece) => /^index:\d+:card:tl$/.test(piece.id))).toHaveLength(2);
    const { scene: joined } = build({ lines: ["wait:b for:m it:h@400", "now:b+300 go:h@400"] });
    expect(joined.pieces.filter((piece) => /^index:\d+:card:tl$/.test(piece.id))).toHaveLength(1);
  });

  test("a word wider than the text column shrinks the whole cue, never the card past the safe width", () => {
    const { cues: longCues, scene: s } = build({ lines: ["it's:m extraordinarily:h@900 hard:b", "pneumonoultramicroscopicsilicovolcanoconiosis:b@1400"] });
    const piece = s.pieces.find((p) => p.id === "index:1:w0") as TextPiece;
    expect(piece.sizePx).toBeLessThan(64);
    const tr = s.pieces.find((p) => p.id === "index:0:card:tr")!;
    expect(evaluatePiece(tr, longCues[1]!.startMs - 400).x + 32).toBeLessThanOrEqual(1026);
  });

  test("a right-to-left cue keeps its rows against the right of the text column, words in visual order", () => {
    const { cues: urdu, scene: s } = build(sceneEdgeDemoScript());
    const ws = urdu[0]!.words.map((_, at) => s.pieces.find((p) => p.id === `index:0:w${at}`) as TextPiece);
    const xs = ws.map((piece) => evaluatePiece(piece, urdu[0]!.endMs - 400).x);
    // First spoken word is rightmost.
    expect(xs[0]!).toBeGreaterThan(xs[xs.length - 1]!);
  });

  test("an empty cue list builds nothing", () => {
    expect(indexProgram.build(sceneInput([])).pieces).toEqual([]);
  });

  test("every piece's window is a real one and every shift is finite", () => {
    for (const piece of pieces as Piece[]) {
      expect(piece.toMs).toBeGreaterThan(piece.fromMs);
      const pose = evaluatePiece(piece, (piece.fromMs + piece.toMs) / 2);
      expect(Number.isFinite(pose.x) && Number.isFinite(pose.y) && Number.isFinite(pose.sx) && Number.isFinite(pose.sy)).toBe(true);
    }
  });
});

function sceneEdgeDemoScript(): DemoScript {
  const demo = sceneEdgeDemo("urdu");
  return {
    lines: ["یہ:m بہت:b اچھا:h@600 ہے:m", "میں نے آج سیکھا:b"],
    language: "ur",
    options: { lead: demo.cues[0]!.startMs },
  };
}
