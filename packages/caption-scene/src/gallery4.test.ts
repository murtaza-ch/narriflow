import { expect, test } from "bun:test";
import { captionSceneMeta } from "@narriflow/validators";
import { describeSpeechConformance } from "./conformance-support";
import { demoCues } from "./demo";
import { exportFrameAtOrAfter, exportFrameTimes } from "./frame-grid";
import { CAPTION_SCENE_PROGRAMS } from "./registry";
import { evaluatePiece, pieceBounds, pieceLocalBox } from "./scene";
import { sceneInput } from "./test-support";
import { rotatePoint } from "./templates/gallery-layout";

const styles = [
  "primer",
  "manifesto",
  "swipe",
  "match",
  "scribble",
  "barrel",
  "pills",
  "pixel",
  "diecut",
  "sticky",
  "brute",
  "mdrn",
  "crosstape",
  "gumdrop",
  "flowing",
  "trace",
] as const;

for (const name of styles) {
  describeSpeechConformance(name, CAPTION_SCENE_PROGRAMS[name].program, { anchorLineY: captionSceneMeta(name).anchorLineY });
}

test("Manifesto assembles a readable word by its spoken start without a rule on plain rows", () => {
  const { cues } = demoCues({ lines: ["start:b before:b you:m feel:b ready:h@520"] });
  const { pieces } = CAPTION_SCENE_PROGRAMS.manifesto.program.build(sceneInput(cues, { fps: 60 }));
  const word = cues[0]!.words[3]!;
  const face = pieces.find((piece) => piece.id === "manifesto:0:w3")!;
  const slices = pieces.filter((piece) => piece.id.startsWith("manifesto:0:w3s"));

  expect(slices).toHaveLength(4);
  expect(face.fromMs).toBeLessThanOrEqual(word.startMs);
  for (const slice of slices) {
    expect(slice.toMs).toBe(face.fromMs);
    expect(Math.abs(slice.track.x![0]![1] - face.track.x![0]![1])).toBeLessThanOrEqual(10);
  }
  expect(pieces.filter((piece) => piece.kind === "shape").map((piece) => piece.id)).toEqual(["manifesto:0:bar2"]);
});

test("Swipe keeps tilted strips clear of neighbouring lettering throughout the reveal", () => {
  const { cues } = demoCues({ lines: ["this out as safely as possible:h@620"] });
  const input = sceneInput(cues, { fps: 60 });
  const { pieces } = CAPTION_SCENE_PROGRAMS.swipe.program.build(input);
  const strips = pieces.filter((piece) => piece.id.startsWith("swipe:0:swipe"));
  expect(strips).toHaveLength(2);
  const [body, hero] = strips;
  const faces = pieces.filter((piece) => piece.kind === "text");
  const emphasis = faces.find((piece) => piece.id === "swipe:0:w5")!;
  const frames = exportFrameTimes(Math.max(body!.fromMs, hero!.fromMs), Math.min(body!.toMs, hero!.toMs), input.fps);

  expect(frames.length).toBeGreaterThan(1);
  for (const frame of frames) {
    const earlier = pieceBounds(body!, frame, input.measure);
    const later = pieceBounds(hero!, frame, input.measure);
    expect(earlier).not.toBeNull();
    expect(later).not.toBeNull();
    const heroInk = pieceBounds(emphasis, frame, input.measure);
    if (heroInk) expect(heroInk.y1).toBeGreaterThan(earlier!.y2);
    for (const face of faces.filter((piece) => piece !== emphasis)) {
      const ink = pieceBounds(face, frame, input.measure);
      if (ink) expect(later!.y1).toBeGreaterThan(ink.y2);
    }
  }
});

test.each([
  ["trust the process:h@560", 2, 25],
  ["promises of accelerated:h@520 timelines:h@520", 3, 34],
] as const)("Swipe keeps the sample's compact pitch for %s", (line, rowCount, maxGap) => {
  const { cues } = demoCues({ lines: [line] });
  const input = sceneInput(cues);
  const { pieces } = CAPTION_SCENE_PROGRAMS.swipe.program.build(input);
  const strips = pieces.filter((piece) => piece.id.startsWith("swipe:0:swipe"));
  expect(strips).toHaveLength(rowCount);
  const time = cues[0]!.words.at(-1)!.endMs - 50;
  const rest = strips.map((strip) => {
    const pose = evaluatePiece(strip, time);
    const origin = rotatePoint(strip.origin?.dx ?? 0, 0, pose.rz)[1];
    const box = pieceLocalBox(strip, input.measure);
    return { centre: pose.y - origin, halfHeight: (box.y2 - box.y1) / 2 };
  });
  for (let i = 1; i < rest.length; i++) {
    const previous = rest[i - 1]!;
    const current = rest[i]!;
    expect(current.centre - previous.centre - previous.halfHeight - current.halfHeight).toBeLessThanOrEqual(maxGap);
  }
});

test("Scribble turns each word with its stroke and fits the full ink by spoken onset", () => {
  const { cues } = demoCues({ lines: ["this is a challenging technological:h@620"] });
  const input = sceneInput(cues, { fps: 60 });
  const { pieces } = CAPTION_SCENE_PROGRAMS.scribble.program.build(input);
  for (const [i, word] of cues[0]!.words.entries()) {
    const stroke = pieces.find((piece) => piece.id === `scribble:0:leg${i}`)!;
    const face = pieces.find((piece) => piece.id === `scribble:0:w${i}`)!;
    const time = exportFrameAtOrAfter(word.startMs, input.fps);
    const pill = evaluatePiece(stroke, time);
    const text = evaluatePiece(face, time);
    expect(pill.rz).not.toBe(0);
    expect(text.rz).toBe(pill.rz);
    expect([text.x, text.y]).toEqual([pill.x, pill.y]);
    expect(pieceBounds(face, time, input.measure)).toEqual(pieceBounds({ ...face, clip: undefined }, time, input.measure));

    const box = pieceLocalBox(stroke, input.measure);
    const radius = (box.y2 - box.y1) / 2;
    const halfLength = (box.x2 - box.x1) / 2 - radius;
    const ink = pieceLocalBox(face, input.measure);
    const inkX = Math.max(Math.abs(ink.x1 - face.origin!.dx), Math.abs(ink.x2 - face.origin!.dx));
    const inkY = Math.max(Math.abs(ink.y1 - face.origin!.dy), Math.abs(ink.y2 - face.origin!.dy));
    expect(Math.hypot(Math.max(0, inkX - halfLength), inkY)).toBeLessThan(radius);
  }
});

test("Scribble’s next row cannot paint over the emphasized word", () => {
  const { cues } = demoCues({ lines: ["super fast:h@720 timeline@500"] });
  const input = sceneInput(cues, { fps: 60 });
  const { pieces } = CAPTION_SCENE_PROGRAMS.scribble.program.build(input);
  const hero = pieces.find((piece) => piece.id === "scribble:0:w1")!;
  const nextStroke = pieces.find((piece) => piece.id === "scribble:0:leg2")!;
  const frames = exportFrameTimes(nextStroke.fromMs, cues[0]!.words[2]!.endMs, input.fps);
  expect(frames.length).toBeGreaterThan(1);
  for (const time of frames) {
    const word = pieceBounds(hero, time, input.measure)!;
    const stroke = pieceBounds(nextStroke, time, input.measure);
    if (stroke) expect(stroke.y1).toBeGreaterThan(word.y2);
  }
});

test("Barrel keeps an upcoming outline out of the highlighted word’s echo", () => {
  const { cues } = demoCues({ lines: ["the promise:h of better"], options: { gap: 0 } });
  const input = sceneInput(cues, { fps: 30 });
  const { pieces } = CAPTION_SCENE_PROGRAMS.barrel.program.build(input);
  const echo = pieces.find((piece) => piece.id === "barrel:0:echo1-2")!;
  const next = pieces.find((piece) => piece.id === "barrel:0:w2next");
  const time = 767;
  expect(pieceBounds(echo, time, input.measure)).not.toBeNull();
  expect(next ? pieceBounds(next, time, input.measure) : null).toBeNull();
});

test("Barrel rolls words in perspective and keeps the final progress dot lit during the reading hold", () => {
  const { cues } = demoCues({ lines: ["has to be"] });
  const input = sceneInput(cues);
  const { pieces } = CAPTION_SCENE_PROGRAMS.barrel.program.build(input);
  const [, middle, last] = cues[0]!.words;
  const turningWord = pieces.find((piece) => piece.id === "barrel:0:w1")!;
  const turn = evaluatePiece(turningWord, middle!.startMs - 50);
  const demoAngle = 52 * 0.8 ** 3 * Math.PI / 180;
  expect(turn.rx).toBeLessThan(-5);
  expect(turn.sy * Math.cos(turn.rx * Math.PI / 180) / turn.sx).toBeCloseTo(Math.cos(demoAngle), 2);

  const indicator = pieces.find((piece) => piece.id === "barrel:0:dot2")!;
  const before = evaluatePiece(indicator, last!.startMs - 50);
  const settled = evaluatePiece(indicator, last!.endMs + 100);
  expect(before.sx).toBeLessThan(settled.sx);
  expect(settled.colour).toBe(input.colours.highlight.toUpperCase());
  expect(settled.visible).toBe(true);
});

test("Barrel keeps its rolled outlines legible at half-width preview size", () => {
  const { cues } = demoCues({ lines: ["disagree:h@650 with@500"], options: { gap: 0 } });
  const { pieces } = CAPTION_SCENE_PROGRAMS.barrel.program.build(sceneInput(cues));
  const rim = pieces.find((piece) => piece.id === "barrel:0:w0rim")!;
  const echo = pieces.find((piece) => piece.id === "barrel:0:echo0-2")!;
  const checkWeight = (piece: typeof rim, time: number) => {
    const pose = evaluatePiece(piece, time);
    const projectedWidth = piece.stroke!.widthPx * pose.sy * Math.cos(pose.rx * Math.PI / 180) * 0.5;
    expect(pose.visible && pose.o > 0).toBe(true);
    expect(projectedWidth).toBeGreaterThan(0.8);
  };
  checkWeight(echo, 800);
  expect(evaluatePiece(rim, 800).o).toBe(0);
  checkWeight(rim, 1120);
});

test("Pills staggers its entrance and sweeps the fill in and out on the demo’s beats", () => {
  const { cues } = demoCues({ lines: ["nobody is coming"] });
  const input = sceneInput(cues);
  const { pieces } = CAPTION_SCENE_PROGRAMS.pills.program.build(input);
  const outline = pieces.find((piece) => piece.id === "pills:0:outline0")!;
  const nextOutline = pieces.find((piece) => piece.id === "pills:0:outline1")!;
  const opening = cues[0]!.startMs - 70;
  const first = evaluatePiece(outline, opening);
  expect(first.sx).toBeLessThan(1);
  expect(first.visible && first.o > 0).toBe(true);
  expect(evaluatePiece(nextOutline, opening).visible).toBe(false);

  const fill = pieces.find((piece) => piece.id === "pills:0:fill1")!;
  const ink = pieces.find((piece) => piece.id === "pills:0:w1flood")!;
  const nextFill = pieces.find((piece) => piece.id === "pills:0:fill2")!;
  const size = pieceLocalBox(fill, input.measure);
  const width = size.x2 - size.x1;
  const enteringAt = cues[0]!.words[1]!.startMs - 25;
  const entering = evaluatePiece(fill, enteringAt);
  expect(entering.clip!.radius).toBe((size.y2 - size.y1) / 2);
  expect(entering.clip!.y2 - entering.clip!.y1).toBe(size.y2 - size.y1);
  expect((entering.clip!.x2 + width / 2) / width).toBeCloseTo(1 - 0.8 ** 3, 2);
  expect(evaluatePiece(ink, enteringAt).clip).toEqual(entering.clip);
  const handoff = cues[0]!.words[2]!.startMs - 55;
  expect(nextFill.fromMs).toBe(handoff);
  expect(evaluatePiece(fill, handoff + 80).clip!.x1).toBeCloseTo(0, 0);
});

test("Pills stamps the hero pill and pops its star before its arrow", () => {
  const { cues } = demoCues({ lines: ["so build:h@560"] });
  const { pieces } = CAPTION_SCENE_PROGRAMS.pills.program.build(sceneInput(cues));
  const hero = cues[0]!.words[1]!;
  const outline = pieces.find((piece) => piece.id === "pills:0:outline1")!;
  const star = pieces.find((piece) => piece.id === "pills:0:star1-0")!;
  const arrow = pieces.find((piece) => piece.id === "pills:0:arrow1")!;
  const time = hero.startMs + 10;
  expect(evaluatePiece(outline, time).sx).toBeGreaterThan(1);
  expect(evaluatePiece(star, time).sx).toBeLessThan(1);
  expect(evaluatePiece(arrow, time).visible).toBe(false);
  expect(evaluatePiece(arrow, hero.startMs + 200).visible).toBe(true);
});

test("Pixel clears neighbouring ink and retires the cursor when the tape takes over", () => {
  const { cues } = demoCues({ lines: ["this out as safely as possible:h@620"] });
  const input = sceneInput(cues, { fps: 30 });
  const { pieces } = CAPTION_SCENE_PROGRAMS.pixel.program.build(input);
  const hero = cues[0]!.words.at(-1)!;
  const heroFace = pieces.find((piece) => piece.id === "pixel:0:w5")!;
  const tape = pieces.filter((piece) => piece.id.startsWith("pixel:0:label")).at(-1)!;
  const cursor = pieces.find((piece) => piece.id === "pixel:0:cursor4")!;
  const firstFrame = exportFrameAtOrAfter(hero.startMs, input.fps);
  expect(evaluatePiece(cursor, firstFrame).visible).toBe(false);
  const frames = exportFrameTimes(tape.fromMs, hero.endMs, input.fps);
  for (const time of frames) {
    const bounds = pieceBounds(tape, time, input.measure)!;
    const text = pieceBounds(heroFace, time, input.measure)!;
    expect(bounds.x1).toBeLessThan(text.x1);
    expect(bounds.x2).toBeGreaterThan(text.x2);
    expect(bounds.y1).toBeLessThan(text.y1);
    expect(bounds.y2).toBeGreaterThan(text.y2);
    for (const body of pieces.filter((piece) => piece.kind === "text" && !piece.id.startsWith(heroFace.id))) {
      const ink = pieceBounds(body, time, input.measure);
      if (ink && ink.x1 < bounds.x2 && ink.x2 > bounds.x1) expect(ink.y2).toBeLessThan(bounds.y1);
    }
  }
});
