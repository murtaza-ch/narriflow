import { describe, expect, test } from "bun:test";
import { createApiRuntime } from "@narriflow/api-client/core";
import { assetInUseCopy, createGeneratedImagesBrowserApi } from "./generated-images-browser";

const PROJECT_1 = "11111111-1111-4111-8111-111111111111";
const PROJECT_2 = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";

function brandApi(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const runtime = createApiRuntime({
    baseUrl: "https://api.test",
    getToken: async () => "token",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await handler(String(input), init ?? {});
      const headers = new Headers(response.headers);
      headers.set("X-Workspace-Id", "ws_1");
      return new Response(response.body, { status: response.status, headers });
    }) as typeof fetch,
  });
  runtime.setIdentity("user_1");
  runtime.selectWorkspace("ws_1");
  return {
    transport: runtime.transport,
    scope: { userId: "user_1", workspaceId: "ws_1" },
    intent: runtime.createIntent<Record<string, unknown>>(),
  };
}

describe("generated image browser lifecycle", () => {
  test("a reopened Studio adopts the durable gallery only through its Project route", async () => {
    const jobs = new Map<string, { id: string; status: string }>();
    const api = brandApi((url, init) => {
      if (!url.includes(`/projects/${PROJECT_1}/`)) {
        return Response.json({ error: "project_not_found", message: "No such project", requestId: "r1" }, { status: 404 });
      }
      if (init.method === "POST" && !url.endsWith("/cancel")) {
        const job = { id: "job-1", status: "queued" };
        jobs.set(job.id, job);
        return Response.json(job, { status: 202 });
      }
      return Response.json({ jobs: [...jobs.values()] });
    });

    const firstSession = createGeneratedImagesBrowserApi(PROJECT_1, api, api.intent);
    expect((await firstSession.create({ prompt: "frame" })).status).toBe(202);
    jobs.set("job-1", { id: "job-1", status: "completed" });

    const reopenedSession = createGeneratedImagesBrowserApi(PROJECT_1, api, api.intent);
    expect(await (await reopenedSession.list("clip-1")).json()).toEqual({
      jobs: [{ id: "job-1", status: "completed" }],
    });
    const refused = await createGeneratedImagesBrowserApi(PROJECT_2, api, api.intent).list("clip-1");
    expect(refused.status).toBe(404);
    expect(await refused.json()).toMatchObject({ error: "project_not_found" });
  });

  test("a retry after a lost response keeps the paid job's idempotency key until accepted", async () => {
    const keys: string[] = [];
    let attempt = 0;
    const api = brandApi(async (_url, init) => {
      keys.push((JSON.parse(String(init.body)) as { idempotencyKey: string }).idempotencyKey);
      attempt += 1;
      if (attempt === 1) throw new TypeError("network lost after the server accepted");
      return Response.json({ id: "job-1", status: "queued" }, { status: 202 });
    });
    const browser = createGeneratedImagesBrowserApi(PROJECT_1, api, api.intent);
    const body = { clipId: "clip-1", prompt: "frame", style: "editorial" };
    await expect(browser.create(body)).rejects.toBeInstanceOf(Error);
    expect((await browser.create({ ...body })).status).toBe(202);
    expect(keys[1]).toBe(keys[0]);
    // Accepted: the next Generate, even with the same inputs, is a new job.
    await browser.create(body);
    expect(keys[2]).not.toBe(keys[0]);
    // A changed prompt mid-retry is a different intent.
    attempt = 0;
    await expect(browser.create({ ...body, prompt: "other" })).rejects.toBeInstanceOf(Error);
    expect(keys[3]).not.toBe(keys[2]);
  });

  test("cancel and deletion remain available when new admission is rolled back", async () => {
    const calls: Array<{ url: string; method: string; authorized: boolean }> = [];
    const api = brandApi((url, init) => {
      calls.push({
        url,
        method: init.method ?? "GET",
        authorized: new Headers(init.headers).get("Authorization") === "Bearer token",
      });
      return Response.json({ ok: true });
    });
    const browser = createGeneratedImagesBrowserApi(PROJECT_1, api, api.intent);
    await browser.cancel(JOB);
    await browser.deleteResult(JOB);
    expect(calls).toEqual([
      { url: `https://api.test/api/projects/${PROJECT_1}/generated-media/jobs/${JOB}/cancel`, method: "POST", authorized: true },
      { url: `https://api.test/api/projects/${PROJECT_1}/generated-media/jobs/${JOB}/result`, method: "DELETE", authorized: true },
    ]);
  });

  test("a refused delete says where the frame is still used", () => {
    expect(
      assetInUseCopy({ error: "visual_asset_in_use", details: { usedIn: "clips Clip A, Clip B and 2 more" } }),
    ).toBe("Used in: clips Clip A, Clip B and 2 more. Remove it there first.");
    expect(assetInUseCopy({ error: "visual_asset_in_use" })).toBe(
      "This frame is still in use. Remove it there first.",
    );
    expect(assetInUseCopy({ error: "generated_media_job_not_found" })).toBeNull();
  });
});
