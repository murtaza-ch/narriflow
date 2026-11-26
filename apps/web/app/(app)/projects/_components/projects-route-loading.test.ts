import { describe, expect, test } from "bun:test";
import { projectsRouteFor } from "./projects-route-loading";

describe("projectsRouteFor", () => {
  test("names the page under /projects that a pathname opens", () => {
    expect(projectsRouteFor("/projects")).toBe("list");
    expect(projectsRouteFor("/projects/")).toBe("list");
    expect(projectsRouteFor("/projects/p1")).toBe("project");
    expect(projectsRouteFor("/projects/p1/clips/c1/studio")).toBe("studio");
    expect(projectsRouteFor("/projects/p1/clips/c1/exports/e1")).toBe("export");
    expect(projectsRouteFor("")).toBe("list");
  });
});
