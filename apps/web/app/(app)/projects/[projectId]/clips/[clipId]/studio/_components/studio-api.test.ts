import { describe, expect, test } from "bun:test";
import { ApiError, createApiRuntime } from "@narriflow/api-client/core";
import {
  apiFailureBody,
  createClipFromStudioSelection,
  createStudioExport,
  fetchPreviewPeaks,
  fetchProjectUtterances,
  type StudioApi,
  studioBootstrapFailure,
  withLiveClipTitle,
  studioPollers,
  studioQueries,
  studioReads,
} from "./studio-api";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const CLIP = "22222222-2222-4222-8222-222222222222";
const target = { projectId: PROJECT, clipId: CLIP };

function setup(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; authorization: string | null; workspace: string | null; credentials?: string }> = [];
  const runtime = createApiRuntime({
    baseUrl: "https://api.test",
    getToken: async () => "token",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        authorization: headers.get("Authorization"),
        workspace: headers.get("X-Workspace-Id"),
        credentials: init?.credentials,
      });
      return handler(String(input), init ?? {});
    }) as typeof fetch,
  });
  runtime.setIdentity("user_1");
  runtime.selectWorkspace("ws_1");
  const api: StudioApi = { runtime, scope: { userId: "user_1", workspaceId: "ws_1" } };
  return { api, calls };
}

describe("studio queries", () => {
  test("the bootstrap seeds a session once and is never refetched in the background", () => {
    const { api } = setup(() => Response.json({}));
    const options = studioQueries(api).bootstrap(target);
    expect(options.queryKey).toEqual(["nf", "user_1", "ws_1", "studio", "bootstrap", target]);
    expect(options.staleTime).toBe(Number.POSITIVE_INFINITY);
    expect(options.refetchOnWindowFocus).toBe(false);
    expect(options.refetchOnReconnect).toBe(false);
    expect(options.refetchOnMount).toBe(false);
    expect(options.gcTime).toBe(0);
    // Nothing in the options polls or saves: the working document is not observed here.
    expect("refetchInterval" in options).toBe(false);
  });

  test("polls unwrap the API's wrappers and always ask the server", async () => {
    const outcomes: Record<string, unknown> = {
      "layout/auto": { analysis: { version: 1 } },
      "layout/split": { outcome: null },
      "layout/screen": { outcome: { state: "failed" } },
    };
    const { api, calls } = setup((url) => {
      const key = Object.keys(outcomes).find((name) => url.includes(name));
      if (key) return Response.json(outcomes[key]);
      return Response.json({ previewUrl: null, previewStartSec: 0, previewDurationSec: null, waveformPeaksUrl: null });
    });
    const pollers = studioPollers(api, target);
    expect(await pollers.fetchAutoLayoutAnalysis()).toEqual({ version: 1 });
    expect(await pollers.fetchSplitLayoutAnalysis()).toBeNull();
    expect(await pollers.fetchScreenLayoutAnalysis()).toEqual({ state: "failed" });
    await pollers.fetchPreviewStatus();
    await pollers.fetchPreviewStatus();
    expect(calls.filter((call) => call.url.endsWith("preview-source"))).toHaveLength(2);
    expect(calls.every((call) => call.authorization === "Bearer token" && call.workspace === "ws_1")).toBe(true);
    expect(calls.every((call) => call.credentials === "omit")).toBe(true);
  });
});

describe("reads", () => {
  test("peaks resolve the API-relative path against the API origin with the Bearer token", async () => {
    const { api, calls } = setup(() => Response.json({ version: 1 }));
    const path = `/api/projects/${PROJECT}/clips/${CLIP}/preview-peaks?v=abc`;
    expect(await fetchPreviewPeaks(api, path)).toEqual({ version: 1 });
    expect(calls[0]).toMatchObject({
      url: `https://api.test${path}`,
      authorization: "Bearer token",
      workspace: "ws_1",
    });
  });

  test("no peaks for a preview is null, not an error", async () => {
    const { api } = setup(() => new Response(null, { status: 204 }));
    expect(await fetchPreviewPeaks(api, `/api/projects/${PROJECT}/clips/${CLIP}/preview-peaks`)).toBeNull();
  });

  test("peaks will not send the token to another origin", async () => {
    const { api, calls } = setup(() => Response.json({}));
    await expect(fetchPreviewPeaks(api, "https://evil.test/peaks")).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  test("utterances come back as the raw list", async () => {
    const { api } = setup(() => Response.json({ utterances: [{ id: "u" }] }));
    expect(await fetchProjectUtterances(api, PROJECT)).toEqual([{ id: "u" }]);
  });

  test("cache scope names the identity and Workspace", () => {
    const { api } = setup(() => Response.json({}));
    expect(studioReads(api).cacheScope).toBe("user_1:ws_1");
  });
});

describe("apiFailureBody", () => {
  test("rebuilds the envelope fields components branch on", () => {
    const error = new ApiError({
      code: "visual_asset_in_use",
      message: "In use",
      status: 409,
      requestId: "r1",
      details: { usedIn: "Clip A" },
    });
    expect(apiFailureBody(error)).toMatchObject({
      error: "visual_asset_in_use",
      code: "visual_asset_in_use",
      message: "In use",
      requestId: "r1",
      details: { usedIn: "Clip A" },
    });
  });

  test("a failure without an envelope has no code", () => {
    expect(apiFailureBody(new TypeError("offline"))).toEqual({});
  });
});

describe("studio export intent", () => {
  const input = {
    projectId: PROJECT,
    clipId: CLIP,
    expectedRevision: 4,
    aspectRatios: ["9:16" as const],
    resolution: "1080p" as const,
  };

  test("a retry after a lost response replays the original Idempotency-Key until accepted", async () => {
    const keys: Array<string | null> = [];
    let attempt = 0;
    const { api } = setup((_url, init) => {
      keys.push(new Headers(init.headers).get("Idempotency-Key"));
      attempt += 1;
      if (attempt === 1) throw new TypeError("network lost");
      return Response.json({ export: { id: "export-1" } }, { status: 202 });
    });
    const intent = api.runtime.createIntent<typeof input>();
    await expect(createStudioExport(api, intent, input)).rejects.toBeInstanceOf(Error);
    expect(await createStudioExport(api, intent, { ...input })).toEqual({ export: { id: "export-1" } });
    expect(keys[1]).toBe(keys[0]);
    expect(keys[0]).toBeTruthy();
    // Accepted, so the next click is a new intent; a changed revision is too.
    await createStudioExport(api, intent, input);
    expect(keys[2]).not.toBe(keys[0]);
    attempt = 0;
    await expect(createStudioExport(api, intent, { ...input, expectedRevision: 5 })).rejects.toBeInstanceOf(Error);
    expect(keys[3]).not.toBe(keys[2]);
  });
});

describe("studio selection clip intent", () => {
  const input = { projectId: PROJECT, clipId: CLIP, startSec: 10, endSec: 20 };

  test("pressing Create clip again after a lost response reuses the key; a new selection does not", async () => {
    const keys: Array<string | null> = [];
    let attempt = 0;
    const { api } = setup((_url, init) => {
      keys.push(new Headers(init.headers).get("Idempotency-Key"));
      attempt += 1;
      if (attempt === 1) throw new TypeError("network lost");
      return Response.json({ id: "clip-new" }, { status: 201 });
    });
    const intent = api.runtime.createIntent<typeof input>();
    await expect(createClipFromStudioSelection(api, intent, input)).rejects.toBeInstanceOf(Error);
    expect(await createClipFromStudioSelection(api, intent, { ...input })).toEqual({ id: "clip-new" });
    expect(keys[1]).toBe(keys[0]);
    expect(keys[0]).toBeTruthy();
    await createClipFromStudioSelection(api, intent, { ...input, endSec: 25 });
    expect(keys[2]).not.toBe(keys[0]);
  });
});

describe("studio seed presentation", () => {
  test("a rename shows on the frozen seed without replacing anything else", () => {
    const seed = { id: "c1", clipTitle: "Old", startSec: 4 };
    const renamed = withLiveClipTitle(seed, { id: "c1", clipTitle: "New", startSec: 99 });
    expect(renamed).toEqual({ id: "c1", clipTitle: "New", startSec: 4 });
    expect(withLiveClipTitle(seed, { ...seed })).toBe(seed);
    expect(withLiveClipTitle(seed, undefined)).toBe(seed);
  });
});

describe("studio bootstrap failures", () => {
  const failure = (status: number, code: string, details?: Record<string, unknown>) =>
    new ApiError({ code, message: code, status, requestId: "req-1", details });

  test("a viewer without edit access goes home with the safe failure parameters, not to an error screen", () => {
    expect(studioBootstrapFailure(failure(403, "capability_denied"), PROJECT)).toEqual({
      kind: "redirect",
      to: "/home?requestFailure=capability_denied&requestId=req-1",
    });
  });

  test("paused and foreign Workspaces keep their recovery pages; missing and outages are not redirects", () => {
    expect(studioBootstrapFailure(failure(403, "workspace_restricted", {}), PROJECT)).toEqual({
      kind: "redirect",
      to: "/workspace-unavailable?requestFailure=workspace_restricted&requestId=req-1",
    });
    expect(studioBootstrapFailure(failure(409, "active_workspace_mismatch", { workspaceId: "w2" }), PROJECT).kind).toBe(
      "redirect",
    );
    expect(studioBootstrapFailure(failure(404, "clip_not_found"), PROJECT)).toEqual({ kind: "missing" });
    expect(studioBootstrapFailure(failure(500, "internal_error"), PROJECT)).toEqual({ kind: "error" });
  });
});
