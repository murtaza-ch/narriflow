import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { CAPTION_SCENE_NAMES } from "@narriflow/validators";
import { demoCues, parseDemoScript, sceneEdgeDemo, SCENE_EDGE_DEMOS } from "./demo";
import { CAPTION_SCENE_PROGRAMS, captionSceneDemo, captionSceneStillMs } from "./registry";

const HARNESS = new URL("../../../.scratch/caption-templates-v2/samples/harness.js", import.meta.url).pathname;

describe("demo script parser", () => {
  test("Reveal's sample timings, to the ms (the sample player's own numbers)", () => {
    const { cues, duration } = parseDemoScript(CAPTION_SCENE_PROGRAMS.reveal.demo.lines);
    expect(duration).toBe(6706);
    expect(cues.map((cue) => [cue.start, cue.end])).toEqual([[350, 1486], [1486, 3106], [3106, 4242], [4242, 6456]]);
    expect(cues[1]!.words.map((word) => [word.text, word.role, word.start, word.end])).toEqual([
      ["it's", "minor", 1486, 1776],
      ["all", "minor", 1806, 2074],
      ["about", "minor", 2104, 2416],
      ["talent", "hero", 2446, 2966],
    ]);
  });

  test("the token grammar: roles, explicit duration, pause before, spaces, speakers", () => {
    const { cues } = parseDemoScript(["A> hi:m@100 there_you:h@200+500", "B> ok"], { lead: 0, gap: 10, cueGap: 20, rate: 100, tail: 300 });
    expect(cues[0]!.speaker).toBe("A");
    expect(cues[1]!.speaker).toBe("B");
    expect(cues[0]!.words[0]).toMatchObject({ text: "hi", role: "minor", start: 0, end: 100 });
    expect(cues[0]!.words[1]).toMatchObject({ text: "there you", role: "hero", start: 610, end: 810 });
    expect(cues[0]!.end).toBe(cues[1]!.start);
    expect(cues[1]!.start).toBe(830);
    expect(cues[1]!.end).toBe(cues[1]!.words[0]!.end + 300);
  });

  test("speaker letters become 0 for A and 1 for B", () => {
    expect(demoCues({ lines: ["A> a", "B> b", "c"] }).cues.map((cue) => cue.speaker)).toEqual([0, 1, 0]);
  });

  test("every template's demo and every edge demo parse into ordered, non-empty cues", () => {
    for (const name of CAPTION_SCENE_NAMES) {
      const { cues, duration } = captionSceneDemo(name);
      expect(cues.length).toBeGreaterThanOrEqual(4);
      expect(duration).toBeGreaterThan(cues.at(-1)!.endMs);
      for (const [at, cue] of cues.entries()) {
        expect(cue.words.length).toBeGreaterThan(0);
        expect(cue.endMs).toBeGreaterThan(cue.startMs);
        if (at > 0) expect(cue.startMs).toBeGreaterThanOrEqual(cues[at - 1]!.startMs);
        expect(cue.words.filter((word) => word.role === "hero").length).toBeLessThanOrEqual(1);
      }
      expect(captionSceneStillMs(name)).toBeGreaterThan(0);
    }
    for (const kind of SCENE_EDGE_DEMOS) expect(sceneEdgeDemo(kind).cues.length).toBeGreaterThan(0);
  });

  const harness = existsSync(HARNESS);
  test.skipIf(!harness)("equals the sample player's script() for every template, word by word", () => {
    const stub: { NF?: { script: (lines: string[], opt?: object) => { cues: { start: number; end: number; speaker: string; words: { text: string; role: string; start: number; end: number }[] }[]; duration: number } } } = {};
    new Function("window", readFileSync(HARNESS, "utf8"))(stub);
    for (const name of CAPTION_SCENE_NAMES) {
      const { lines, options } = CAPTION_SCENE_PROGRAMS[name].demo;
      const sample = stub.NF!.script([...lines], options ?? {});
      const ported = parseDemoScript(lines, options);
      expect(ported.duration).toBe(sample.duration);
      expect(ported.cues.map((cue) => [cue.start, cue.end, cue.speaker])).toEqual(sample.cues.map((cue) => [cue.start, cue.end, cue.speaker]));
      expect(ported.cues.flatMap((cue) => cue.words.map((word) => [word.text, word.role, word.start, word.end]))).toEqual(
        sample.cues.flatMap((cue) => cue.words.map((word) => [word.text, word.role, word.start, word.end])),
      );
    }
  });
});
