import { expect, test } from "bun:test";
import { ingestExecutionInputHash, ingestYouTubeMediaId } from "./ingest-source-execution";

test("the native source command receives a normalized YouTube identity", () => {
  for (const url of ["https://youtu.be/dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "https://m.youtube.com/shorts/dQw4w9WgXcQ"]) expect(ingestYouTubeMediaId(url)).toBe("dQw4w9WgXcQ");
  for (const url of ["https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ", "https://youtube.com/watch?v=dQw4w9WgXcQ&v=abcdefghijk", "https://user@youtube.com/watch?v=dQw4w9WgXcQ", "https://youtube.com/watch?v=short", "file:///tmp/source", "https://youtube.com:8443/watch?v=dQw4w9WgXcQ"]) expect(() => ingestYouTubeMediaId(url)).toThrow("invalid_reference");
});

test("frozen ingest input survives JSONB key ordering and changes with source, epoch and image", async () => {
  const input = { id: crypto.randomUUID(), projectId: crypto.randomUUID(), jobType: "link_import", payload: { provider: "youtube", url: "https://youtu.be/dQw4w9WgXcQ" }, sourceRevision: 1, generation: 1, deploymentEpoch: 1 };
  const hash = await ingestExecutionInputHash(input, "a".repeat(64));
  expect(await ingestExecutionInputHash({ ...input, payload: { url: input.payload.url, provider: "youtube" } }, "a".repeat(64))).toBe(hash);
  for (const change of [{ sourceRevision: 2 }, { generation: 2 }, { deploymentEpoch: 2 }]) expect(await ingestExecutionInputHash({ ...input, ...change }, "a".repeat(64))).not.toBe(hash);
  expect(await ingestExecutionInputHash(input, "b".repeat(64))).not.toBe(hash);
});
