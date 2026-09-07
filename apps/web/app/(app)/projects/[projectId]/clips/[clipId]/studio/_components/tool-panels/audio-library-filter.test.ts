import { describe, expect, test } from "bun:test";
import { filterAudioAssets } from "./audio-library-filter";

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
