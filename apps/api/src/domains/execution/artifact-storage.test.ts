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

test("only assigned outbound receipts may use the bounded four MiB JSON reader", async () => {
  const largeBytes = new TextEncoder().encode(JSON.stringify({ title: "r".repeat(70000) }));
  const largeHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", largeBytes)), byte => byte.toString(16).padStart(2,"0")).join("");
  const port = createAssignedArtifactStorage({ get: async () => ({ ...metadata, size: largeBytes.length, body: new Blob([largeBytes]).stream() }) } as unknown as R2Bucket);
  const receipt = { ...artifact, role: "outbound_receipt" as const, byteLength: BigInt(largeBytes.length), sha256: largeHash };
  expect((await port.readJson(receipt, 4194304) as { title: string }).title.length).toBe(70000);
  await expect(port.readJson({ ...receipt, role: "probe" }, 4194304)).rejects.toMatchObject({ code: "artifact_invalid" });
  await expect(port.readJson(receipt, 4194305)).rejects.toMatchObject({ code: "artifact_invalid" });
});

test("layout evidence may carry the bounded one MiB preparation manifest", async () => {
  const data = new TextEncoder().encode(JSON.stringify({ observations: "e".repeat(100000) }));
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), byte => byte.toString(16).padStart(2,"0")).join("");
  const port = createAssignedArtifactStorage({ get: async () => ({ ...metadata, size: data.length, body: new Blob([data]).stream() }) } as unknown as R2Bucket);
  const manifest = { ...artifact, role: "layout_evidence" as const, byteLength: BigInt(data.length), sha256: digest };
  expect((await port.readJson(manifest, 1048576) as { observations: string }).observations.length).toBe(100000);
  await expect(port.readJson(manifest, 1048577)).rejects.toMatchObject({ code: "artifact_invalid" });
  await expect(port.readJson({ ...manifest, role: "probe" }, 1048576)).rejects.toMatchObject({ code: "artifact_invalid" });
});

test("only assigned encrypted publication instruction blobs receive the sixteen MiB binary reader",async()=>{
 const data=new Uint8Array(100000).fill(7),digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",data)),b=>b.toString(16).padStart(2,"0")).join("");
 let reads=0;
 const port=createAssignedArtifactStorage({get:async()=>{reads++;return {...metadata,size:data.length,httpMetadata:{contentType:"application/octet-stream"},body:new Blob([data]).stream()};}} as unknown as R2Bucket);
 const blob={...artifact,role:"publication_checkpoint" as const,byteLength:BigInt(data.length),contentType:"application/octet-stream",sha256:digest};
 expect(await port.readBytes(blob,16*1024**2)).toEqual(data);
 await expect(port.readBytes({...blob,role:"probe"},16*1024**2)).rejects.toMatchObject({code:"artifact_invalid"});
 await expect(port.readBytes(blob,16*1024**2+1)).rejects.toMatchObject({code:"artifact_invalid"});expect(reads).toBe(1);
 await expect(port.readBytes({...blob,sha256:"f".repeat(64)},16*1024**2)).rejects.toMatchObject({code:"artifact_invalid"});
});
