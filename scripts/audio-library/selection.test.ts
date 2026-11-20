import { describe, expect, test } from "bun:test";
import {
  type FreepdConfig,
  type FreepdListing,
  type IncompetechPiece,
  type KenneyRule,
  fillTitle,
  freepdTitle,
  incompetechAttribution,
  incompetechFileUrl,
  incompetechMoods,
  isBigSoundBankFree,
  orderMoods,
  parseClockDuration,
  selectFreepd,
  selectIncompetech,
  selectKenney,
  storageKeyFor,
} from "./selection";

describe("storageKeyFor", () => {
  const sha = `${"ab12cd34ef56a7b8".repeat(4)}`;
  test("is content addressed by the first 16 hex characters", () => {
    expect(storageKeyFor("music", sha)).toBe("audio-library/music/ab12cd34ef56a7b8.mp3");
    expect(storageKeyFor("sfx", sha)).toBe("audio-library/sfx/ab12cd34ef56a7b8.mp3");
  });
  test("rejects anything that is not a lowercase sha256", () => {
    expect(() => storageKeyFor("music", "short")).toThrow();
    expect(() => storageKeyFor("music", sha.toUpperCase())).toThrow();
  });
});

describe("parseClockDuration", () => {
  test("reads hh:mm:ss", () => {
    expect(parseClockDuration("00:05:07")).toBe(307);
    expect(parseClockDuration("01:00:00")).toBe(3600);
  });
  test("returns null for junk", () => {
    expect(parseClockDuration("5:07")).toBeNull();
    expect(parseClockDuration(null)).toBeNull();
  });
});

describe("incompetech", () => {
  test("attribution follows the spec template with the real title", () => {
    expect(incompetechAttribution("Sneaky Snitch")).toBe(
      '"Sneaky Snitch" Kevin MacLeod (incompetech.com)\nLicensed under Creative Commons: By Attribution 4.0\nhttps://creativecommons.org/licenses/by/4.0/',
    );
  });

  test("file urls URL-encode the filename field", () => {
    expect(incompetechFileUrl("Pixel Peeker Polka - faster.mp3")).toBe(
      "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Pixel%20Peeker%20Polka%20-%20faster.mp3",
    );
  });

  test("maps feel and genre onto the chip vocabulary, Popular first", () => {
    expect(incompetechMoods("Bouncy, Dark, Humorous, Mysterious", "22")).toEqual(["Popular", "Upbeat", "Funny", "Suspense", "Dark"]);
    expect(incompetechMoods("Bright, Grooving, Relaxed", "11")).toEqual(["Popular", "Upbeat", "Happy", "Chill", "Jazz"]);
  });

  test("caps derived moods and only uses allowed chips", () => {
    const moods = incompetechMoods("Action, Dark, Driving, Epic, Intense, Mysterious", "22");
    expect(moods.filter((mood) => mood !== "Popular").length).toBeLessThanOrEqual(4);
    expect(moods[0]).toBe("Popular");
    expect(moods).toContain("Epic");
    expect(moods).toContain("Cinematic");
  });

  test("a soundtrack with no energetic feel is not Cinematic", () => {
    expect(incompetechMoods("Calming, Somber", "22")).not.toContain("Cinematic");
  });

  test("works with an empty feel", () => {
    expect(incompetechMoods(null, "7")).toEqual(["Popular", "Electronic"]);
    expect(incompetechMoods("", null)).toEqual(["Popular"]);
  });

  const piece = (title: string, filename: string): IncompetechPiece => ({
    title,
    filename,
    length: "00:03:00",
    genre: "22",
    feel: "Humorous",
  });
  test("selects exact titles, sortOrder is the 1-based list position, missing are reported", () => {
    const result = selectIncompetech(
      [piece("B", "b.mp3"), piece("A", "a.mp3"), piece("Cipher", "Cipher2.mp3")],
      ["Cipher", "Nope", "A"],
    );
    expect(result.picks.map((pick) => [pick.title, pick.filename, pick.sortOrder])).toEqual([
      ["Cipher", "Cipher2.mp3", 1],
      ["A", "a.mp3", 3],
    ]);
    expect(result.missing).toEqual(["Nope"]);
    expect(result.picks[0]?.durationSec).toBe(180);
  });

  test("refuses more than 99 classics", () => {
    expect(() => selectIncompetech([], Array.from({ length: 100 }, (_, i) => `T${i}`))).toThrow();
  });
});

describe("orderMoods", () => {
  test("uses chip order, drops duplicates, puts unknown last alphabetically", () => {
    expect(orderMoods(["Jazz", "Popular", "Jazz", "Zeta", "Alpha", "Chill"])).toEqual(["Popular", "Chill", "Jazz", "Alpha", "Zeta"]);
  });
});

describe("freepd", () => {
  const config: FreepdConfig = {
    baseUrl: "https://example.test/freepd/",
    minSec: 30,
    maxSec: 900,
    targetSec: 150,
    fallbackArtist: "FreePD",
    folders: {
      comedy: { moods: ["Funny"], take: 2 },
      chill: { moods: ["Chill"], take: 5 },
    },
  };
  const file = (href: string, dur: number, artist?: string) => ({
    href,
    ext: "mp3",
    sz: 1,
    tags: { ".dur": dur, ...(artist ? { artist } : {}) },
  });
  const listings: Record<string, FreepdListing> = {
    comedy: {
      files: [
        file("Far%20Away.mp3", 600, "Kevin MacLeod"),
        file("Just%20Right.mp3", 150, "Bryan Teoh"),
        file("Close.mp3", 160),
        file("Too%20Short.mp3", 10),
        file("Hour%20Long.mp3", 3600),
        { href: "README.md", ext: "md", sz: 1 },
      ],
    },
    chill: { files: [file("Just%20Right.mp3", 150), file("Calm_Water.mp3", 140, "Kevin MacLeod")] },
  };

  test("decodes names and replaces underscores", () => {
    expect(freepdTitle("Calm_Water.mp3")).toBe("Calm Water");
    expect(freepdTitle("Alls%20Fair%20In%20Love.mp3")).toBe("Alls Fair In Love");
  });

  test("ranks by closeness to the target, skips too short/too long and non-audio, caps per folder", () => {
    const picks = selectFreepd(listings, config, new Set());
    expect(picks.filter((pick) => pick.folder === "comedy").map((pick) => pick.title)).toEqual(["Just Right", "Close"]);
  });

  test("artist comes from the listing, else the fallback; moods come from the folder", () => {
    const picks = selectFreepd(listings, config, new Set());
    expect(picks.find((pick) => pick.title === "Close")?.artist).toBe("FreePD");
    expect(picks.find((pick) => pick.title === "Just Right")?.artist).toBe("Bryan Teoh");
    expect(picks.find((pick) => pick.title === "Calm Water")?.moods).toEqual(["Chill"]);
  });

  test("a title already taken, by another folder or by an excluded classic, is not picked twice", () => {
    const picks = selectFreepd(listings, config, new Set(["calm water"]));
    expect(picks.filter((pick) => pick.title === "Just Right")).toHaveLength(1);
    expect(picks.some((pick) => pick.title === "Calm Water")).toBe(false);
  });

  test("is deterministic", () => {
    expect(selectFreepd(listings, config, new Set())).toEqual(selectFreepd(listings, config, new Set()));
  });
});

describe("kenney", () => {
  const rules: KenneyRule[] = [
    { pack: "ui", pattern: "^click_(\\d+)$", category: "Click", title: "Click {n}", take: 2 },
    { pack: "ui", pattern: "^impactBell_heavy_(\\d+)$", category: "Impact", title: "Bell hit {n1}", take: 5 },
    { pack: "ui", pattern: "^(card-shuffle)$", category: "Foley", title: "Card shuffle", take: 1 },
  ];
  const files = {
    ui: [
      "Audio/click_010.ogg",
      "Audio/click_002.ogg",
      "Audio/click_001.ogg",
      "Audio/footstep_grass_000.ogg",
      "Audio/impactBell_heavy_000.ogg",
      "Audio/impactBell_heavy_001.ogg",
      "Audio/card-shuffle.ogg",
      "Preview.ogg",
      "License.txt",
    ],
  };

  test("takes the first N in natural order and numbers titles from the capture", () => {
    const picks = selectKenney(rules, files);
    expect(picks.filter((pick) => pick.category === "Click").map((pick) => pick.title)).toEqual(["Click 1", "Click 2"]);
    expect(picks.filter((pick) => pick.category === "Impact").map((pick) => pick.title)).toEqual(["Bell hit 1", "Bell hit 2"]);
  });

  test("never selects footsteps, previews or non-audio files", () => {
    const paths = selectKenney(rules, files).map((pick) => pick.path);
    expect(paths.some((path) => path.includes("footstep") || path.includes("Preview") || path.endsWith(".txt"))).toBe(false);
  });

  test("a capture-less title keeps its text", () => {
    expect(selectKenney(rules, files).find((pick) => pick.category === "Foley")?.title).toBe("Card shuffle");
  });

  test("fillTitle supports 0 and 1 based numbering", () => {
    expect(fillTitle("Hit {n}", "003")).toBe("Hit 3");
    expect(fillTitle("Hit {n1}", "003")).toBe("Hit 4");
  });
});

describe("bigsoundbank", () => {
  test("accepts only pages that mark the sound free", () => {
    expect(isBigSoundBankFree("<strong>CC0 (public domain): Free and royalty-free (<a>More</a>)</strong>")).toBe(true);
    expect(isBigSoundBankFree("<strong>Royalty-free license: purchase required</strong>")).toBe(false);
    expect(isBigSoundBankFree("")).toBe(false);
  });
});
