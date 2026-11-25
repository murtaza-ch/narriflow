import { describe, expect, test } from "bun:test";
import { demoCues } from "./demo";
import { exportFrameTimes } from "./frame-grid";
import { describeSpeechConformance } from "./conformance-support";
import { evaluatePiece, pieceBounds } from "./scene";
import { fakeMeasure, sceneInput } from "./test-support";
import { TUNNEL_DEMO, tunnelProgram } from "./templates/tunnel";

describeSpeechConformance("tunnel", tunnelProgram, { anchorLineY: 1290 });

const build = (lines: readonly string[], options = TUNNEL_DEMO.options) => {
  const { cues } = demoCues({ lines, options });
  return { cues, pieces: tunnelProgram.build(sceneInput(cues, { fps: 30, anchor: { xPct: 50, yPct: (1290 / 1920) * 100 } })).pieces };
};

describe("tunnel", () => {
  test("draws no box, frame or outline: only words, streaks and dashes", () => {
    const { pieces } = build(TUNNEL_DEMO.lines);
    for (const piece of pieces) {
      if (piece.kind === "shape") {
        expect(piece.stroke, piece.id).toBeUndefined();
        expect(/streak|dash/.test(piece.id), piece.id).toBe(true);
      }
    }
  });

  test("every cue draws its speed streaks; the dashes come whenever the word's row leaves room beside it", () => {
    const { cues, pieces } = build(TUNNEL_DEMO.lines);
    for (const cue of cues) {
      const own = pieces.filter((piece) => piece.id.startsWith(`tunnel:${cue.index}:`));
      expect(own.filter((piece) => piece.id.includes(":streak")).length, `cue ${cue.index} streaks`).toBeGreaterThanOrEqual(6);
    }
    // A key word fitted to the full column ("breakthrough") leaves no room for dashes ("deeper" too); the other cues get them.
    for (const index of [0, 2, 4]) {
      expect(pieces.filter((piece) => piece.id.startsWith(`tunnel:${index}:dash`)).length, `cue ${index} dashes`).toBeGreaterThanOrEqual(2);
    }
  });

  test("the key word is lime and lands with a spring overshoot", () => {
    const { cues, pieces } = build(TUNNEL_DEMO.lines);
    const hero = pieces.find((piece) => piece.id === "tunnel:1:w3")!;
    expect(hero.kind === "text" && hero.fill).toBe(sceneInput([]).colours.highlight);
    let peak = 0;
    for (const t of exportFrameTimes(cues[1]!.words[3]!.startMs - 80, cues[1]!.words[3]!.startMs + 500, 30)) peak = Math.max(peak, evaluatePiece(hero, t).sx);
    expect(peak).toBeGreaterThan(1.03);
  });

  test("a cue flies in from depth: small and blurred first, full size and sharp once settled", () => {
    const { cues, pieces } = build(TUNNEL_DEMO.lines);
    const word = pieces.find((piece) => piece.id === "tunnel:0:w0")!;
    const start = cues[0]!.words[0]!.startMs;
    const early = evaluatePiece(word, start - 60);
    const late = evaluatePiece(word, start + 600);
    expect(early.sx).toBeLessThan(0.85);
    expect(early.blur).toBeGreaterThan(2);
    expect(late.sx).toBeCloseTo(1, 1);
    expect(late.blur).toBeLessThan(0.5);
  });

  test("the stack re-centres smoothly: no word jumps more than a few px between frames, even at 70 ms per word", () => {
    const { cues, pieces } = build(["one:b@70 two:b@70 three:b@70 four:b@70 five:b@70"], { lead: 400, tail: 800 });
    for (const piece of pieces.filter((p) => /^tunnel:0:w\d$/.test(p.id))) {
      let last: number | null = null;
      for (const t of exportFrameTimes(piece.fromMs + 70, piece.toMs, 60)) {
        const x = evaluatePiece(piece, t).x;
        if (last !== null) expect(Math.abs(x - last), `${piece.id} at ${t}`).toBeLessThan(60);
        last = x;
      }
    }
    expect(cues.length).toBe(1);
  });

  test("the previous cue never covers the incoming words while it leaves", () => {
    for (const cueGap of [0, 60, 150, 400]) {
      const { cues, pieces } = build(TUNNEL_DEMO.lines, { ...TUNNEL_DEMO.options, cueGap });
      for (let c = 1; c < cues.length; c++) {
        const incoming = pieces.filter((piece) => piece.id.startsWith(`tunnel:${c}:w`));
        const outgoing = pieces.filter((piece) => piece.id.startsWith(`tunnel:${c - 1}:`));
        for (const t of exportFrameTimes(cues[c]!.startMs - 150, cues[c]!.startMs + 800, 30)) {
          for (const a of incoming) {
            const boxA = pieceBounds(a, t, fakeMeasure);
            if (!boxA) continue;
            for (const b of outgoing) {
              const boxB = pieceBounds(b, t, fakeMeasure);
              if (!boxB) continue;
              const meets = boxA.x1 < boxB.x2 && boxB.x1 < boxA.x2 && boxA.y1 < boxB.y2 && boxB.y1 < boxA.y2;
              expect(meets, `cue ${c - 1} ${b.id} meets ${a.id} at ${t}, gap ${cueGap}`).toBe(false);
            }
          }
        }
      }
    }
  });

  test("with room, the outgoing cue zooms out: it grows and fades before it leaves", () => {
    const { cues, pieces } = build(TUNNEL_DEMO.lines, { ...TUNNEL_DEMO.options, cueGap: 700 });
    const word = pieces.find((piece) => piece.id === "tunnel:0:w2")!;
    const rest = evaluatePiece(word, cues[0]!.words[2]!.endMs + 100);
    const gone = evaluatePiece(word, word.toMs - 20);
    expect(gone.sx).toBeGreaterThan(rest.sx);
    expect(gone.o).toBeLessThan(0.5);
    expect(gone.blur).toBeGreaterThan(rest.blur);
  });
});
