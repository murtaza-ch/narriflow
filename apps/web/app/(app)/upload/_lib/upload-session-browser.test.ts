import { describe, expect, test } from "bun:test";
import { runUploadSessionTransfer } from "./upload-session-browser";
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
});
