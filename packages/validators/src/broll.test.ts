import { describe, expect, test } from "bun:test";
import {
  brollQueryForClip,
  dominantPexelsOrientation,
  pexelsOrientationForAspectRatio,
  planBrollCutaways,
  planBrollWindow,
} from "./broll";

describe("brollQueryForClip", () => {
  test("strips stopwords and keeps the top meaningful words", () => {
    expect(brollQueryForClip("How to scale a SaaS startup", null)).toBe(
      "scale saas startup",
    );
  });

  test("falls back to hook text when there is no title", () => {
    expect(brollQueryForClip(null, "The future of remote teams")).toBe(
      "future remote teams",
    );
  });

  test("returns null when nothing meaningful remains and no category given", () => {
    expect(brollQueryForClip("the a to of", "")).toBeNull();
    expect(brollQueryForClip("", null)).toBeNull();
  });

  test("strips hook-framing words that previously matched unsafe stock footage", () => {
    // Regression: "5 Mistakes That Are Killing Your Ads" naively reduced to
    // "mistakes killing ads" (matches literal violence footage on Pexels).
    expect(
      brollQueryForClip("5 Mistakes That Are Killing Your Ads", null),
    ).toBe("ads");
    // "crushing" is stripped; the remaining concrete noun still survives.
    expect(brollQueryForClip("Crushing your competition", null)).toBe(
      "competition",
    );
  });

  test("strips purely numeric tokens", () => {
    expect(brollQueryForClip("Top 100 growth tactics", null)).toBe(
      "top growth tactics",
    );
  });

  test("keeps up to 4 words instead of 3", () => {
    expect(
      brollQueryForClip("Building modern distributed cloud systems fast", null),
    ).toBe("building modern distributed cloud");
  });

  test("falls back to a category-based query when nothing usable remains", () => {
    expect(
      brollQueryForClip("The Secret That Is Killing You", null, "insight"),
    ).toBe("person thinking notebook");
    // No category supplied -> still null (unchanged contract).
    expect(brollQueryForClip("The Secret That Is Killing You", null)).toBeNull();
  });
});

describe("pexelsOrientationForAspectRatio / dominantPexelsOrientation", () => {
  test("maps every aspect ratio, including the 1:1 -> square fix", () => {
    expect(pexelsOrientationForAspectRatio("9:16")).toBe("portrait");
    expect(pexelsOrientationForAspectRatio("4:5")).toBe("portrait");
    expect(pexelsOrientationForAspectRatio("16:9")).toBe("landscape");
    expect(pexelsOrientationForAspectRatio("1:1")).toBe("square");
  });

  test("dominant: a 1:1-only render resolves to square, not landscape", () => {
    expect(dominantPexelsOrientation(["1:1"])).toBe("square");
    expect(dominantPexelsOrientation(["1:1", "1:1"])).toBe("square");
  });

  test("dominant: majority vote across mixed outputs", () => {
    expect(dominantPexelsOrientation(["9:16", "9:16", "16:9"])).toBe("portrait");
    expect(dominantPexelsOrientation(["16:9", "16:9", "9:16"])).toBe("landscape");
  });

  test("dominant: ties break toward portrait", () => {
    expect(dominantPexelsOrientation(["9:16", "16:9"])).toBe("portrait");
    expect(dominantPexelsOrientation([])).toBe("portrait");
  });
});

describe("planBrollWindow (single-cutaway manual pick)", () => {
  test("returns null for clips that are too short", () => {
    expect(planBrollWindow(8, 10)).toBeNull();
  });

  test("places a bounded cutaway after the hook", () => {
    const w = planBrollWindow(40, 10);
    expect(w).not.toBeNull();
    expect(w!.startSec).toBeGreaterThanOrEqual(4);
    expect(w!.endSec).toBeGreaterThan(w!.startSec);
    expect(w!.endSec - w!.startSec).toBeLessThanOrEqual(3.5 + 0.01);
  });

  test("never exceeds the available b-roll duration", () => {
    const w = planBrollWindow(40, 2);
    expect(w).not.toBeNull();
    expect(w!.endSec - w!.startSec).toBeLessThanOrEqual(2);
  });
});

describe("planBrollCutaways (multi-cutaway auto path)", () => {
  function assertSanePlan(
    plan: ReturnType<typeof planBrollCutaways>,
    clipDurationSec: number,
    options?: Parameters<typeof planBrollCutaways>[3],
  ) {
    const hookSec = options?.hookSec ?? 2;
    const tailSec = options?.tailSec ?? 2;
    const minCutawaySec = options?.minCutawaySec ?? 2;
    const maxCutawaySec = options?.maxCutawaySec ?? 4;
    const minGapSec = options?.minGapSec ?? 1.5;

    for (const cutaway of plan) {
      // Never during the hook.
      expect(cutaway.startSec).toBeGreaterThanOrEqual(hookSec);
      // Never past the clip end.
      expect(cutaway.endSec).toBeLessThanOrEqual(clipDurationSec - tailSec + 1e-9);
      // Roughly 2-4s.
      const len = cutaway.endSec - cutaway.startSec;
      expect(len).toBeGreaterThanOrEqual(minCutawaySec - 1e-9);
      expect(len).toBeLessThanOrEqual(maxCutawaySec + 1e-9);
    }
    // Never overlapping, minimum gap enforced.
    for (let i = 1; i < plan.length; i++) {
      const gap = plan[i]!.startSec - plan[i - 1]!.endSec;
      expect(gap).toBeGreaterThanOrEqual(minGapSec - 1e-9);
    }
  }

  test("returns nothing for clips shorter than the minimum", () => {
    expect(planBrollCutaways(10, null, "query")).toEqual([]);
    expect(planBrollCutaways(11.9, null, "query")).toEqual([]);
  });

  test("returns nothing with neither cues nor a fallback query", () => {
    expect(planBrollCutaways(40, null, null)).toEqual([]);
    expect(planBrollCutaways(40, [], null)).toEqual([]);
  });

  test("never plans exactly one cutaway from the keyword fallback for a normal clip", () => {
    // A lone cutaway reads as accidental — the whole point of this feature.
    const plan = planBrollCutaways(30, null, "city skyline");
    expect(plan.length).toBeGreaterThanOrEqual(2);
    assertSanePlan(plan, 30);
  });

  test("scales cutaway count with clip duration", () => {
    expect(planBrollCutaways(15, null, "q").length).toBe(2);
    expect(planBrollCutaways(30, null, "q").length).toBe(3);
    expect(planBrollCutaways(60, null, "q").length).toBe(4);
    const long = planBrollCutaways(600, null, "q");
    assertSanePlan(long, 600);
    expect(long.length).toBeLessThanOrEqual(4);
  });

  test("uses cue timestamps and queries when cues are present", () => {
    const plan = planBrollCutaways(
      40,
      [
        { atSec: 5, query: "server room", reason: "mentions infra" },
        { atSec: 20, query: "team meeting" },
        { atSec: 35, query: "handshake deal" },
      ],
      "fallback query",
    );
    expect(plan.map((p) => p.query)).toEqual([
      "server room",
      "team meeting",
      "handshake deal",
    ]);
    assertSanePlan(plan, 40);
  });

  test("drops cues that land too close together instead of producing near-duplicates", () => {
    const plan = planBrollCutaways(
      40,
      [
        { atSec: 5, query: "a" },
        { atSec: 6, query: "b" }, // within minCutawaySec+minGapSec of the previous cue
        { atSec: 20, query: "c" },
      ],
      null,
    );
    expect(plan.map((p) => p.query)).toEqual(["a", "c"]);
    assertSanePlan(plan, 40);
  });

  test("ignores cues that fall inside the hook or the tail", () => {
    const plan = planBrollCutaways(
      40,
      [
        { atSec: 0.5, query: "too early" },
        { atSec: 39.5, query: "too late" },
        { atSec: 20, query: "on time" },
      ],
      null,
    );
    expect(plan.map((p) => p.query)).toEqual(["on time"]);
  });

  test("caps at maxCutaways even with many cues", () => {
    const cues = Array.from({ length: 10 }, (_, i) => ({
      atSec: 4 + i * 8,
      query: `q${i}`,
    }));
    const plan = planBrollCutaways(90, cues, null, { maxCutaways: 4 });
    expect(plan.length).toBeLessThanOrEqual(4);
    assertSanePlan(plan, 90, { maxCutaways: 4 });
  });

  test("respects custom hook/tail/gap/length options", () => {
    const plan = planBrollCutaways(50, null, "q", {
      hookSec: 5,
      tailSec: 5,
      minGapSec: 3,
      minCutawaySec: 2.5,
      maxCutawaySec: 3,
    });
    assertSanePlan(plan, 50, {
      hookSec: 5,
      tailSec: 5,
      minGapSec: 3,
      minCutawaySec: 2.5,
      maxCutawaySec: 3,
    });
  });
});
