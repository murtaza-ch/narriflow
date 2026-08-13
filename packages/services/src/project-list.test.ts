import { describe, expect, test } from "bun:test";
import { projectService } from "./project.service";

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
