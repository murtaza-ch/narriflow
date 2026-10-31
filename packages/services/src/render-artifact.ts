import { renderVariantFailureSchema, type RenderVariantFailure } from "@narriflow/validators/render-execution";

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
