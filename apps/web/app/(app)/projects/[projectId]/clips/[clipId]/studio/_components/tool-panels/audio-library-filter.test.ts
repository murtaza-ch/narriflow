import { describe, expect, test } from "bun:test";
import { brandAudioFirst, filterAudioAssets, orderMoodTags, pinActiveAudio } from "./audio-library-filter";

const ASSETS = [
  { id: "1", title: "Cinematic ambient", moodTags: ["ambient", "cinematic"], favorited: false },
  { id: "2", title: "Summer Sunset", moodTags: ["chill"], favorited: true },
  { id: "3", title: "Heavy Rain", moodTags: ["ambient"], favorited: true },
];

describe("filterAudioAssets", () => {
  test("filters by category and search without case sensitivity", () => {
    expect(
      filterAudioAssets(ASSETS, { category: "ambient", search: "RAIN", activeId: null }).map(
        (asset) => asset.id,
      ),
    ).toEqual(["3"]);
  });

  test("Saved returns only favorited assets", () => {
    expect(
      filterAudioAssets(ASSETS, { category: "saved", search: "", activeId: null }).map(
        (asset) => asset.id,
      ),
    ).toEqual(["2", "3"]);
  });

  test("pins an active preview even when it falls outside the filter", () => {
    expect(
      filterAudioAssets(ASSETS, { category: "chill", search: "", activeId: "1" }).map(
        (asset) => asset.id,
      ),
    ).toEqual(["2", "1"]);
  });
});

describe("brandAudioFirst", () => {
  const brand = [
    { id: "b1", title: "Theme", moodTags: [], favorited: false },
    { id: "b2", title: "Outro", moodTags: [], favorited: false },
  ];
  const library = [...ASSETS, { id: "b1", title: "Theme", moodTags: ["ambient"], favorited: false }];

  test("leads the All view and is not repeated in the library list", () => {
    const groups = brandAudioFirst(brand, library, { category: "all", search: "" });
    expect(groups.brand.map((asset) => asset.id)).toEqual(["b1", "b2"]);
    expect(groups.library.map((asset) => asset.id)).toEqual(["1", "2", "3"]);
  });

  test("follows the search, leaving non-matching tracks to the library only", () => {
    const groups = brandAudioFirst(brand, library, { category: "all", search: "theme" });
    expect(groups.brand.map((asset) => asset.id)).toEqual(["b1"]);
    expect(groups.library.map((asset) => asset.id)).toEqual(["1", "2", "3"]);
  });

  test("stays out of category and Saved views", () => {
    for (const category of ["saved", "ambient"]) {
      const groups = brandAudioFirst(brand, library, { category, search: "" });
      expect(groups.brand).toEqual([]);
      expect(groups.library).toBe(library);
    }
  });
});

describe("orderMoodTags", () => {
  test("music follows the curated order with unknown tags last, alphabetically", () => {
    expect(
      orderMoodTags("music", ["Ambient", "Zesty", "Epic", "Popular", "Bossa", "Chill", "Upbeat"]),
    ).toEqual(["Popular", "Upbeat", "Chill", "Epic", "Ambient", "Bossa", "Zesty"]);
  });

  test("sound effects follow their own order", () => {
    expect(orderMoodTags("sfx", ["Foley", "Impact", "Whoosh", "Sci-fi", "Mystery"])).toEqual([
      "Whoosh", "Impact", "Sci-fi", "Foley", "Mystery",
    ]);
    // A music tag is unknown to sfx.
    expect(orderMoodTags("sfx", ["Popular", "Pop"])).toEqual(["Pop", "Popular"]);
  });

  test("matches regardless of case, keeps the API's spelling and drops duplicates", () => {
    expect(orderMoodTags("music", ["epic", "popular", "Epic"])).toEqual(["popular", "epic"]);
  });

  test("the full music list comes back exactly in order", () => {
    const order = ["Popular", "Upbeat", "Happy", "Chill", "Funny", "Cinematic", "Epic", "Suspense", "Dark", "Romantic", "Jazz", "Electronic", "World", "Ambient"];
    expect(orderMoodTags("music", [...order].reverse())).toEqual(order);
  });
});

describe("pinActiveAudio", () => {
  test("appends the active row only when the list lacks it", () => {
    const rows = [{ id: "1" }, { id: "2" }];
    expect(pinActiveAudio(rows, { id: "9" })).toEqual([{ id: "1" }, { id: "2" }, { id: "9" }]);
    expect(pinActiveAudio(rows, { id: "2" })).toBe(rows);
    expect(pinActiveAudio(rows, null)).toBe(rows);
  });
});
