import { renderVariantFailureSchema, type RenderVariantFailure } from "@narriflow/validators/render-execution";
import type { ExecutionArtifact } from "@narriflow/validators/execution";
import type { ExecutorArtifactCommit } from "./executor-domain-control";
import type { RenderGroupArtifactCommit } from "./render-group-lifecycle";

async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes))), byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function renderArtifactBindingHash(input: { inputHash: string; renderId: string; role: "render_variant" | "render_outcome" }): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(input.inputHash) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.renderId) || !["render_variant", "render_outcome"].includes(input.role)) throw new Error("render_artifact_invalid");
  return digest(new TextEncoder().encode(JSON.stringify({ version: 1, kind: "render_artifact", role: input.role, renderId: input.renderId, inputHash: input.inputHash })));
}
export async function encodeRenderVariantFailure(raw: RenderVariantFailure) {
  const failure = renderVariantFailureSchema.parse(raw);
  const bytes = new TextEncoder().encode(JSON.stringify(failure));
  if (bytes.byteLength === 0 || bytes.byteLength > 65536) throw new Error("render_artifact_invalid");
  return { bytes, byteLength: bytes.byteLength, sha256: await digest(bytes), failure };
}
export async function decodeRenderVariantFailure(bytes: Uint8Array, reference: { byteLength: number; sha256: string }): Promise<RenderVariantFailure> {
  if (bytes.byteLength === 0 || bytes.byteLength > 65536 || bytes.byteLength !== reference.byteLength || await digest(bytes) !== reference.sha256) throw new Error("render_artifact_invalid");
  try { return renderVariantFailureSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
  catch { throw new Error("render_artifact_invalid"); }
}

/** Runs before SQL locks. Only an assigned exact-key reader may supply failure evidence. */
export async function prepareRenderArtifact(artifact: ExecutorArtifactCommit, reported: ExecutionArtifact, input: {
  inputHash: string; memberIds: readonly string[];
  read(reference: { storageKey: string; etag: string; byteLength: number; sha256: string }, maxBytes: number): Promise<Uint8Array>;
}): Promise<RenderGroupArtifactCommit> {
  const invalid = () => new Error("render_artifact_invalid");
  if (artifact.role === "render_variant") {
    const facts = reported.renderVariant;
    if (!facts || artifact.contentType !== "video/mp4" || !input.memberIds.includes(facts.renderId) ||
      artifact.bindingHash !== await renderArtifactBindingHash({ inputHash: input.inputHash, renderId: facts.renderId, role: artifact.role })) throw invalid();
    return { ...artifact, role: artifact.role, ...facts };
  }
  if (artifact.role !== "render_outcome" || artifact.contentType !== "application/json" || artifact.byteLength <= 0n || artifact.byteLength > 65536n) throw invalid();
  const reference = { storageKey: artifact.storageKey, etag: artifact.etag, byteLength: Number(artifact.byteLength), sha256: artifact.sha256 };
  const failure = await decodeRenderVariantFailure(await input.read(reference, 65536), reference);
  if (!input.memberIds.includes(failure.renderId) || failure.bindingHash !== artifact.bindingHash ||
    artifact.bindingHash !== await renderArtifactBindingHash({ inputHash: input.inputHash, renderId: failure.renderId, role: artifact.role })) throw invalid();
  return { ...artifact, role: artifact.role, renderId: failure.renderId, failure };
}
