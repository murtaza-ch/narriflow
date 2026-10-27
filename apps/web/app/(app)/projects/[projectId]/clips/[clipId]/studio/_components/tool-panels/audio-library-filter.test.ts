import { describe, expect, test } from "bun:test";
import { brandAudioFirst, filterAudioAssets } from "./audio-library-filter";

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
