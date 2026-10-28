import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/query-core";
import { scopedKey } from "../core";
import { errorResponse, fakeFetch, jsonResponse, USER, WORKSPACE_A } from "../core/test-helpers";
import { EXPORT_ATTACHMENT_MAX_BYTES, createExportsClient, exportCommands, exportQueries, fetchSubtitleFile, fetchTimelineArchive, invalidateAfterExportChange } from "./index";

const PROJECT = "40000000-0000-4000-8000-000000000001";
const CLIP = "40000000-0000-4000-8000-000000000002";
const EXPORT = "40000000-0000-4000-8000-000000000003";
const VARIANT = "40000000-0000-4000-8000-000000000004";
const BASE = "https://api.example.test/api";
const scope = { userId: USER, workspaceId: WORKSPACE_A };

function clientWith(...handlers: Parameters<typeof fakeFetch>) {
  const recorded = fakeFetch(...handlers);
  const client = createExportsClient({
    baseUrl: "https://api.example.test",
    fetch: (input, init) => recorded.fetch(input as string, init),
  });
  return { client, calls: recorded.calls };
}

describe("exports reads", () => {
  test("the Workspace list sends its filters as the query and keys by them", async () => {
    const { client, calls } = clientWith(() => jsonResponse({ items: [], nextCursor: null }));
    const filters = { status: "failed", q: "launch", ratio: "ratio_9_16", cursor: "abc" } as const;
    const options = exportQueries.workspaceList(client, scope, filters);
    const controller = new AbortController();
    await options.queryFn?.({ signal: controller.signal } as never);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/api/workspace/exports");
    expect(Object.fromEntries(url.searchParams)).toEqual({ status: "failed", q: "launch", ratio: "ratio_9_16", cursor: "abc" });
    expect(calls[0]?.init.signal).toBeDefined();
    expect(options.queryKey).toEqual(scopedKey(scope, "exports", "workspace-list", filters));
    expect(options.queryKey).not.toEqual(exportQueries.workspaceList(client, scope, {}).queryKey);
  });

  test("the detail read carries the workflow cursor", async () => {
    const { client, calls } = clientWith(() => jsonResponse({ id: EXPORT, lastSeq: 12 }));
    const detail = await exportQueries.detail(client, scope, PROJECT, CLIP, EXPORT).queryFn?.({ signal: new AbortController().signal } as never);
    expect(detail).toMatchObject({ lastSeq: 12 });
    expect(calls[0]?.url).toBe(`${BASE}/projects/${PROJECT}/clips/${CLIP}/exports/${EXPORT}`);
  });
});

describe("download grants", () => {
  test("a Workspace grant asks for one variant and returns the expiring URL", async () => {
    const grant = { exportId: EXPORT, variantId: VARIANT, fileName: "a.mp4", sizeBytes: 1, downloadUrl: "https://files.example/a?sig=1", expiresAt: "2026-10-29T00:15:00.000Z" };
    const { client, calls } = clientWith(() => jsonResponse(grant));
    expect(await exportCommands.workspaceDownloadGrant(client, EXPORT, VARIANT)).toEqual(grant);
    expect(calls[0]?.url).toBe(`${BASE}/workspace/exports/${EXPORT}/download?variant=${VARIANT}`);
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("a bundle grant is JSON and the grant call is never cached by a query", async () => {
    const { client, calls } = clientWith(() => jsonResponse({ downloadUrl: "https://files.example/b.zip?sig=2" }));
    expect(await exportCommands.bundleDownloadGrant(client, PROJECT, "bundle-1")).toEqual({ downloadUrl: "https://files.example/b.zip?sig=2" });
    expect(calls[0]?.url).toBe(`${BASE}/projects/${PROJECT}/export-bundles/bundle-1/download`);
    expect("downloadGrant" in exportQueries).toBe(false);
  });
});

describe("commands", () => {
  test("a Workspace retry posts to the Workspace route", async () => {
    const { client, calls } = clientWith(() => jsonResponse({ id: EXPORT }, { status: 202 }));
    await exportCommands.retryWorkspaceExport(client, EXPORT);
    expect(calls[0]?.url).toBe(`${BASE}/workspace/exports/${EXPORT}/retry`);
    expect(calls[0]?.init.method).toBe("POST");
  });

  test("starting an export and a bundle send the intent's Idempotency-Key", async () => {
    const { client, calls } = clientWith(() => jsonResponse({}, { status: 202 }));
    await exportCommands.create(client, PROJECT, CLIP, { expectedRevision: 2 }, "intent-1");
    expect(calls[0]?.headers.get("idempotency-key")).toBe("intent-1");
    expect(calls[0]?.url).toBe(`${BASE}/projects/${PROJECT}/clips/${CLIP}/exports`);
    await exportCommands.retryBundle(client, PROJECT, "bundle-1", "intent-2");
    expect(calls[1]?.headers.get("idempotency-key")).toBe("intent-2");
  });

  test("a change invalidates the export reads, the Project and credits", async () => {
    const queryClient = new QueryClient();
    const keys = [
      scopedKey(scope, "exports", "workspace-list", {}),
      scopedKey(scope, "workspace", "usage"),
      scopedKey(scope, "workspace", "bootstrap"),
      scopedKey(scope, "projects", "detail", PROJECT),
      scopedKey(scope, "brand", "list"),
    ];
    for (const key of keys) queryClient.setQueryData(key as unknown[], 1);
    await invalidateAfterExportChange(queryClient, scope, PROJECT);
    const stale = keys.map((key) => queryClient.getQueryState(key as unknown[])?.isInvalidated);
    expect(stale).toEqual([true, true, true, true, false]);
  });
});

describe("attachments", () => {
  test("a timeline ZIP keeps its type, file name and editor revision", async () => {
    const { client, calls } = clientWith(
      () =>
        new Response(new Uint8Array([80, 75, 3, 4]), {
          headers: {
            "Content-Type": "application/zip",
            "Content-Disposition": 'attachment; filename="clip-fcpxml.zip"',
            "X-Editor-Revision": "7",
          },
        }),
    );
    const archive = await fetchTimelineArchive(client, PROJECT, CLIP, "fcpxml");
    expect(calls[0]?.url).toBe(`${BASE}/projects/${PROJECT}/clips/${CLIP}/timeline/fcpxml`);
    expect(archive).toMatchObject({ contentType: "application/zip", fileName: "clip-fcpxml.zip", editorRevision: 7 });
    expect(archive.blob.size).toBe(4);
  });

  test("a missing revision header is null, not zero", async () => {
    const { client } = clientWith(() => new Response("zip", { headers: { "Content-Type": "application/zip" } }));
    expect((await fetchTimelineArchive(client, PROJECT, CLIP, "fcpxml")).editorRevision).toBeNull();
  });

  test("subtitles keep their text, type and name", async () => {
    const { client, calls } = clientWith(
      () =>
        new Response("1\n00:00:00,000 --> 00:00:01,000\nHi\n", {
          headers: { "Content-Type": "application/x-subrip; charset=utf-8", "Content-Disposition": 'attachment; filename="clip.srt"' },
        }),
    );
    const file = await fetchSubtitleFile(client, PROJECT, CLIP, EXPORT, "srt");
    expect(calls[0]?.url).toBe(`${BASE}/projects/${PROJECT}/clips/${CLIP}/exports/${EXPORT}/subtitles/srt`);
    expect(file).toMatchObject({ fileName: "clip.srt", contentType: "application/x-subrip; charset=utf-8" });
    expect(await file.blob.text()).toContain("Hi");
  });

  test("a refusal throws its typed error instead of becoming a file", async () => {
    const { client } = clientWith(() => errorResponse(402, "plan_feature_required"));
    await expect(fetchTimelineArchive(client, PROJECT, CLIP, "fcpxml")).rejects.toMatchObject({ code: "plan_feature_required", status: 402 });
  });

  test("an oversized body is refused, so media is never inflated into memory", async () => {
    const { client } = clientWith(
      () => new Response("x", { headers: { "Content-Length": String(EXPORT_ATTACHMENT_MAX_BYTES + 1) } }),
    );
    await expect(fetchSubtitleFile(client, PROJECT, CLIP, EXPORT, "vtt")).rejects.toBeInstanceOf(RangeError);
  });
});
