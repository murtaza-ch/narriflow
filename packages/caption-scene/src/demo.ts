import type { SceneCue } from "./input";

/**
 * The sample player's `script()` parser (`samples/harness.js`), ported with the same token grammar
 * and the same timing arithmetic, so a fixture or a thumbnail reproduces the sample's timings to
 * the millisecond. One string per cue; tokens are
 *   text[:h|:b|:m][@durationMs][+pauseBeforeMs]
 * (`:h` hero, `:b` body, `:m` minor; default body). `_` in text is a space. A cue may start with
 * `A> ` or `B> ` to set its speaker. Times are ms from the start of the loop.
 */

export interface DemoOptions {
  /** ms per character-ish unit of a spoken word (default 290). */
  readonly rate?: number;
  /** Gap between two words (default 30). */
  readonly gap?: number;
  /** Gap between two cues (default 140). */
  readonly cueGap?: number;
  /** How long the last cue stays after its last word (default 650). */
  readonly tail?: number;
  /** Time of the first word (default 350). */
  readonly lead?: number;
}

export interface DemoScript {
  readonly lines: readonly string[];
  readonly options?: DemoOptions;
  /** Background the sample was judged on. */
  readonly language?: string;
}

export interface DemoWord {
  readonly text: string;
  readonly role: "hero" | "body" | "minor";
  readonly start: number;
  readonly end: number;
  readonly index: number;
  readonly speaker: string;
}

export interface DemoCue {
  readonly index: number;
  readonly speaker: string;
  readonly words: readonly DemoWord[];
  readonly start: number;
  readonly end: number;
  readonly hero: DemoWord | null;
}

const ROLES = { h: "hero", b: "body", m: "minor" } as const;

export function parseDemoScript(lines: readonly string[], options: DemoOptions = {}): { cues: DemoCue[]; duration: number } {
  const rate = options.rate ?? 290;
  const gap = options.gap ?? 30;
  const cueGap = options.cueGap ?? 140;
  const tail = options.tail ?? 650;
  let t = options.lead ?? 350;
  const cues = lines.map((raw, index) => {
    let line = raw.trim();
    let speaker = "A";
    const sp = line.match(/^([A-Z])>\s*/);
    if (sp) {
      speaker = sp[1]!;
      line = line.slice(sp[0].length);
    }
    if (index > 0) t += cueGap;
    const words = line.split(/\s+/).map((token, i): DemoWord => {
      const m = token.match(/^(.+?)(?::([hbm]))?(?:@(\d+))?(?:\+(\d+))?$/)!;
      const text = m[1]!.replace(/_/g, " ");
      const role = ROLES[(m[2] ?? "b") as keyof typeof ROLES];
      const dur = m[3] ? Number(m[3]) : Math.round(rate * (0.7 + 0.075 * Math.min(8, text.length)));
      t += (i === 0 ? 0 : gap) + (m[4] ? Number(m[4]) : 0);
      const word: DemoWord = { text, role, start: t, end: t + dur, index: i, speaker };
      t += dur;
      return word;
    });
    return { index, speaker, words, start: words[0]!.start, end: 0, hero: words.find((word) => word.role === "hero") ?? null };
  });
  const finished = cues.map((cue, i) => {
    const next = cues[i + 1];
    const last = cue.words[cue.words.length - 1]!;
    return { ...cue, end: next ? next.words[0]!.start : last.end + tail };
  });
  // `cue.end` of the sample is the next cue's first start, or the last word's end plus the tail.
  return { cues: finished, duration: finished[finished.length - 1]!.end + 250 };
}

/** Speaker letters map to 0 for the first speaker (A), 1 for B, and so on. */
const speakerNumber = (letter: string) => letter.charCodeAt(0) - 65;

/** A demo script as the scene input's cues, in the sample's ms. */
export function demoCues(script: DemoScript): { cues: SceneCue[]; duration: number } {
  const parsed = parseDemoScript(script.lines, script.options);
  return {
    duration: parsed.duration,
    cues: parsed.cues.map((cue) => ({
      index: cue.index,
      startMs: cue.start,
      endMs: cue.end,
      speaker: speakerNumber(cue.speaker),
      language: script.language ?? "en",
      words: cue.words.map((word, at) => ({ text: word.text, startMs: word.start, endMs: word.end, role: word.role, key: `demo:${cue.index}:${at}` })),
    })),
  };
}

/** The edge demos of spec 5.3: shapes of cue every template must survive. */
export const SCENE_EDGE_DEMOS = ["one-word", "nine-words", "long-word", "no-hero", "urdu", "two-speakers"] as const;
export type SceneEdgeDemo = (typeof SCENE_EDGE_DEMOS)[number];

const EDGE_SCRIPTS: Readonly<Record<SceneEdgeDemo, DemoScript>> = {
  "one-word": { lines: ["wait:h@600", "no:b@400"] },
  "nine-words": { lines: ["so:m the:m real:b reason:b most:b people:h@520 never:b get:b there:m", "and:m that's:m fine:b"] },
  "long-word": { lines: ["it's:m extraordinarily:h@900 hard:b", "pneumonoultramicroscopicsilicovolcanoconiosis:b@1400"] },
  "no-hero": { lines: ["stop:b scrolling:b and:m listen:b", "this:b changes:b everything:b"] },
  urdu: { lines: ["یہ:m بہت:b اچھا:h@600 ہے:m", "میں نے آج سیکھا:b"], language: "ur" },
  "two-speakers": { lines: ["A> So:m I:m quit:h@470 my:m job:b", "B> Wait,@320 for:m real?", "A> Honestly?+500 Best:h@450 decision:b ever."] },
};

/** The cues and length of an edge demo. */
export function sceneEdgeDemo(kind: SceneEdgeDemo): { cues: SceneCue[]; duration: number } {
  return demoCues(EDGE_SCRIPTS[kind]);
}
