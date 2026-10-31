import { expect, test } from "bun:test";
import type { ExecutionArtifact } from "@prisma/client";
import type { ExecutorArtifactCommit } from "@narriflow/services/executor-domain-control";
import { createAssignedArtifactStorage } from "./artifact-storage";

const assignment = { id: crypto.randomUUID(), storageKey: "execution/1/token/owner/artifact", bindingHash: "a".repeat(64) } as ExecutionArtifact;
const bytes = new TextEncoder().encode('{"measured":true}');
const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
const metadata = { key: assignment.storageKey, httpEtag: '"sealed"', size: bytes.byteLength, httpMetadata: { contentType: "application/json" },
  customMetadata: { "execution-artifact-id": assignment.id, "execution-binding-hash": assignment.bindingHash }, checksums: {} };
const artifact: ExecutorArtifactCommit = { artifactId: assignment.id, role: "probe", bindingHash: assignment.bindingHash,
  storageKey: assignment.storageKey, contentType: "application/json", byteLength: BigInt(bytes.byteLength), etag: metadata.httpEtag, sha256 };

test("assigned artifact reads bind metadata, ETag, length and measured JSON digest", async () => {
  const port = createAssignedArtifactStorage({
    head: async (key: string) => { expect(key).toBe(assignment.storageKey); return metadata; },
    get: async (key: string, options: R2GetOptions) => {
      expect(key).toBe(assignment.storageKey);
      expect((options.onlyIf as Headers).get("If-Match")).toBe(metadata.httpEtag);
      expect(options.range).toEqual({ offset: 0, length: 65537 });
      return { ...metadata, body: new Blob([bytes]).stream() };
    },
  } as unknown as R2Bucket);
  expect(await port.head(assignment)).toMatchObject({ etag: metadata.httpEtag, byteLength: BigInt(bytes.byteLength) });
  expect(await port.readJson(artifact, 65536)).toEqual({ measured: true });
  await expect(port.readJson({ ...artifact, sha256: "b".repeat(64) }, 65536)).rejects.toMatchObject({ code: "artifact_invalid" });
});

test("changed assigned metadata or ETag never supplies typed domain evidence", async () => {
  const port = createAssignedArtifactStorage({ head: async () => ({ ...metadata, customMetadata: {} }),
    get: async () => ({ ...metadata, httpEtag: '"replaced"', body: new Blob([bytes]).stream() }),
  } as unknown as R2Bucket);
  await expect(port.head(assignment)).rejects.toMatchObject({ code: "artifact_invalid" });
  await expect(port.readJson(artifact, 65536)).rejects.toMatchObject({ code: "artifact_invalid" });
});

test("an oversized stream is cancelled before buffering or parsing its body", async () => {
  let cancelled = false;
  const port = createAssignedArtifactStorage({ get: async () => ({ ...metadata,
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65537)); }, cancel() { cancelled = true; } }),
  }) } as unknown as R2Bucket);
  await expect(port.readJson(artifact, 65536)).rejects.toMatchObject({ code: "artifact_invalid" });
  expect(cancelled).toBe(true);
});
