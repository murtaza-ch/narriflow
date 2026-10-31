import type { ExecutionArtifact } from "@prisma/client";
import type { ExecutorArtifactCommit } from "@narriflow/services/executor-domain-control";
import { createAssignedArtifactStorage } from "../../src/domains/execution/artifact-storage";

export default {
  async fetch(_request: Request, env: { MEDIA_BUCKET: R2Bucket }) {
    const assignment = { id: crypto.randomUUID(), storageKey: `execution/platform-gates/${crypto.randomUUID()}`, bindingHash: "a".repeat(64) } as ExecutionArtifact;
    const bytes = new TextEncoder().encode('{"measured":true}');
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    await env.MEDIA_BUCKET.put(assignment.storageKey, bytes, { sha256: digest,
      httpMetadata: { contentType: "application/json" }, customMetadata: { "execution-artifact-id": assignment.id, "execution-binding-hash": assignment.bindingHash } });
    const port = createAssignedArtifactStorage(env.MEDIA_BUCKET);
    const head = await port.head(assignment);
    if (!head || head.sha256 !== sha256 || head.byteLength !== BigInt(bytes.byteLength)) throw new Error("assigned_head_mismatch");
    const artifact: ExecutorArtifactCommit = { artifactId: assignment.id, role: "probe", storageKey: assignment.storageKey,
      bindingHash: assignment.bindingHash, contentType: "application/json", byteLength: head.byteLength, etag: head.etag, sha256 };
    if (JSON.stringify(await port.readJson(artifact, 65536)) !== '{"measured":true}') throw new Error("assigned_json_mismatch");
    let refused = false;
    try { await port.readJson({ ...artifact, etag: '"replaced"' }, 65536); }
    catch (error) { refused = error instanceof Error && error.message === "artifact_invalid"; }
    if (!refused) throw new Error("assigned_etag_not_enforced");
    await env.MEDIA_BUCKET.delete(assignment.storageKey);
    return Response.json({ passed: 3, runtime: "workerd", checks: ["assigned_metadata_and_sha256", "conditional_bounded_json", "changed_etag_refused"] });
  },
};
