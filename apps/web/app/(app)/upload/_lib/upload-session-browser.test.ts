import { describe, expect, test } from "bun:test";
import {
  runUploadSessionTransfer,
  uploadRetryDelayMs,
} from "./upload-session-browser";
import {
  UPLOAD_RESUME_STORAGE_KEY,
  type UploadResumeStorage,
} from "./upload-resume";

function memoryStorage(): UploadResumeStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

describe("Upload Session browser adapter", () => {
  test("uses bounded exponential retry delays with full jitter bands", () => {
    expect(uploadRetryDelayMs(1, () => 0)).toBe(250);
    expect(uploadRetryDelayMs(1, () => 1)).toBe(750);
    expect(uploadRetryDelayMs(2, () => 0)).toBe(500);
    expect(uploadRetryDelayMs(2, () => 1)).toBe(1_500);
  });

  test("persists intent before open and sends a small file through one typed PUT", async () => {
    const storage = memoryStorage();
    const requests: Array<{ url: string; method: string; contentType: string | null }> = [];
    const source = new File([new Uint8Array([1, 2, 3, 4])], "short.wav", {
      type: "audio/wav",
      lastModified: 42,
    });
    const fetcher: typeof fetch = async (request, init) => {
      const url = String(request);
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      requests.push({ url, method, contentType: headers.get("Content-Type") });
      if (url === "/api/upload-sessions/open") {
        const saved = storage.values.get(UPLOAD_RESUME_STORAGE_KEY);
        expect(saved).toBeDefined();
        expect(JSON.parse(saved!)).toMatchObject({
          sessionId: null,
          projectId: null,
        });
        return Response.json({
          outcome: "uploading",
          sessionId: "11111111-1111-4111-8111-111111111111",
          projectId: "22222222-2222-4222-8222-222222222222",
          expiresAt: "2026-08-28T00:00:00.000Z",
          transfer: {
            kind: "single",
            contentType: "audio/wav",
            grant: {
              url: "https://upload.invalid/single",
              contentType: "audio/wav",
            },
          },
        });
      }
      if (url === "https://upload.invalid/single") {
        expect(init?.body).toBe(source);
        return new Response(null, { status: 200 });
      }
      if (url === "/api/upload-sessions/finalize") {
        expect(JSON.parse(String(init?.body))).toEqual({
          sessionId: "11111111-1111-4111-8111-111111111111",
          parts: [],
        });
        return Response.json({
          outcome: "queued_for_ingest",
          sessionId: "11111111-1111-4111-8111-111111111111",
          projectId: "22222222-2222-4222-8222-222222222222",
          queuedJobId: "33333333-3333-4333-8333-333333333333",
        });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    };

    const result = await runUploadSessionTransfer({
      file: source,
      title: "Short audio",
      brandTemplateId: null,
      generationContext: { languageCode: "en", contentPack: {} },
      storage,
      fetcher,
      createClientKey: () => "44444444-4444-4444-8444-444444444444",
    });

    expect(result).toEqual({
      projectId: "22222222-2222-4222-8222-222222222222",
    });
    expect(requests).toEqual([
      {
        url: "/api/upload-sessions/open",
        method: "POST",
        contentType: "application/json",
      },
      {
        url: "https://upload.invalid/single",
        method: "PUT",
        contentType: "audio/wav",
      },
      {
        url: "/api/upload-sessions/finalize",
        method: "POST",
        contentType: "application/json",
      },
    ]);
    expect(storage.values.has(UPLOAD_RESUME_STORAGE_KEY)).toBe(false);
  });

  test("slices multipart bytes from the server plan and finalizes opaque-free parts", async () => {
    const storage = memoryStorage();
    const source = new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7])], "large.mp4", {
      type: "video/mp4",
      lastModified: 77,
    });
    const uploadedSizes: number[] = [];
    const fetcher: typeof fetch = async (request, init) => {
      const url = String(request);
      if (url === "/api/upload-sessions/open") {
        return Response.json({
          outcome: "uploading",
          sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          transfer: {
            kind: "multipart",
            partSizeBytes: 4,
            partCount: 2,
            concurrency: 2,
            grantExpiresAt: "2099-08-27T00:15:00.000Z",
            grants: [
              { partNumber: 1, url: "https://upload.invalid/part/1" },
              { partNumber: 2, url: "https://upload.invalid/part/2" },
            ],
            completedParts: [],
          },
        });
      }
      if (url.startsWith("https://upload.invalid/part/")) {
        const body = init?.body;
        if (!(body instanceof Blob)) throw new Error("expected Blob part");
        uploadedSizes.push(body.size);
        return new Response(null, {
          status: 200,
          headers: { ETag: `"etag-${url.at(-1)}"` },
        });
      }
      if (url === "/api/upload-sessions/finalize") {
        expect(JSON.parse(String(init?.body))).toEqual({
          sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          parts: [
            { partNumber: 1, etag: "etag-1" },
            { partNumber: 2, etag: "etag-2" },
          ],
        });
        return Response.json({
          outcome: "queued_for_ingest",
          sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          queuedJobId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    await runUploadSessionTransfer({
      file: source,
      title: "Large source",
      brandTemplateId: null,
      generationContext: { languageCode: "auto", contentPack: {} },
      storage,
      fetcher,
      createClientKey: () => "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    });

    expect(uploadedSizes.sort((left, right) => right - left)).toEqual([4, 3]);
  });

  test("requests multipart grants in windows until every planned byte is stored", async () => {
    const source = new File(
      [new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])],
      "windowed.mp4",
      { type: "video/mp4", lastModified: 78 },
    );
    const requestedWindows: number[][] = [];
    const uploadedParts: number[] = [];
    const fetcher: typeof fetch = async (request, init) => {
      const url = String(request);
      if (url === "/api/upload-sessions/open") {
        return Response.json({
          outcome: "uploading",
          sessionId: "abababab-abab-4bab-8bab-abababababab",
          projectId: "bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc",
          transfer: {
            kind: "multipart",
            partSizeBytes: 2,
            partCount: 5,
            concurrency: 2,
            grantExpiresAt: "2099-08-27T00:15:00.000Z",
            grants: [
              { partNumber: 1, url: "https://upload.invalid/part/1" },
              { partNumber: 2, url: "https://upload.invalid/part/2" },
            ],
            completedParts: [],
          },
        });
      }
      if (url === "/api/upload-sessions/grants") {
        const partNumbers = JSON.parse(String(init?.body)).partNumbers as number[];
        requestedWindows.push(partNumbers);
        return Response.json({
          outcome: "granted",
          sessionId: "abababab-abab-4bab-8bab-abababababab",
          expiresAt: "2099-08-27T00:15:00.000Z",
          grants: partNumbers.map((partNumber) => ({
            partNumber,
            url: `https://upload.invalid/part/${partNumber}`,
          })),
        });
      }
      if (url.startsWith("https://upload.invalid/part/")) {
        const partNumber = Number(url.slice(url.lastIndexOf("/") + 1));
        uploadedParts.push(partNumber);
        return new Response(null, {
          status: 200,
          headers: { ETag: `"etag-${partNumber}"` },
        });
      }
      if (url === "/api/upload-sessions/finalize") {
        return Response.json({
          outcome: "queued_for_ingest",
          sessionId: "abababab-abab-4bab-8bab-abababababab",
          projectId: "bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc",
          queuedJobId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    await runUploadSessionTransfer({
      file: source,
      title: "Windowed source",
      brandTemplateId: null,
      generationContext: { languageCode: "auto", contentPack: {} },
      storage: null,
      fetcher,
      createClientKey: () => "dededede-dede-4ede-8ede-dededededede",
    });

    expect(requestedWindows).toEqual([[3, 4, 5]]);
    expect(uploadedParts.sort((left, right) => left - right)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  test("never exceeds the server-declared multipart concurrency", async () => {
    const source = new File([new Uint8Array(8)], "bounded.mp4", {
      type: "video/mp4",
      lastModified: 781,
    });
    let active = 0;
    let maximumActive = 0;
    const fetcher: typeof fetch = async (request) => {
      const url = String(request);
      if (url === "/api/upload-sessions/open") {
        return Response.json({
          outcome: "uploading",
          sessionId: "abababab-abab-4bab-8bab-abababababac",
          projectId: "bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbccd",
          transfer: {
            kind: "multipart",
            partSizeBytes: 1,
            partCount: 8,
            concurrency: 4,
            grantExpiresAt: "2099-08-27T00:15:00.000Z",
            grants: Array.from({ length: 8 }, (_, index) => ({
              partNumber: index + 1,
              url: `https://upload.invalid/bounded/${index + 1}`,
            })),
            completedParts: [],
          },
        });
      }
      if (url === "/api/upload-sessions/finalize") {
        return Response.json({
          outcome: "queued_for_ingest",
          sessionId: "abababab-abab-4bab-8bab-abababababac",
          projectId: "bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbccd",
          queuedJobId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdce",
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    await runUploadSessionTransfer({
      file: source,
      title: "Bounded source",
      brandTemplateId: null,
      generationContext: { languageCode: "auto", contentPack: {} },
      storage: null,
      fetcher,
      uploadTransport: async ({ url }) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return { etag: `etag-${url.slice(url.lastIndexOf("/") + 1)}` };
      },
      createClientKey: () => "dededede-dede-4ede-8ede-dedededededf",
    });

    expect(maximumActive).toBe(4);
  });

  test("reports resumed and active multipart bytes before requests settle", async () => {
    const source = new File(
      [new Uint8Array([1, 2, 3, 4, 5, 6, 7])],
      "progress.mp4",
      { type: "video/mp4", lastModified: 79 },
    );
    const transferred: number[] = [];
    const throughput: Array<{ bytesPerSecond: number; etaSeconds: number | null }> = [];
    let clock = 0;
    const fetcher: typeof fetch = async (request) => {
      const url = String(request);
      if (url === "/api/upload-sessions/open") {
        return Response.json({
          outcome: "uploading",
          sessionId: "acacacac-acac-4cac-8cac-acacacacacac",
          projectId: "bdbdbdbd-bdbd-4dbd-8dbd-bdbdbdbdbdbd",
          transfer: {
            kind: "multipart",
            partSizeBytes: 3,
            partCount: 3,
            concurrency: 2,
            grantExpiresAt: "2099-08-27T00:15:00.000Z",
            grants: [
              { partNumber: 2, url: "https://upload.invalid/part/2" },
              { partNumber: 3, url: "https://upload.invalid/part/3" },
            ],
            completedParts: [{ partNumber: 1, etag: "etag-1" }],
          },
        });
      }
      if (url === "/api/upload-sessions/finalize") {
        return Response.json({
          outcome: "queued_for_ingest",
          sessionId: "acacacac-acac-4cac-8cac-acacacacacac",
          projectId: "bdbdbdbd-bdbd-4dbd-8dbd-bdbdbdbdbdbd",
          queuedJobId: "cececece-cece-4ece-8ece-cececececece",
        });
      }
      throw new Error(`Unexpected fetch request: ${url}`);
    };

    await runUploadSessionTransfer({
      file: source,
      title: "Progress source",
      brandTemplateId: null,
      generationContext: { languageCode: "auto", contentPack: {} },
      storage: null,
      fetcher,
      uploadTransport: async ({ body, onProgress, url }) => {
        onProgress(body.size);
        return { etag: `etag-${url.at(-1)}` };
      },
      onProgress: (progress) => {
        if (progress.stage === "upload") {
          transferred.push(progress.transferredBytes);
          if (progress.bytesPerSecond) {
            throughput.push({
              bytesPerSecond: progress.bytesPerSecond,
              etaSeconds: progress.etaSeconds ?? null,
            });
          }
        }
      },
      progressClock: () => {
        clock += 1_000;
        return clock;
      },
      createClientKey: () => "dfdfdfdf-dfdf-4fdf-8fdf-dfdfdfdfdfdf",
    });

    expect(transferred[0]).toBe(3);
    expect(transferred).toContain(6);
    expect(transferred.at(-1)).toBe(7);
    expect(throughput.length).toBeGreaterThan(0);
    expect(throughput.every((sample) => sample.bytesPerSecond > 0)).toBe(true);
    expect(throughput.at(-1)?.etaSeconds).toBe(0);
  });

  test("keeps the resume record and returns Verifying after an ambiguous finalize", async () => {
    const storage = memoryStorage();
    const source = new File([new Uint8Array([1, 2, 3])], "verify.mp4", {
      type: "video/mp4",
      lastModified: 80,
    });
    const fetcher: typeof fetch = async (request) => {
      const url = String(request);
      if (url === "/api/upload-sessions/open") {
        return Response.json({
          outcome: "uploading",
          sessionId: "adadadad-adad-4dad-8dad-adadadadadad",
          projectId: "bebebebe-bebe-4ebe-8ebe-bebebebebebe",
          transfer: {
            kind: "single",
            contentType: "video/mp4",
            grant: {
              url: "https://upload.invalid/verify",
              contentType: "video/mp4",
            },
          },
        });
      }
      if (url === "https://upload.invalid/verify") {
        return new Response(null, { status: 200 });
      }
      if (url === "/api/upload-sessions/finalize") {
        return Response.json(
          {
            outcome: "reconciling",
            sessionId: "adadadad-adad-4dad-8dad-adadadadadad",
            retryAfterSeconds: 5,
          },
          { status: 202, headers: { "Retry-After": "5" } },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const result = await runUploadSessionTransfer({
      file: source,
      title: "Verify source",
      brandTemplateId: null,
      generationContext: { languageCode: "auto", contentPack: {} },
      storage,
      fetcher,
      createClientKey: () => "efefefef-efef-4fef-8fef-efefefefefef",
    });

    expect(result).toEqual({
      outcome: "reconciling",
      projectId: "bebebebe-bebe-4ebe-8ebe-bebebebebebe",
      sessionId: "adadadad-adad-4dad-8dad-adadadadadad",
      retryAfterSeconds: 5,
    });
    expect(storage.values.has(UPLOAD_RESUME_STORAGE_KEY)).toBe(true);
  });

  test("refreshes a multipart grant window before near-expiry URLs are used", async () => {
    const source = new File([new Uint8Array([1, 2, 3])], "expiring.mp4", {
      type: "video/mp4",
      lastModified: 81,
    });
    const requests: string[] = [];
    const fetcher: typeof fetch = async (request, init) => {
      const url = String(request);
      requests.push(url);
      if (url === "/api/upload-sessions/open") {
        return Response.json({
          outcome: "uploading",
          sessionId: "aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeae",
          projectId: "bfbfbfbf-bfbf-4fbf-8fbf-bfbfbfbfbfbf",
          transfer: {
            kind: "multipart",
            partSizeBytes: 3,
            partCount: 1,
            concurrency: 1,
            grantExpiresAt: "2026-08-27T00:00:30.000Z",
            grants: [
              { partNumber: 1, url: "https://upload.invalid/part/old-1" },
            ],
            completedParts: [],
          },
        });
      }
      if (url === "/api/upload-sessions/grants") {
        expect(JSON.parse(String(init?.body))).toEqual({
          sessionId: "aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeae",
          partNumbers: [1],
        });
        return Response.json({
          outcome: "granted",
          sessionId: "aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeae",
          expiresAt: "2026-08-27T00:15:00.000Z",
          grants: [
            { partNumber: 1, url: "https://upload.invalid/part/fresh-1" },
          ],
        });
      }
      if (url === "https://upload.invalid/part/fresh-1") {
        return new Response(null, { status: 200, headers: { ETag: "etag-1" } });
      }
      if (url === "/api/upload-sessions/finalize") {
        return Response.json({
          outcome: "queued_for_ingest",
          sessionId: "aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeae",
          projectId: "bfbfbfbf-bfbf-4fbf-8fbf-bfbfbfbfbfbf",
          queuedJobId: "cfcfcfcf-cfcf-4fcf-8fcf-cfcfcfcfcfcf",
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    await runUploadSessionTransfer({
      file: source,
      title: "Expiring grant",
      brandTemplateId: null,
      generationContext: { languageCode: "auto", contentPack: {} },
      storage: null,
      fetcher,
      now: () => Date.parse("2026-08-27T00:00:00.000Z"),
      createClientKey: () => "f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f0f0",
    });

    expect(requests).not.toContain("https://upload.invalid/part/old-1");
    expect(requests).toContain("https://upload.invalid/part/fresh-1");
  });

  test("refreshes a grant that expires while an earlier part is still uploading", async () => {
    const source = new File([new Uint8Array([1, 2])], "slow-window.mp4", {
      type: "video/mp4",
      lastModified: 811,
    });
    let now = Date.parse("2026-08-27T00:00:00.000Z");
    const uploadedUrls: string[] = [];
    const refreshedParts: number[][] = [];
    const fetcher: typeof fetch = async (request, init) => {
      const url = String(request);
      if (url === "/api/upload-sessions/open") {
        return Response.json({
          outcome: "uploading",
          sessionId: "aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeaf",
          projectId: "bfbfbfbf-bfbf-4fbf-8fbf-bfbfbfbfbfc0",
          transfer: {
            kind: "multipart",
            partSizeBytes: 1,
            partCount: 2,
            concurrency: 1,
            grantExpiresAt: "2026-08-27T00:02:00.000Z",
            grants: [
              { partNumber: 1, url: "https://upload.invalid/slow/old-1" },
              { partNumber: 2, url: "https://upload.invalid/slow/old-2" },
            ],
            completedParts: [],
          },
        });
      }
      if (url === "/api/upload-sessions/grants") {
        const partNumbers = JSON.parse(String(init?.body)).partNumbers as number[];
        refreshedParts.push(partNumbers);
        return Response.json({
          outcome: "granted",
          sessionId: "aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeaf",
          expiresAt: "2026-08-27T00:17:00.000Z",
          grants: partNumbers.map((partNumber) => ({
            partNumber,
            url: `https://upload.invalid/slow/fresh-${partNumber}`,
          })),
        });
      }
      if (url === "/api/upload-sessions/finalize") {
        return Response.json({
          outcome: "queued_for_ingest",
          sessionId: "aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeaf",
          projectId: "bfbfbfbf-bfbf-4fbf-8fbf-bfbfbfbfbfc0",
          queuedJobId: "cfcfcfcf-cfcf-4fcf-8fcf-cfcfcfcfcfd0",
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    await runUploadSessionTransfer({
      file: source,
      title: "Slow window",
      brandTemplateId: null,
      generationContext: { languageCode: "auto", contentPack: {} },
      storage: null,
      fetcher,
      now: () => now,
      uploadTransport: async ({ url }) => {
        uploadedUrls.push(url);
        if (url.endsWith("old-1")) {
          now = Date.parse("2026-08-27T00:01:10.000Z");
        }
        return { etag: `etag-${uploadedUrls.length}` };
      },
      createClientKey: () => "f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f0f1",
    });

    expect(uploadedUrls).toEqual([
      "https://upload.invalid/slow/old-1",
      "https://upload.invalid/slow/fresh-2",
    ]);
    expect(refreshedParts).toEqual([[2]]);
  });

  test("keeps expiry attached to each URL when concurrent workers refresh", async () => {
    const source = new File([new Uint8Array([1, 2, 3])], "concurrent-expiry.mp4", {
      type: "video/mp4",
      lastModified: 813,
    });
    let now = Date.parse("2026-08-27T00:00:00.000Z");
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const uploadedUrls: string[] = [];
    const refreshedParts: number[][] = [];
    const fetcher: typeof fetch = async (request, init) => {
      const url = String(request);
      if (url === "/api/upload-sessions/open") {
        return Response.json({
          outcome: "uploading",
          sessionId: "aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeb0",
          projectId: "bfbfbfbf-bfbf-4fbf-8fbf-bfbfbfbfbfc1",
          transfer: {
            kind: "multipart",
            partSizeBytes: 1,
            partCount: 3,
            concurrency: 2,
            grantExpiresAt: "2026-08-27T00:02:00.000Z",
            grants: [1, 2, 3].map((partNumber) => ({
              partNumber,
              url: `https://upload.invalid/concurrent/old-${partNumber}`,
            })),
            completedParts: [],
          },
        });
      }
      if (url === "/api/upload-sessions/grants") {
        const partNumbers = JSON.parse(String(init?.body)).partNumbers as number[];
        refreshedParts.push(partNumbers);
        return Response.json({
          outcome: "granted",
          sessionId: "aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeb0",
          expiresAt: "2026-08-27T00:17:00.000Z",
          grants: partNumbers.map((partNumber) => ({
            partNumber,
            url: `https://upload.invalid/concurrent/fresh-${partNumber}`,
          })),
        });
      }
      if (url === "/api/upload-sessions/finalize") {
        return Response.json({
          outcome: "queued_for_ingest",
          sessionId: "aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeb0",
          projectId: "bfbfbfbf-bfbf-4fbf-8fbf-bfbfbfbfbfc1",
          queuedJobId: "cfcfcfcf-cfcf-4fcf-8fcf-cfcfcfcfcfd1",
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    let failedSecond = false;

    await runUploadSessionTransfer({
      file: source,
      title: "Concurrent expiry",
      brandTemplateId: null,
      generationContext: { languageCode: "auto", contentPack: {} },
      storage: null,
      fetcher,
      now: () => now,
      uploadTransport: async ({ url }) => {
        uploadedUrls.push(url);
        if (url.endsWith("old-1")) await firstBlocked;
        if (url.endsWith("old-2") && !failedSecond) {
          failedSecond = true;
          now = Date.parse("2026-08-27T00:01:10.000Z");
          throw new TypeError("opaque expiry failure");
        }
        if (url.endsWith("fresh-2")) releaseFirst();
        return { etag: `etag-${url.slice(url.lastIndexOf("-") + 1)}` };
      },
      createClientKey: () => "f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f0f2",
    });

    expect(refreshedParts).toEqual([[2], [3]]);
    expect(uploadedUrls).toContain(
      "https://upload.invalid/concurrent/fresh-3",
    );
    expect(uploadedUrls).not.toContain(
      "https://upload.invalid/concurrent/old-3",
    );
  });

  test("refreshes once after an opaque failure near grant expiry", async () => {
    const source = new File([new Uint8Array([1, 2, 3])], "opaque.mp4", {
      type: "video/mp4",
      lastModified: 82,
    });
    let now = Date.parse("2026-08-27T00:00:00.000Z");
    let oldAttempts = 0;
    let ordinaryWaits = 0;
    const fetcher: typeof fetch = async (request) => {
      const url = String(request);
      if (url === "/api/upload-sessions/open") {
        return Response.json({
          outcome: "uploading",
          sessionId: "afafafaf-afaf-4faf-8faf-afafafafafaf",
          projectId: "b0b0b0b0-b0b0-40b0-80b0-b0b0b0b0b0b0",
          transfer: {
            kind: "multipart",
            partSizeBytes: 3,
            partCount: 1,
            concurrency: 1,
            grantExpiresAt: "2026-08-27T00:02:00.000Z",
            grants: [
              { partNumber: 1, url: "https://upload.invalid/part/opaque-old" },
            ],
            completedParts: [],
          },
        });
      }
      if (url === "https://upload.invalid/part/opaque-old") {
        oldAttempts += 1;
        now = Date.parse("2026-08-27T00:01:30.000Z");
        throw new TypeError("Failed to fetch");
      }
      if (url === "/api/upload-sessions/grants") {
        return Response.json({
          outcome: "granted",
          sessionId: "afafafaf-afaf-4faf-8faf-afafafafafaf",
          expiresAt: "2026-08-27T00:16:30.000Z",
          grants: [
            { partNumber: 1, url: "https://upload.invalid/part/opaque-fresh" },
          ],
        });
      }
      if (url === "https://upload.invalid/part/opaque-fresh") {
        return new Response(null, { status: 200, headers: { ETag: "etag-1" } });
      }
      if (url === "/api/upload-sessions/finalize") {
        return Response.json({
          outcome: "queued_for_ingest",
          sessionId: "afafafaf-afaf-4faf-8faf-afafafafafaf",
          projectId: "b0b0b0b0-b0b0-40b0-80b0-b0b0b0b0b0b0",
          queuedJobId: "c0c0c0c0-c0c0-40c0-80c0-c0c0c0c0c0c0",
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    await runUploadSessionTransfer({
      file: source,
      title: "Opaque expiry",
      brandTemplateId: null,
      generationContext: { languageCode: "auto", contentPack: {} },
      storage: null,
      fetcher,
      now: () => now,
      waitBeforeRetry: async () => {
        ordinaryWaits += 1;
      },
      createClientKey: () => "f1f1f1f1-f1f1-41f1-81f1-f1f1f1f1f1f1",
    });

    expect(oldAttempts).toBe(1);
    expect(ordinaryWaits).toBe(0);
  });

  test("retries the complete direct source only within the bounded policy", async () => {
    const source = new File([new Uint8Array([1, 2, 3])], "retry.mp4", {
      type: "video/mp4",
      lastModified: 88,
    });
    const putBodies: BodyInit[] = [];
    const fetcher: typeof fetch = async (request, init) => {
      const url = String(request);
      if (url === "/api/upload-sessions/open") {
        return Response.json({
          outcome: "uploading",
          sessionId: "12121212-1212-4212-8212-121212121212",
          projectId: "34343434-3434-4434-8434-343434343434",
          transfer: {
            kind: "single",
            contentType: "video/mp4",
            grant: {
              url: "https://upload.invalid/retry",
              contentType: "video/mp4",
            },
          },
        });
      }
      if (url === "https://upload.invalid/retry") {
        if (!init?.body) throw new Error("missing PUT body");
        putBodies.push(init.body);
        return new Response(null, { status: putBodies.length < 3 ? 503 : 200 });
      }
      if (url === "/api/upload-sessions/finalize") {
        return Response.json({
          outcome: "queued_for_ingest",
          sessionId: "12121212-1212-4212-8212-121212121212",
          projectId: "34343434-3434-4434-8434-343434343434",
          queuedJobId: "56565656-5656-4565-8565-565656565656",
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    await runUploadSessionTransfer({
      file: source,
      title: "Retry source",
      brandTemplateId: null,
      generationContext: { languageCode: "en", contentPack: {} },
      fetcher,
      waitBeforeRetry: async () => {},
      createClientKey: () => "78787878-7878-4878-8878-787878787878",
    });

    expect(putBodies).toEqual([source, source, source]);
  });

  test("does not retry permanent upload authorization or input failures", async () => {
    const source = new File([new Uint8Array([1, 2, 3])], "permanent.mp4", {
      type: "video/mp4",
      lastModified: 89,
    });
    let attempts = 0;
    const fetcher: typeof fetch = async (request) => {
      const url = String(request);
      if (url === "/api/upload-sessions/open") {
        return Response.json({
          outcome: "uploading",
          sessionId: "13131313-1313-4313-8313-131313131313",
          projectId: "35353535-3535-4535-8535-353535353535",
          transfer: {
            kind: "single",
            contentType: "video/mp4",
            grant: {
              url: "https://upload.invalid/permanent",
              contentType: "video/mp4",
            },
          },
        });
      }
      if (url === "https://upload.invalid/permanent") {
        attempts += 1;
        return new Response(null, { status: 400 });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    await expect(
      runUploadSessionTransfer({
        file: source,
        title: "Permanent failure",
        brandTemplateId: null,
        generationContext: { languageCode: "en", contentPack: {} },
        storage: null,
        fetcher,
        waitBeforeRetry: async () => {},
        createClientKey: () => "79797979-7979-4979-8979-797979797979",
      }),
    ).rejects.toThrow("HTTP 400");
    expect(attempts).toBe(1);
  });

  test("records bounded multipart performance facts for medium, 1 GiB, and 5 GiB sources", async () => {
    const fixtureSizes = [
      256 * 1024 * 1024,
      1024 * 1024 * 1024,
      5 * 1024 * 1024 * 1024,
    ];
    const metrics: Array<{
      sourceBytes: number;
      firstGrantLatencyMs: number;
      grantResponseBytes: number;
      uploadDurationMs: number;
      throughputBytesPerSecond: number;
      retryBytes: number;
      browserPeakBytes: number;
    }> = [];

    for (const sourceBytes of fixtureSizes) {
      let clockMs = 0;
      let grantResponseBytes = 0;
      let attemptedBytes = 0;
      let activeBytes = 0;
      let browserPeakBytes = 0;
      let injectedRetry = false;
      let finalThroughput = 0;
      const partSizeBytes = 16 * 1024 * 1024;
      const partCount = Math.ceil(sourceBytes / partSizeBytes);
      const source = {
        name: `fixture-${sourceBytes}.mp4`,
        type: "video/mp4",
        size: sourceBytes,
        lastModified: 812,
        slice(start: number, end: number) {
          return { size: end - start } as Blob;
        },
      } as File;
      const grantPayload = (partNumbers: number[]) => ({
        outcome: "granted",
        sessionId: "11111111-1111-4111-8111-111111111119",
        expiresAt: "2099-08-27T00:15:00.000Z",
        grants: partNumbers.map((partNumber) => ({
          partNumber,
          url: `https://upload.invalid/perf/${partNumber}`,
        })),
      });
      const fetcher: typeof fetch = async (request, init) => {
        const url = String(request);
        if (url === "/api/upload-sessions/open") {
          clockMs += 8;
          const payload = {
            outcome: "uploading",
            sessionId: "11111111-1111-4111-8111-111111111119",
            projectId: "22222222-2222-4222-8222-222222222229",
            transfer: {
              kind: "multipart",
              partSizeBytes,
              partCount,
              concurrency: 4,
              grantExpiresAt: "2099-08-27T00:15:00.000Z",
              grants: grantPayload(
                Array.from(
                  { length: Math.min(16, partCount) },
                  (_, index) => index + 1,
                ),
              ).grants,
              completedParts: [],
            },
          };
          grantResponseBytes += new TextEncoder().encode(
            JSON.stringify(payload),
          ).byteLength;
          return Response.json(payload);
        }
        if (url === "/api/upload-sessions/grants") {
          clockMs += 5;
          const partNumbers = JSON.parse(String(init?.body))
            .partNumbers as number[];
          const payload = grantPayload(partNumbers);
          grantResponseBytes += new TextEncoder().encode(
            JSON.stringify(payload),
          ).byteLength;
          return Response.json(payload);
        }
        if (url === "/api/upload-sessions/finalize") {
          return Response.json({
            outcome: "queued_for_ingest",
            sessionId: "11111111-1111-4111-8111-111111111119",
            projectId: "22222222-2222-4222-8222-222222222229",
            queuedJobId: "33333333-3333-4333-8333-333333333339",
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      };
      const uploadStartedAtMs = clockMs;

      await runUploadSessionTransfer({
        file: source,
        title: "Performance fixture",
        brandTemplateId: null,
        generationContext: { languageCode: "auto", contentPack: {} },
        storage: null,
        fetcher,
        now: () => Date.parse("2026-08-27T00:00:00.000Z") + clockMs,
        progressClock: () => clockMs,
        waitBeforeRetry: async () => {},
        uploadTransport: async ({ body, onProgress, url }) => {
          attemptedBytes += body.size;
          activeBytes += body.size;
          browserPeakBytes = Math.max(browserPeakBytes, activeBytes);
          await Promise.resolve();
          if (!injectedRetry && url.endsWith("/1")) {
            injectedRetry = true;
            activeBytes -= body.size;
            throw new TypeError("opaque transient failure");
          }
          clockMs += Math.ceil((body.size / (64 * 1024 * 1024)) * 1_000);
          onProgress(body.size);
          activeBytes -= body.size;
          return { etag: `etag-${url.slice(url.lastIndexOf("/") + 1)}` };
        },
        onProgress: (progress) => {
          if (progress.stage === "upload" && progress.bytesPerSecond) {
            finalThroughput = progress.bytesPerSecond;
          }
        },
        createClientKey: () => "44444444-4444-4444-8444-444444444449",
      });

      metrics.push({
        sourceBytes,
        firstGrantLatencyMs: 8,
        grantResponseBytes,
        uploadDurationMs: clockMs - uploadStartedAtMs,
        throughputBytesPerSecond: finalThroughput,
        retryBytes: attemptedBytes - sourceBytes,
        browserPeakBytes,
      });
    }

    expect(metrics.map((metric) => metric.sourceBytes)).toEqual(fixtureSizes);
    expect(metrics.every((metric) => metric.firstGrantLatencyMs === 8)).toBe(
      true,
    );
    expect(metrics.every((metric) => metric.grantResponseBytes > 0)).toBe(true);
    expect(metrics.every((metric) => metric.uploadDurationMs > 0)).toBe(true);
    expect(
      metrics.every((metric) => metric.throughputBytesPerSecond > 0),
    ).toBe(true);
    expect(
      metrics.every((metric) => metric.retryBytes === 16 * 1024 * 1024),
    ).toBe(true);
    expect(
      metrics.every(
        (metric) => metric.browserPeakBytes <= 4 * 16 * 1024 * 1024,
      ),
    ).toBe(true);
  });

  test("pause waits for active part requests to settle and preserves resume intent", async () => {
    const storage = memoryStorage();
    const source = new File([new Uint8Array([1, 2, 3, 4])], "pause.mp4", {
      type: "video/mp4",
      lastModified: 90,
    });
    const controller = new AbortController();
    let active = 0;
    let signalReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    const fetcher: typeof fetch = async (request) => {
      const url = String(request);
      if (url === "/api/upload-sessions/open") {
        return Response.json({
          outcome: "uploading",
          sessionId: "14141414-1414-4414-8414-141414141414",
          projectId: "36363636-3636-4636-8636-363636363636",
          transfer: {
            kind: "multipart",
            partSizeBytes: 2,
            partCount: 2,
            concurrency: 2,
            grantExpiresAt: "2099-08-27T00:15:00.000Z",
            grants: [
              { partNumber: 1, url: "https://upload.invalid/part/pause-1" },
              { partNumber: 2, url: "https://upload.invalid/part/pause-2" },
            ],
            completedParts: [],
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    const transfer = runUploadSessionTransfer({
      file: source,
      title: "Pause source",
      brandTemplateId: null,
      generationContext: { languageCode: "auto", contentPack: {} },
      storage,
      fetcher,
      signal: controller.signal,
      uploadTransport: ({ url, signal }) =>
        new Promise((_, reject) => {
          active += 1;
          if (active === 2) signalReady();
          signal?.addEventListener(
            "abort",
            () => {
              setTimeout(
                () => {
                  active -= 1;
                  reject(new DOMException("Paused", "AbortError"));
                },
                url.endsWith("1") ? 0 : 10,
              );
            },
            { once: true },
          );
        }),
      createClientKey: () => "80808080-8080-4080-8080-808080808080",
    });
    await ready;
    controller.abort();

    await expect(transfer).rejects.toMatchObject({ name: "AbortError" });
    expect(active).toBe(0);
    expect(storage.values.has(UPLOAD_RESUME_STORAGE_KEY)).toBe(true);
  });
});
