import { describe, expect, test } from "bun:test";

import {
  clearCampaignSelection,
  persistCampaignSelection,
  restoreCampaignReviewSelection,
  restoreCampaignSelection,
  type CampaignSelectionStorage,
} from "./campaign-selection";

function memoryStorage(): CampaignSelectionStorage & { value: string | null } {
  return {
    value: null,
    getItem() {
      return this.value;
    },
    setItem(_key, value) {
      this.value = value;
    },
    removeItem() {
      this.value = null;
    },
  };
}

describe("campaign clip selection", () => {
  test("restores the same project selection independent of row order", () => {
    const storage = memoryStorage();
    persistCampaignSelection(storage, "project-a", ["clip-b", "clip-a"]);

    expect(
      restoreCampaignSelection(storage, "project-a", ["clip-c", "clip-a", "clip-b"]),
    ).toEqual(new Set(["clip-a", "clip-b"]));
  });

  test("changing projects clears the prior project selection", () => {
    const storage = memoryStorage();
    persistCampaignSelection(storage, "project-a", ["clip-a"]);

    expect(restoreCampaignSelection(storage, "project-b", ["clip-a"])).toEqual(
      new Set(),
    );
    expect(storage.value).toBeNull();
  });

  test("drops clips that no longer belong to the current project result", () => {
    const storage = memoryStorage();
    persistCampaignSelection(storage, "project-a", ["clip-a", "clip-removed"]);

    expect(restoreCampaignSelection(storage, "project-a", ["clip-a"])).toEqual(
      new Set(["clip-a"]),
    );
    expect(JSON.parse(storage.value ?? "null")).toEqual({
      version: 1,
      projectId: "project-a",
      clipIds: ["clip-a"],
    });
  });

  test("invalid persisted data fails closed and explicit clear removes it", () => {
    const storage = memoryStorage();
    storage.value = "not-json";

    expect(restoreCampaignSelection(storage, "project-a", ["clip-a"])).toEqual(
      new Set(),
    );
    expect(storage.value).toBeNull();

    persistCampaignSelection(storage, "project-a", ["clip-a"]);
    clearCampaignSelection(storage);
    expect(storage.value).toBeNull();
  });

  test("maps the current clip selection to each latest review-ready export and all formats", () => {
    const storage = memoryStorage();
    persistCampaignSelection(storage, "project-a", [
      "clip-selected-b",
      "clip-selected-a",
      "clip-without-export",
    ]);

    expect(
      restoreCampaignReviewSelection(
        storage,
        "project-a",
        [
          "clip-selected-a",
          "clip-selected-b",
          "clip-unselected",
          "clip-without-export",
        ],
        [
          {
            id: "export-a",
            clipId: "clip-selected-a",
            variants: [
              { id: "variant-a-vertical" },
              { id: "variant-a-square" },
            ],
          },
          {
            id: "export-unselected",
            clipId: "clip-unselected",
            variants: [{ id: "variant-unselected" }],
          },
          {
            id: "export-b",
            clipId: "clip-selected-b",
            variants: [{ id: "variant-b-wide" }],
          },
        ],
      ),
    ).toEqual({
      exportIds: new Set(["export-a", "export-b"]),
      variantIdsByExport: new Map([
        ["export-a", new Set(["variant-a-vertical", "variant-a-square"])],
        ["export-b", new Set(["variant-b-wide"])],
      ]),
    });
    expect(JSON.parse(storage.value ?? "null")).toEqual({
      version: 1,
      projectId: "project-a",
      clipIds: [
        "clip-selected-a",
        "clip-selected-b",
        "clip-without-export",
      ],
    });
  });
});
