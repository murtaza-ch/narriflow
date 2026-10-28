import { describe, expect, test } from "bun:test";
import { finishingSignature } from "./finishing-auto-refresh";
import type { ProjectFinishingView } from "./finishing-status";

const CLIP = "00000000-0000-4000-8000-000000000002";

function view(overrides: Partial<ProjectFinishingView> = {}): ProjectFinishingView {
  return {
    id: "00000000-0000-4000-8000-000000000009",
    state: "running",
    reason: null,
    message: null,
    clips: [{ clipId: CLIP, title: "A", exportId: null, exportStatus: null, copyWritten: false, ranking: null }],
    rankedWithAudienceData: false,
    ...overrides,
  };
}

describe("finishingSignature", () => {
  test("is stable for an unchanged run, so polling alone never refreshes the page", () => {
    expect(finishingSignature(view())).toBe(finishingSignature(view()));
  });

  test("changes when the state, an export or the written copy changes", () => {
    const base = finishingSignature(view());
    expect(finishingSignature(view({ state: "exporting" }))).not.toBe(base);
    expect(
      finishingSignature(
        view({ clips: [{ clipId: CLIP, title: "A", exportId: "e1", exportStatus: "ready", copyWritten: false, ranking: null }] }),
      ),
    ).not.toBe(base);
    expect(
      finishingSignature(
        view({ clips: [{ clipId: CLIP, title: "A", exportId: null, exportStatus: null, copyWritten: true, ranking: null }] }),
      ),
    ).not.toBe(base);
  });

  test("ignores titles and ranking, which the page already has", () => {
    expect(
      finishingSignature(
        view({ clips: [{ clipId: CLIP, title: "Renamed", exportId: null, exportStatus: null, copyWritten: false, ranking: null }] }),
      ),
    ).toBe(finishingSignature(view()));
  });
});
