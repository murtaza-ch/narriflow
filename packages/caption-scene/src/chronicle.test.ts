import { describe, expect, test } from "bun:test";
import { applyBrandColorsToScene, captionSceneMeta, getCaptionPresetById } from "@narriflow/validators";
import { describeSpeechConformance } from "./conformance-support";
import { type DemoScript, demoCues, sceneEdgeDemo } from "./demo";
import { exportFrameTimes } from "./frame-grid";
import type { SceneCue, SceneWord } from "./input";
import { type Box, type Piece, type TextPiece, evaluatePiece, pieceBounds } from "./scene";
import { asksQuestion, CHRONICLE_DEMO, chronicleProgram, chronicleYear } from "./templates/chronicle";
import { fakeMeasure, sceneInput } from "./test-support";

describeSpeechConformance("chronicle", chronicleProgram, { anchorLineY: 1370 });

const ANCHOR_Y = (1370 / 1920) * 100;
const build = (script: DemoScript | readonly SceneCue[], overrides: Parameters<typeof sceneInput>[1] = {}) => {
  const cues = (Array.isArray(script) ? (script as readonly SceneCue[]) : demoCues(script as DemoScript).cues).map((c, index) => ({ ...c, index }));
  return { cues, pieces: chronicleProgram.build(sceneInput(cues, { anchor: { xPct: 50, yPct: ANCHOR_Y }, fps: 30, ...overrides })).pieces };
};
const cueOf = (piece: Piece) => Number(piece.id.split(":")[1]);
const isTimeline = (piece: Piece) => piece.id.startsWith("chronicle:tl:");
const meets = (a: Box, b: Box) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
const shown = (piece: Piece, t: number) => {
  const pose = evaluatePiece(piece, t);
  return pose.visible && pose.o > 0.05 ? pieceBounds(piece, t, fakeMeasure) : null;
};
const union = (boxes: readonly Box[]): Box => ({
  x1: Math.min(...boxes.map((b) => b.x1)), y1: Math.min(...boxes.map((b) => b.y1)), x2: Math.max(...boxes.map((b) => b.x2)), y2: Math.max(...boxes.map((b) => b.y2)),
});
const digitsOf = (pieces: readonly Piece[], cue: number) =>
  pieces.filter((piece): piece is TextPiece => piece.kind === "text" && new RegExp(`^chronicle:${cue}:num\\d+d\\d+$`).test(piece.id));
const word = (text: string, startMs: number, endMs: number, role: SceneWord["role"] = "body"): SceneWord => ({ text, startMs, endMs, role, key: null });
let next = 0;
const cue = (words: readonly SceneWord[], language = "en", endMs = words.at(-1)!.endMs + 200): SceneCue =>
  ({ index: next++, startMs: words[0]!.startMs, endMs, speaker: null, language, words });

describe("Chronicle", () => {
  test("the preset, the catalogue row and the brand map", () => {
    expect(getCaptionPresetById("chronicle")!.preset).toMatchObject({ scene: "chronicle", wordsPerCue: 4 });
    const meta = captionSceneMeta("chronicle");
    expect(meta).toMatchObject({ bodyPx: 72, anchorLineY: 1370, wordsPerCue: 4, fontName: "Newsreader Medium", colours: { primary: "#F4F1EA", highlight: "#F2C14E" } });
    expect(meta.brand).toEqual({ primary: { slot: "primaryColor", readsOn: ["#101010"] }, secondary: { slot: "highlightColor", readsOn: ["#101010"] } });
  });

  test("a year is four digits of any script, 1500 to 2099, with punctuation and a decade s around it", () => {
    for (const [text, year] of [
      ["1969", "1969"], ["1969,", "1969"], ["(1969)", "1969"], ["\"1969.\"", "1969"], ["—1969—", "1969"], ["1990s", "1990s"], ["1990's", "1990s"], ["1500", "1500"], ["2099", "2099"],
      ["१९६९", "1969"], ["١٩٦٩", "1969"], ["۱۹۶۹،", "1969"], ["১৯৬৯", "1969"], ["１９６９", "1969"], ["១៩៦៩", "1969"], ["༡༩༦༩", "1969"], ["𝟏𝟗𝟔𝟗", "1969"],
    ] as const) expect(chronicleYear(text), text).toBe(year);
    for (const text of ["1499", "2100", "12", "19690", "1,969", "1.969", "$1969", "1969%", "19a9", "abcd", "nineteen", "", "-", "'69", "१९६", "2024x", "-1969", "+1969", "\u22121969", "-1969-"]) {
      expect(chronicleYear(text), text).toBeNull();
    }
  });

  test("a question ends in a question mark of any script, with ?! and closing quotes after it", () => {
    for (const text of ["stop?", "why?!", "\"really?\"", "(huh?)", "?", "क्या?", "ماذا؟", "何？", "τι\u037E", "何\uFE56", "¿qué pasa?", "なに\u2047", "ምንድን\u1367"]) expect(asksQuestion(text), text).toBe(true);
    for (const text of ["stop.", "¿qué", "what", "a?b", "stop!", "", "…", "stop;"]) expect(asksQuestion(text), text).toBe(false);
  });

  test("the year rises digit by digit out of a window at the numeral's baseline, above the text and inside the safe area", () => {
    const { cues, pieces } = build(CHRONICLE_DEMO);
    const digits = digitsOf(pieces, 0);
    expect(digits.map((digit) => digit.text).join("")).toBe("1969");
    const start = cues[0]!.words[1]!.startMs - 60;
    expect(digits.map((digit) => digit.fromMs)).toEqual([start, start + 50, start + 100, start + 150]);
    for (const digit of digits) {
      expect(digit.fillAlpha).toBe(0);
      expect(digit.face).toBe("DM Serif Display");
      // Hidden behind the window at the first frame, risen and whole 300 ms later.
      expect(shown(digit, digit.fromMs), `${digit.id} shows before it rises`).toBeNull();
      expect(shown(digit, digit.fromMs + 330), `${digit.id} never shows`).not.toBeNull();
    }
    const t = start + 600;
    const numeral = union(digits.map((digit) => shown(digit, t)!));
    const words = pieces.filter((piece) => /^chronicle:0:w\d+$/.test(piece.id)).map((piece) => shown(piece, t)).filter((box): box is Box => box !== null);
    expect(numeral.y2).toBeLessThan(Math.min(...words.map((box) => box.y1)));
    expect(numeral.x2).toBeLessThanOrEqual(1080 * 0.95 + 1);
    expect(numeral.y1).toBeGreaterThanOrEqual(1920 * 0.05);
    // Right aligned on the sample's column edge, as the sample's numeral is.
    expect(numeral.x2).toBeGreaterThan(900);
  });

  test("a year in another script is drawn in the digits the face has, and nothing is drawn that was not said", () => {
    const hindi = [cue([word("सन", 400, 700), word("१९६९", 700, 1300), word("में", 1300, 1500), word("चाँद", 1500, 2000, "hero")], "hi")];
    const { pieces } = build(hindi);
    expect(digitsOf(pieces, 0).map((digit) => digit.text).join("")).toBe("1969");
    const said = new Set(hindi[0]!.words.map((w) => w.text));
    for (const piece of pieces) {
      if (piece.kind === "text") expect(said.has(piece.text) || /^[0-9]$/.test(piece.text), piece.id).toBe(true);
    }
  });

  test("every text piece is a spoken word, a digit of a spoken year or the mark of a spoken question", () => {
    const run = demoCues({ lines: ["so:m in:m 1969:b we:b stopped:h@500", "why:b did:m we:m stop?:h@500", "really:b?", "the:m 1990s:b were:m wild:h@400", "is:m 2024:b the:m year?:h@400", "plain:b words:b only:h"], options: { rate: 200, cueGap: 100 } }).cues;
    const { pieces } = build(run);
    for (const piece of pieces) {
      if (piece.kind !== "text") continue;
      const spoken = run[cueOf(piece)]!.words.map((w) => w.text);
      const own = /:(?:w\d+)$/.test(piece.id) ? spoken.includes(piece.text) : /:ask/.test(piece.id) ? piece.text === "?" && spoken.some(asksQuestion) : spoken.some((w) => (chronicleYear(w) ?? "").includes(piece.text));
      expect(own, `${piece.id} draws "${piece.text}"`).toBe(true);
    }
    // Only the cues that name a year or ask a question get a numeral.
    const numeral = (index: number) => pieces.filter((piece) => cueOf(piece) === index && /:(?:num|ask)/.test(piece.id)).length;
    expect([numeral(0) > 0, numeral(1) > 0, numeral(2) > 0, numeral(3) > 0, numeral(4) > 0, numeral(5) > 0]).toEqual([true, true, true, true, true, false]);
  });

  test("the question mark turns up at the question word, upright and above the text", () => {
    const { cues, pieces } = build(CHRONICLE_DEMO);
    const mark = pieces.find((piece) => piece.id === "chronicle:2:ask0")!;
    const stop = cues[2]!.words.at(-1)!;
    expect(mark.fromMs).toBe(stop.startMs - 60);
    expect(evaluatePiece(mark, mark.fromMs).rz).toBeCloseTo(12, 3);
    expect(evaluatePiece(mark, mark.fromMs + 400).rz).toBeCloseTo(0, 3);
    const box = shown(mark, stop.startMs + 500)!;
    const words = pieces.filter((piece) => /^chronicle:2:w\d+$/.test(piece.id)).map((piece) => shown(piece, stop.startMs + 500)!);
    expect(box.y2).toBeLessThan(Math.min(...words.map((b) => b.y1)));
  });

  test("the timeline spans the clip: a tick for every word, passing the playhead at its spoken start, visible long before it", () => {
    const { cues, pieces } = build(CHRONICLE_DEMO);
    const ticks = pieces.filter((piece) => /^chronicle:tl:tick/.test(piece.id));
    const words = cues.flatMap((c) => c.words.map((w) => ({ c, w })));
    expect(ticks.length).toBe(words.length);
    const playhead = pieces.find((piece) => piece.id === "chronicle:tl:playhead")!;
    const playX = evaluatePiece(playhead, 1000).x;
    for (const { c, w } of words) {
      const tick = ticks.find((piece) => piece.id === `chronicle:tl:tick${c.index}-${c.words.indexOf(w)}`)!;
      expect(evaluatePiece(tick, w.startMs).x).toBeCloseTo(playX, 3);
      // Linear: a quarter of a second earlier it is 62.5 px to the right.
      expect(evaluatePiece(tick, w.startMs - 250).x - playX).toBeCloseTo(62.5, 1);
    }
    // Cue 4's first tick is already on the strip 2.4 s before it is said.
    const later = ticks.find((piece) => piece.id === "chronicle:tl:tick4-0")!;
    expect(shown(later, 6000)).not.toBeNull();
    // Nothing of the strip is drawn after the last cue.
    for (const piece of pieces.filter(isTimeline)) expect(piece.toMs).toBeLessThanOrEqual(cues.at(-1)!.endMs);
  });

  test("the extra beats recur on every cue: a bracket under the baseline and a ring from the playhead", () => {
    const { cues, pieces } = build(CHRONICLE_DEMO);
    for (const c of cues) {
      expect(pieces.some((piece) => piece.id === `chronicle:tl:span${c.index}`), `bracket of cue ${c.index}`).toBe(true);
      expect(pieces.some((piece) => piece.id === `chronicle:tl:ring${c.index}`), `ring of cue ${c.index}`).toBe(true);
    }
    expect(pieces.filter((piece) => /^chronicle:tl:ringhero/.test(piece.id)).length).toBeGreaterThanOrEqual(3);
  });

  test("the timeline stays clear of every caption word", () => {
    const run = demoCues({ lines: ["so:m here:b is:m the:m thing:h@300", "nobody:b tells:b you:m this:b very:b much:b today:h", "1969:b and:m stop?:h@500"], options: { cueGap: 0, rate: 220 } }).cues;
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }, { width: 1920, height: 1080 }]) {
      for (const scale of [1, 2]) {
        const { pieces } = build(run, { canvas, scale, anchor: { xPct: 50, yPct: ANCHOR_Y } });
        const end = run.at(-1)!.endMs;
        for (const t of exportFrameTimes(run[0]!.startMs - 100, end, 30)) {
          const strip = pieces.filter(isTimeline).flatMap((piece) => shown(piece, t) ?? []);
          const text = pieces.filter((piece) => !isTimeline(piece) && /:w\d+$/.test(piece.id)).flatMap((piece) => shown(piece, t) ?? []);
          for (const a of strip) for (const b of text) expect(meets(a, b), `strip meets a word at ${t}, ${canvas.width}x${canvas.height} x${scale}`).toBe(false);
        }
      }
    }
  });

  test("the text is left aligned and sits on the same baseline whatever the row count", () => {
    const run = [
      cue([word("short", 400, 700), word("line", 700, 1000, "hero")]),
      cue([word("a", 1200, 1300), word("rather", 1300, 1700), word("long", 1700, 2000), word("sentence", 2000, 2500), word("that", 2500, 2800), word("wraps", 2800, 3200, "hero")]),
    ];
    const { pieces } = build(run);
    const faces = (index: number) => pieces.filter((piece): piece is TextPiece => piece.kind === "text" && new RegExp(`^chronicle:${index}:w\\d+$`).test(piece.id));
    const lastBaseline = (index: number) => Math.max(...faces(index).map((piece) => evaluatePiece(piece, run[index]!.words.at(-1)!.endMs).y));
    expect(lastBaseline(0)).toBeCloseTo(lastBaseline(1), 3);
    const rows = new Set(faces(1).map((piece) => Math.round(evaluatePiece(piece, 3300).y)));
    expect(rows.size).toBeGreaterThan(1);
    // The first word of each row starts at the column's left edge (sample x 86).
    for (const index of [0, 1]) {
      const first = faces(index).filter((piece) => /:w0$/.test(piece.id))[0]!;
      expect(shown(first, run[index]!.words.at(-1)!.endMs)!.x1).toBeCloseTo(86, 0);
    }
  });

  test("a right-to-left cue mirrors: text flush right, the numeral on the left", () => {
    const arabic = [cue([word("في", 400, 600), word("1969", 600, 1200), word("مشى", 1200, 1600), word("الإنسان", 1600, 2200, "hero")], "ar")];
    const { pieces } = build(arabic);
    const t = 2100;
    const words = pieces.filter((piece) => /^chronicle:\d+:w\d+$/.test(piece.id)).flatMap((piece) => shown(piece, t) ?? []);
    expect(union(words).x2).toBeCloseTo(994, 0);
    const numeral = union(digitsOf(pieces, 0).flatMap((digit) => shown(digit, t) ?? []));
    expect(numeral.x1).toBeLessThan(150);
  });

  test("a year stays 1.5 s after its cue while nothing later draws in its box, and never over a later cue", () => {
    const { cues, pieces } = build(CHRONICLE_DEMO);
    const year = digitsOf(pieces, 0);
    // "on the moon" is a single short row: the 1969 numeral stays through it.
    expect(shown(year[0]!, cues[0]!.endMs + 600)).not.toBeNull();
    expect(shown(year[3]!, cues[0]!.endMs + 600)).not.toBeNull();
    // A year cue followed by a tall cue: the numeral is gone before anything of the next cue paints in its box.
    const run = demoCues({ lines: ["in:m 1969:b@500", "so:m the:m real:b reason:b most:b people:h@500 never:b get:b there:m really:b", "and:m that's:m fine:b"], options: { cueGap: 100, rate: 250 } }).cues;
    const second = build(run);
    const numeral = digitsOf(second.pieces, 0);
    const later = second.pieces.filter((piece) => cueOf(piece) > 0 && !isTimeline(piece));
    let overlapped = 0;
    for (const t of exportFrameTimes(run[0]!.startMs, run.at(-1)!.endMs, 30)) {
      const box = numeral.flatMap((digit) => shown(digit, t) ?? []);
      if (box.length === 0) continue;
      const mine = union(box);
      for (const piece of later) {
        const other = shown(piece, t);
        if (other && meets(mine, other)) overlapped++;
      }
    }
    expect(overlapped).toBe(0);
    // And it is never held past the clip.
    for (const digit of numeral) expect(digit.toMs).toBeLessThanOrEqual(run.at(-1)!.endMs);
  });

  test("a second year replaces the first in its slot, and a year then a question share the slot in order", () => {
    const run = [cue([word("from", 400, 600), word("1969", 600, 1200), word("to", 1200, 1400), word("1972", 1400, 2000), word("why?", 2000, 2500, "hero")])];
    const { pieces } = build(run);
    const first = pieces.filter((piece) => /^chronicle:\d+:num0d\d$/.test(piece.id));
    const second = pieces.filter((piece) => /^chronicle:\d+:num1d\d$/.test(piece.id));
    const mark = pieces.find((piece) => /:ask2$/.test(piece.id))!;
    expect(first.map((piece) => (piece as TextPiece).text).join("")).toBe("1969");
    expect(second.map((piece) => (piece as TextPiece).text).join("")).toBe("1972");
    // Each leaves as the next arrives.
    expect(Math.max(...first.map((piece) => piece.toMs))).toBeLessThanOrEqual(Math.min(...second.map((piece) => piece.fromMs)) + 1);
    expect(Math.max(...second.map((piece) => piece.toMs))).toBeLessThanOrEqual(mark.fromMs + 1);
    for (const t of exportFrameTimes(400, 2600, 30)) {
      const boxes = [first, second, [mark]].map((group) => group.flatMap((piece) => shown(piece, t) ?? []));
      const live = boxes.filter((b) => b.length > 0).map(union);
      for (const [i, a] of live.entries()) for (const b of live.slice(i + 1)) expect(meets(a, b), `numerals overlap at ${t}`).toBe(false);
    }
  });

  test("the numeral shrinks to fit and everything stays in the safe area on every aspect ratio and at twice the size", () => {
    const run = demoCues(CHRONICLE_DEMO).cues;
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }, { width: 1920, height: 1080 }]) {
      for (const scale of [0.6, 1, 2]) {
        const { pieces } = build(run, { canvas, scale });
        const safe = { x1: 0.05 * canvas.width - 1, y1: 0.05 * canvas.height - 1, x2: 0.95 * canvas.width + 1, y2: 0.95 * canvas.height + 1 };
        for (const piece of pieces) {
          for (const t of exportFrameTimes(piece.fromMs, piece.toMs, 30)) {
            const box = pieceBounds(piece, t, fakeMeasure);
            if (!box) continue;
            const inside = box.x1 >= safe.x1 && box.y1 >= safe.y1 && box.x2 <= safe.x2 && box.y2 <= safe.y2;
            expect(inside, `${piece.id} at ${t} on ${canvas.width}x${canvas.height} x${scale}: ${JSON.stringify(box)}`).toBe(true);
          }
        }
      }
    }
  });

  test("a nine-word cue, a long word and an Urdu cue keep every word inside the column", () => {
    for (const kind of ["nine-words", "long-word", "urdu", "one-word"] as const) {
      const { cues } = sceneEdgeDemo(kind);
      const { pieces } = build(cues);
      for (const c of cues) {
        const t = c.words.at(-1)!.endMs - 20;
        for (const [at] of c.words.entries()) {
          const face = pieces.find((piece) => piece.id === `chronicle:${c.index}:w${at}`)!;
          const box = shown(face, t)!;
          expect(box, `${face.id} (${kind})`).not.toBeNull();
          expect(box.x1).toBeGreaterThanOrEqual(0.05 * 1080 - 1);
          expect(box.x2).toBeLessThanOrEqual(0.95 * 1080 + 1);
        }
      }
    }
  });


  test("brand colours that vanish on dark footage are refused, readable ones are taken", () => {
    const preset = { primaryColor: "#F4F1EA", highlightColor: "#F2C14E" };
    expect(applyBrandColorsToScene("chronicle", preset, { primaryColor: "#000000", secondaryColor: "#000000" })).toEqual({});
    expect(applyBrandColorsToScene("chronicle", preset, { primaryColor: "#1A1A2E", secondaryColor: "#202020" })).toEqual({});
    expect(applyBrandColorsToScene("chronicle", preset, { primaryColor: "#FFFFFF", secondaryColor: "#FF6B6B" })).toEqual({ primaryColor: "#FFFFFF", highlightColor: "#FF6B6B" });
  });

  test("a year spoken fast is compressed to the time it has, whole before it leaves, or left out; never shown half risen", () => {
    for (const fps of [24, 30, 60]) {
      for (const end of [420, 480, 560, 700, 900, 1200, 1700]) {
        const run = [cue([word("1969", 300, 400), word("now", 400, 560), word("we", 560, 900), word("know", 900, 1500)], "en", end)];
        const digits = digitsOf(build(run, { fps }).pieces, 0);
        if (digits.length === 0) continue;
        expect(digits.length, `cue ending ${end} at ${fps} fps`).toBe(4);
        const risen = Math.max(...digits.map((digit) => digit.track.y!.at(-1)![0]));
        const leaves = Math.min(...digits.map((digit) => digit.toMs));
        // Every digit has risen, with a moment to read the year, before any of it fades.
        expect(risen + 100, `cue ending ${end} at ${fps} fps`).toBeLessThanOrEqual(leaves + 1);
        for (const digit of digits) expect(shown(digit, risen + 20), `${digit.id} (cue ending ${end})`).not.toBeNull();
      }
    }
    // A cue that leaves before the year could finish rising draws none of it.
    expect(digitsOf(build([cue([word("1969", 300, 400), word("now", 400, 440)], "en", 460)]).pieces, 0)).toEqual([]);
  });

  test("two speakers at once get lanes of the same height above the timeline, at about the same readable size", () => {
    const first = cue([word("from", 400, 700), word("1969", 700, 1000), word("one", 1000, 1300), word("question?", 1300, 1900, "hero")]);
    const second = { ...cue([word("I", 400, 600), word("spoke", 600, 900), word("in", 900, 1100), word("1972", 1100, 1700, "hero")]), speaker: 1 };
    for (const [canvas, scale] of [[{ width: 1920, height: 1080 }, 2], [{ width: 1920, height: 1080 }, 1], [{ width: 1080, height: 1920 }, 1], [{ width: 1080, height: 1080 }, 2]] as const) {
      const { pieces } = build([first, second], { canvas, scale });
      const size = (index: number) => Math.min(...pieces.filter((piece): piece is TextPiece => piece.kind === "text" && new RegExp(`^chronicle:${index}:w\\d+$`).test(piece.id)).map((piece) => piece.sizePx));
      const ratio = size(0) / size(1);
      expect(ratio, `${canvas.width}x${canvas.height} x${scale}: ${size(0)} vs ${size(1)}`).toBeGreaterThan(0.7);
      expect(ratio).toBeLessThan(1.45);
      const unit = (Math.min(canvas.width, canvas.height) / 1080) * scale;
      expect(Math.min(size(0), size(1))).toBeGreaterThan(24 * unit);
      // Above the strip: no word reaches the playhead's cap.
      const capTop = pieceBounds(pieces.find((piece) => piece.id === "chronicle:tl:cap")!, 1000, fakeMeasure)!.y1;
      for (const piece of pieces.filter((p) => /:w\d+$/.test(p.id) && !isTimeline(p))) {
        for (const t of exportFrameTimes(piece.fromMs, piece.toMs, 30)) {
          const box = shown(piece, t);
          if (box) expect(box.y2, `${piece.id} at ${t}`).toBeLessThanOrEqual(capTop);
        }
      }
    }
  });

  test("a clip of one short cue still shows the timeline and its ring", () => {
    for (const fps of [24, 30, 60]) {
      const { pieces } = build([cue([word("go", 300, 400)], "en", 600)], { fps });
      const line = pieces.find((piece) => piece.id === "chronicle:tl:line")!;
      const peak = Math.max(...exportFrameTimes(line.fromMs, line.toMs, fps).map((t) => evaluatePiece(line, t).o));
      expect(peak, `baseline peak at ${fps} fps`).toBeGreaterThan(0.5);
      expect(pieces.some((piece) => piece.id === "chronicle:tl:ring0"), `ring at ${fps} fps`).toBe(true);
      expect(pieces.some((piece) => piece.id === "chronicle:tl:playhead")).toBe(true);
    }
  });

  test("no timeline piece covers a readable word, with ink as tall as Devanagari's, at any size and shape", () => {
    // Tall ink above and below the baseline, as a Devanagari word has, and wider than the stand-in's 0.55 em.
    const tall = (text: string, _face: string, sizePx: number, letterSpacingEm: number) => ({
      advance: [...text].length * (0.6 + letterSpacingEm) * sizePx, inkTop: -0.95 * sizePx, inkBottom: 0.36 * sizePx, ascent: 1.2 * sizePx, descent: 0.4 * sizePx,
    });
    const run = demoCues({ lines: ["so:m here:b is:m the:m thing:h@300", "1969:b and:m stop?:h@500", "nobody:b tells:b you:m this:b very:b much:b today:h", "ok:m go:h@200"], options: { cueGap: 0, rate: 220 } }).cues;
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }, { width: 1920, height: 1080 }]) {
      for (const scale of [0.7, 1, 2]) {
        const { pieces } = build(run, { canvas, scale, measure: tall });
        const painted = (piece: Piece, t: number) => {
          const pose = evaluatePiece(piece, t);
          return pose.visible && pose.o > 0.15 ? pieceBounds(piece, t, tall) : null;
        };
        for (const t of exportFrameTimes(run[0]!.startMs - 100, run.at(-1)!.endMs, 30)) {
          const strip = pieces.filter(isTimeline).flatMap((piece) => painted(piece, t) ?? []);
          const text = pieces.filter((piece) => /:w\d+$/.test(piece.id)).flatMap((piece) => painted(piece, t) ?? []);
          for (const a of strip) for (const b of text) expect(meets(a, b), `the strip covers a word at ${t}, ${canvas.width}x${canvas.height} x${scale}`).toBe(false);
        }
      }
    }
  });

  test("an empty clip builds nothing", () => {
    expect(chronicleProgram.build(sceneInput([])).pieces).toEqual([]);
  });
});
