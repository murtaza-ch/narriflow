import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadVideo } from "./upload";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const key = "6d27d010-f52c-4e5c-9ea3-012c0bf7d921";
const workspaceId = "b6558e07-d826-46a2-a919-4c9a4e7c4c62";
const sessionId = "27ea4880-e97e-49a4-b8e0-8af86e00a1d7";
async function source() {
  const directory = await mkdtemp(join(tmpdir(), "narriflow-upload-"));
  directories.push(directory);
  const path = join(directory, "sample.mp4");
  await writeFile(path, "abcdefghijkl");
  return path;
}

describe("local Upload Session delivery", () => {
  test("resumes server-verified parts and sends credentials only to Narriflow", async () => {
    const calls: Array<{ url: string; authorization: string | null; body: unknown }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get("authorization");
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      calls.push({ url, authorization, body });
      if (url.endsWith("/open")) return Response.json({ outcome: "uploading", sessionId, projectId: "project", transfer: { kind: "multipart", partSizeBytes: 4, partCount: 3, concurrency: 2, completedParts: [{ partNumber: 1, etag: "first" }], grants: [{ partNumber: 2, url: "https://storage.test/two" }, { partNumber: 3, url: "https://storage.test/three" }] } });
      if (url.startsWith("https://storage.test")) return new Response(null, { headers: { ETag: url.endsWith("two") ? "second" : "third" } });
      if (url.endsWith("/finalize")) return Response.json({ outcome: "queued_for_ingest", sessionId, projectId: "project", queuedJobId: "ingest" });
      throw new Error("Unexpected request");
    };
    const result = await uploadVideo({ endpoint: "https://narriflow.test", apiKey: "nf_secret", workspaceId, filePath: await source(), clientIdempotencyKey: key, fetch: fakeFetch });
    expect(result).toEqual({ outcome: "queued_for_ingest", sessionId, projectId: "project", queuedJobId: "ingest" });
    expect(calls.filter((call) => call.url.startsWith("https://storage.test")).map((call) => call.authorization)).toEqual([null, null]);
    expect(calls.filter((call) => call.url.startsWith("https://storage.test")).map((call) => new TextDecoder().decode(call.body as Uint8Array))).toEqual(["efgh", "ijkl"]);
    expect(calls.at(-1)?.body).toEqual({ sessionId, parts: [{ partNumber: 1, etag: "first" }, { partNumber: 2, etag: "second" }, { partNumber: 3, etag: "third" }] });
    expect(calls[0]?.authorization).toBe("Bearer nf_secret");
  });

  test("a lost transfer keeps the same upload identity and resumes without resending completed parts", async () => {
    const path = await source();
    const openings: unknown[] = [];
    const completed: Array<{ partNumber: number; etag: string }> = [];
    const stored: string[] = [];
    let interrupted = true;
    const transport: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/open")) {
        openings.push(JSON.parse(String(init?.body)));
        return Response.json({ outcome: "uploading", sessionId, projectId: "project", transfer: { kind: "multipart", partSizeBytes: 4, partCount: 3, concurrency: 1, completedParts: completed, grants: [1, 2, 3].map((partNumber) => ({ partNumber, url: `https://storage.test/${partNumber}` })) } });
      }
      if (url.startsWith("https://storage.test")) {
        const partNumber = Number(url.split("/").at(-1));
        if (interrupted && partNumber === 2) { interrupted = false; throw new Error("connection lost"); }
        completed.push({ partNumber, etag: `part-${partNumber}` });
        stored.push(url);
        return new Response(null, { headers: { ETag: `part-${partNumber}` } });
      }
      if (url.endsWith("/finalize")) return Response.json({ outcome: "queued_for_ingest", sessionId, projectId: "project", queuedJobId: "ingest" });
      throw new Error("Unexpected request");
    };
    const options = { endpoint: "https://narriflow.test", apiKey: "nf_secret", workspaceId, filePath: path, clientIdempotencyKey: key, fetch: transport };
    await expect(uploadVideo(options)).rejects.toThrow("connection lost");
    await expect(uploadVideo(options)).resolves.toMatchObject({ outcome: "queued_for_ingest" });
    expect(openings[1]).toEqual(openings[0]);
    expect(stored).toEqual(["https://storage.test/1", "https://storage.test/2", "https://storage.test/3"]);
  });
});
