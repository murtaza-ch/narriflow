import { describe, expect, mock, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import { renderToStaticMarkup } from "react-dom/server";

// The poller is tested on its own; here it only has to be mounted while finishing is working.
mock.module("./finishing-auto-refresh", () => ({
  FinishingAutoRefresh: () => <span data-finishing-poll />,
}));
const { FinishingStatus } = await import("./finishing-status");
type ProjectFinishingView = import("./finishing-status").ProjectFinishingView;

const PROJECT = "00000000-0000-4000-8000-000000000001";
const CLIP = "00000000-0000-4000-8000-000000000002";
const EXPORT = "00000000-0000-4000-8000-000000000003";

function view(overrides: Partial<ProjectFinishingView>): ProjectFinishingView {
  return {
    id: "00000000-0000-4000-8000-000000000009",
    state: "ready",
    reason: null,
    message: null,
    clips: [{ clipId: CLIP, title: "The big reveal", exportId: EXPORT, exportStatus: "ready", copyWritten: true, ranking: null }],
    rankedWithAudienceData: false,
    ...overrides,
  };
}
const render = (finishing: ProjectFinishingView) =>
  renderToStaticMarkup(
    <ChakraProvider value={system}>
      <FinishingStatus projectId={PROJECT} finishing={finishing} />
    </ChakraProvider>,
  );

describe("Project finishing status", () => {
  test("working says so and waits for the generation or the exports", () => {
    const waiting = render(view({ state: "waiting", clips: [] }));
    expect(waiting).toContain("Finishing in progress");
    expect(waiting).toContain("when clip generation finishes");
    expect(render(view({ state: "running", clips: [] }))).toContain("Exporting the best clips and writing copy");
    expect(waiting).not.toContain("/exports/");
    // The page keeps looking while it is working, and only then.
    expect(waiting).toContain("data-finishing-poll");
    expect(render(view({}))).not.toContain("data-finishing-poll");
    // Parked while its renders run is still working.
    expect(render(view({ state: "exporting" }))).toContain("Finishing in progress");
  });

  test("ready links each export and counts the copy written", () => {
    const html = render(view({}));
    expect(html).toContain("Ready to review");
    expect(html).toContain(`/projects/${PROJECT}/clips/${CLIP}/exports/${EXPORT}`);
    expect(html).toContain("The big reveal");
    expect(html).toContain("Copy written for 1 clip.");
  });

  test("partial keeps the exports that finished and shows why it is incomplete", () => {
    const html = render(view({
      state: "partial",
      reason: "exports_failed",
      message: "Not every export finished.",
      clips: [
        { clipId: CLIP, title: "The big reveal", exportId: EXPORT, exportStatus: "ready", copyWritten: false, ranking: null },
        { clipId: "00000000-0000-4000-8000-000000000004", title: "Cut short", exportId: null, exportStatus: null, copyWritten: false, ranking: null },
      ],
    }));
    expect(html).toContain("Finishing partly done");
    expect(html).toContain("Not every export finished.");
    expect(html).toContain("The big reveal");
    expect(html).not.toContain("Cut short");
  });

  test("skipped shows its reason, with no exports", () => {
    const html = render(view({ state: "skipped", reason: "plan_required", message: "Finishing needs the Pro plan or above. Your imports and clips are unaffected.", clips: [] }));
    expect(html).toContain("Finishing skipped");
    expect(html).toContain("needs the Pro plan");
    expect(html).not.toContain("/exports/");
  });

  test("says when clips were ranked with audience data, and shows the factor each one used", () => {
    const ranked = render(view({
      rankedWithAudienceData: true,
      clips: [
        { clipId: CLIP, title: "The big reveal", exportId: EXPORT, exportStatus: "ready", copyWritten: false,
          ranking: { score: 70, factor: 1.25, groups: [{ dimension: "category", label: "Category Story", lift: 1.4 }], guidanceComputedAt: "2026-10-23T03:00:00.000Z" } },
        { clipId: "00000000-0000-4000-8000-000000000004", title: "Off the grid", exportId: null, exportStatus: null, copyWritten: false,
          ranking: { score: 60, factor: 1, groups: [], guidanceComputedAt: "2026-10-23T03:00:00.000Z" } },
      ],
    }));
    expect(ranked).toContain("Ranked with your audience data");
    expect(ranked).toContain("The big reveal: score 70 × 1.25 (Category Story 1.4x)");
    expect(ranked).toContain("Off the grid: score 60 × 1 (no matching audience group)");
    expect(ranked).toContain('href="/performance"');
    // Plain ranking says nothing about audience data.
    expect(render(view({}))).not.toContain("audience data");
  });
});
