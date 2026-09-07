import { describe, expect, test } from "bun:test";
import { createGeneratedImagesBrowserApi } from "./generated-images-browser";

describe("generated image browser lifecycle", () => {
  test("a reopened Studio adopts the durable gallery only through its Project route", async () => {
    const jobs = new Map<string, { id: string; status: string }>();
    const request: typeof fetch = async (input, init) => {
      const url = String(input);
      if (!url.startsWith("/api/projects/project-1/")) {
        return Response.json({ error: "project_not_found" }, { status: 404 });
      }
      if (init?.method === "POST" && !url.endsWith("/cancel")) {
        const job = { id: "job-1", status: "queued" };
        jobs.set(job.id, job);
        return Response.json(job, { status: 202 });
      }
      return Response.json({ jobs: [...jobs.values()] });
    };

    const firstSession = createGeneratedImagesBrowserApi("project-1", request);
    expect((await firstSession.create({ prompt: "frame" })).status).toBe(202);
    jobs.set("job-1", { id: "job-1", status: "completed" });

    const reopenedSession = createGeneratedImagesBrowserApi("project-1", request);
    expect(await (await reopenedSession.list("clip-1")).json()).toEqual({
      jobs: [{ id: "job-1", status: "completed" }],
    });
    expect((await createGeneratedImagesBrowserApi("project-2", request).list("clip-1")).status).toBe(404);
  });

  test("cancel and deletion remain available when new admission is rolled back", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const request: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      return Response.json({ ok: true });
    };
    const api = createGeneratedImagesBrowserApi("project-1", request);
    await api.cancel("job-1");
    await api.deleteResult("job-1");
    expect(calls).toEqual([
      { url: "/api/projects/project-1/generated-media/jobs/job-1/cancel", method: "POST" },
      { url: "/api/projects/project-1/generated-media/jobs/job-1/result", method: "DELETE" },
    ]);
  });
});
