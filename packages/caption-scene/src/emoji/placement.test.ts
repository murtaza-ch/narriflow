import { describe, expect, test } from "bun:test";
import { loadCaptionEmojiArt } from "@narriflow/caption-emoji/art";
import { CAPTION_SCENE_NAMES, type CaptionSceneName } from "@narriflow/validators";
import { fastRun } from "../conformance-support";
import { sceneEdgeDemo } from "../demo";
import { captionSceneDemo } from "../registry";
import { fakeMeasure } from "../test-support";
import { PLACEMENT_EMOJI_IDS, placementRun } from "./placement-support";

/**
 * Every Scene Style draws emojis next to its text and never on it (spec D4), and close to the text
 * of its cue that reads on its first painted frame (`CAPTION_EMOJI_MAX_GAP`, or the fallback
 * `CAPTION_EMOJI_POP_FALLBACK_GAP`): one emoji on every cue of its
 * sample and of a fast 12-cue run (150 ms words, no gap between cues), on 9:16, 1:1 and 16:9, and on
 * 9:16 with the caption at 30% and 58% of the height. A word face is text of a cue at half opacity
 * or more. Set CAPTION_EMOJI_PLACEMENT_REPORT=1 to print the per-style table.
 *
 * Drop thresholds, from the measured runs (2026-11-27, fake measure, emoji 1.6 of the body text at
 * 12.5% to 16% of the short side, above, then beside, then below, never over half its height from
 * the text that reads on its first frame): the sample cues of the first 84 styles drop 11 of 1,221
 * emojis for want of room over the three canvases (5 when any frame of the pop counted, which left 70
 * over half a height from the text on their first frame; 4 now, all by the fallback); their fast run
 * 26 of 3,024 (20 and 228; 6 now). The 10 styles added since drop none. Lyrics, whose dim neighbour lines hold the rows above and below while its
 * stack scrolls, and Wonky, whose words fill a short frame, drop at most 2 of 12 on the fast run
 * (Lyrics' fallback at the safe area's edge sits about three emoji heights from a short line). Late
 * anchors (a cue's last 100 ms word with no gap) are not drawn by the timing rule and are counted
 * apart. A word face is also any text that belongs to no cue (Index's dial labels, Chronicle's
 * timeline).
 */
const CANVASES = [
  { width: 1080, height: 1920 },
  { width: 1080, height: 1080 },
  { width: 1920, height: 1080 },
] as const;

const art = await loadCaptionEmojiArt(PLACEMENT_EMOJI_IDS);
/** Phrase badges, drawn larger than a single emoji (`CAPTION_EMOJI_BADGE_SCALE`). */
const BADGE_IDS = ["morning-coffee", "coffee-chat", "caffeine-please", "airport-ride"] as const;
const badgeArt = await loadCaptionEmojiArt([...PLACEMENT_EMOJI_IDS, ...BADGE_IDS]);

interface Row {
  readonly name: CaptionSceneName;
  readonly canvas: string;
  readonly run: "demo" | "fast";
  readonly cues: number;
  readonly above: number;
  readonly below: number;
  readonly beside: number;
  readonly shrunk: number;
  readonly dropped: number;
  /** Not drawn because the anchor word leaves its cue under `CAPTION_EMOJI_MIN_HOLD_MS` (timing, not room). */
  readonly late: number;
}

const rows: Row[] = [];
/** Every other emoji a phrase badge: the style tests check for problems, this tallies drops. */
const BADGE_EMOJIS = PLACEMENT_EMOJI_IDS.flatMap((id, at) => [{ id }, { id: BADGE_IDS[at % BADGE_IDS.length]! }]);
const badges = { cues: 0, dropped: 0 };

describe("emoji placement on every Scene Style", () => {
  for (const name of CAPTION_SCENE_NAMES) {
    test(name, () => {
      for (const canvas of CANVASES) {
        for (const [run, cues] of [["demo", captionSceneDemo(name).cues], ["fast", fastRun(0)]] as const) {
          const result = placementRun({ name, cues, canvas, measure: fakeMeasure, art });
          expect(result.problems, `${name} ${run} ${canvas.width}x${canvas.height}`).toEqual([]);
          const placed = result.outcomes.filter((outcome) => outcome.placed);
          rows.push({
            name,
            canvas: `${canvas.width}x${canvas.height}`,
            run,
            cues: result.outcomes.length,
            above: placed.filter((outcome) => outcome.side === "above").length,
            below: placed.filter((outcome) => outcome.side === "below").length,
            beside: placed.filter((outcome) => outcome.side === "end" || outcome.side === "start").length,
            shrunk: placed.filter((outcome) => outcome.shrunk).length,
            dropped: result.outcomes.filter((outcome) => !outcome.placed && outcome.reason === "no-room").length,
            late: result.outcomes.filter((outcome) => !outcome.placed && outcome.reason === "no-time").length,
          });
          for (const outcome of result.outcomes) if (!outcome.placed) expect(["no-room", "no-time"]).toContain(outcome.reason);
          const withBadges = placementRun({ name, cues, canvas, measure: fakeMeasure, art: badgeArt, emojis: BADGE_EMOJIS });
          expect(withBadges.problems, `${name} ${run} ${canvas.width}x${canvas.height} badges`).toEqual([]);
          badges.cues += withBadges.outcomes.length;
          badges.dropped += withBadges.outcomes.filter((outcome) => !outcome.placed && outcome.reason === "no-room").length;
        }
      }
    });
  }

  test("drop rates stay under the measured thresholds", () => {
    const sum = (selected: readonly Row[], key: "cues" | "dropped" | "late") => selected.reduce((total, row) => total + row[key], 0);
    const demo = rows.filter((row) => row.run === "demo");
    const fast = rows.filter((row) => row.run === "fast");
    expect(demo.length).toBe(CAPTION_SCENE_NAMES.length * CANVASES.length);
    if (process.env.CAPTION_EMOJI_PLACEMENT_REPORT) {
      for (const canvas of CANVASES.map((each) => `${each.width}x${each.height}`)) {
        console.log(`\n${canvas}  style | demo cues above below beside shrunk dropped late | fast cues above below beside shrunk dropped late`);
        for (const name of CAPTION_SCENE_NAMES) {
          const cells = (["demo", "fast"] as const).map((run) => {
            const row = rows.find((each) => each.name === name && each.canvas === canvas && each.run === run)!;
            return `${row.cues} ${row.above} ${row.below} ${row.beside} ${row.shrunk} ${row.dropped} ${row.late}`;
          });
          console.log(`${name} | ${cells.join(" | ")}`);
        }
      }
      console.log(`demo dropped ${sum(demo, "dropped")}, late ${sum(demo, "late")} of ${sum(demo, "cues")}; fast dropped ${sum(fast, "dropped")}, late ${sum(fast, "late")} of ${sum(fast, "cues")}`);
    }
    // The sample cues: under 1% overall, and no style loses more than half its emojis on any canvas.
    expect(sum(demo, "dropped") / sum(demo, "cues")).toBeLessThan(0.01);
    for (const row of demo) expect(row.dropped, `${row.name} demo ${row.canvas}`).toBeLessThanOrEqual(Math.floor(row.cues / 2));
    // Fast speech: under 5% overall; no style loses more than half.
    expect(sum(fast, "dropped") / sum(fast, "cues")).toBeLessThan(0.05);
    for (const row of fast) expect(row.dropped, `${row.name} fast ${row.canvas}`).toBeLessThanOrEqual(row.cues / 2);
    // The two stacks that crowd their own slots: at most 2 of 12 on any canvas.
    for (const row of fast.filter((each) => each.name === "lyrics" || each.name === "wonky")) expect(row.dropped, `${row.name} fast ${row.canvas}`).toBeLessThanOrEqual(2);
  });

  test("phrase badges (every other emoji) place without covering text, demo and fast, on every canvas", () => {
    // Measured (fake measure, first 84 styles): 35 of 4,245 for want of room over demo and fast (24 when any frame of the
    // pop counted); the 10 styles added since drop none.
    expect(badges.cues).toBe(1389 + 3384);
    expect(badges.dropped / badges.cues).toBeLessThan(0.01);
  });

  test("with the caption at 30% and 58% of a 9:16 frame, every emoji sits close to its cue's text, off it, in the safe area", () => {
    // Measured (fake measure, 9:16): at 30% and at 58% alike, demo 6 of 407 and fast 11 of 1,008 dropped for want of room
    // (2 and 8 when any frame of the pop counted); first-frame gaps p50 0.17, p90 0.30 to 0.39, max 0.67 (one fallback).
    for (const positionY of [30, 58]) {
      let cues = 0;
      let dropped = 0;
      for (const name of CAPTION_SCENE_NAMES) {
        for (const [run, runCues] of [["demo", captionSceneDemo(name).cues], ["fast", fastRun(0)]] as const) {
          const result = placementRun({ name, cues: runCues, canvas: CANVASES[0], measure: fakeMeasure, art, positionY });
          expect(result.problems, `${name} ${run} at ${positionY}%`).toEqual([]);
          cues += result.outcomes.length;
          dropped += result.outcomes.filter((outcome) => !outcome.placed && outcome.reason === "no-room").length;
        }
      }
      expect(dropped / cues, `at ${positionY}%`).toBeLessThan(0.02);
    }
  }, 30_000); // Many presets × two heights: seconds under load; the default 5 s timeout flaked.

  test("the edge demos (one word, nine words, a long word, Urdu, two speakers) place without covering text", () => {
    for (const kind of ["one-word", "nine-words", "long-word", "urdu", "two-speakers"] as const) {
      for (const name of CAPTION_SCENE_NAMES) {
        const result = placementRun({ name, cues: sceneEdgeDemo(kind).cues, canvas: CANVASES[0], measure: fakeMeasure, art });
        expect(result.problems, `${name} ${kind}`).toEqual([]);
      }
    }
  }, 30_000); // Five edge demos on every Scene Style: about 5 s under load.
});
