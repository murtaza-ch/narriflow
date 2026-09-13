import { describe, expect, test } from "bun:test";
import { deriveProjectListProgress, projectService } from "./project.service";

describe("Project list progress", () => {
	test("keeps a project processing through detection after transcription completes", () => {
		expect(
			deriveProjectListProgress({
				ingestStatus: "ready",
				workflowRuns: [
					{
						stage: "stt",
						status: "completed",
						updatedAt: "2026-09-13T10:00:00.000Z",
					},
					{
						stage: "moment_detection",
						status: "running",
						updatedAt: "2026-09-13T10:01:00.000Z",
					},
				],
			}),
		).toEqual({ status: "processing", label: "Detecting", active: true });
	});

	test("keeps queued workflow work visible and makes terminal outcomes useful", () => {
		expect(
			deriveProjectListProgress({
				ingestStatus: "ready",
				workflowRuns: [
					{
						stage: "clip_rendering",
						status: "queued",
						updatedAt: "2026-09-13T10:01:00.000Z",
					},
				],
			}),
		).toEqual({ status: "queued", label: "Render queued", active: true });
		expect(
			deriveProjectListProgress({
				ingestStatus: "ready",
				workflowRuns: [
					{
						stage: "clip_rendering",
						status: "partial",
						updatedAt: "2026-09-13T10:01:00.000Z",
					},
				],
			}),
		).toEqual({ status: "ready", label: "Partially ready", active: false });
	});

	test("does not let a superseded workflow failure hide a newer completed stage", () => {
		expect(
			deriveProjectListProgress({
				ingestStatus: "ready",
				workflowRuns: [
					{
						stage: "moment_detection",
						status: "failed",
						updatedAt: "2026-09-13T10:00:00.000Z",
					},
					{
						stage: "moment_detection",
						status: "completed",
						updatedAt: "2026-09-13T10:01:00.000Z",
					},
				],
			}),
		).toEqual({ status: "ready", label: "Ready", active: false });
	});
});

describe("ProjectService.listProjectsWithStatsPage (in-memory)", () => {
  test("filters before paginating and keeps sort order across pages", async () => {
    const userId = `project-list-${crypto.randomUUID()}`;
    await projectService.createProject(userId, {
      title: "Zebra interview",
      sourceMediaUrl: "https://example.com/zebra.mp4",
    });
    await projectService.createProject(userId, {
      title: "Alpha launch",
      sourceMediaUrl: "https://example.com/alpha.mp4",
    });
    await projectService.createProject(userId, {
      title: "Alpha follow-up",
      sourceMediaUrl: "https://example.com/follow-up.mp4",
    });

    const first = await projectService.listProjectsWithStatsPage(userId, {
      query: "alpha",
      sort: "title",
      limit: 1,
    });
    expect(first.items.map((project) => project.title)).toEqual(["Alpha follow-up"]);
    expect(first.totalCount).toBe(2);
    expect(first.statusCounts.all).toBe(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await projectService.listProjectsWithStatsPage(userId, {
      query: "alpha",
      sort: "title",
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.items.map((project) => project.title)).toEqual(["Alpha launch"]);
    expect(second.nextCursor).toBeNull();
  });
});
