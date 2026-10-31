import { clipSelectionInputSchema, clipSelectionResultSchema, clipDetectionLlmResponseSchema, type ClipSelectionInput, type ClipSelectionParent, type ClipSelectionResultBinding } from "@narriflow/validators";

/** Keys are sorted so JSONB's object order cannot change immutable byte identity. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonical(item ?? null)).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export async function clipSelectionBytesHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function encode(value: unknown, maximum: number) {
  const bytes = new TextEncoder().encode(canonical(value));
  if (!bytes.byteLength || bytes.byteLength > maximum) throw new Error("Selection object byte limit exceeded");
  return { bytes, sha256: await clipSelectionBytesHash(bytes), byteLength: bytes.byteLength };
}
async function decode(bytes: Uint8Array, reference: { sha256: string; byteLength: number }, maximum: number): Promise<unknown> {
  if (!bytes.byteLength || bytes.byteLength > maximum || bytes.byteLength !== reference.byteLength || await clipSelectionBytesHash(bytes) !== reference.sha256) throw new Error("Selection object checksum mismatch");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
export function encodeClipSelectionInput(input: ClipSelectionInput) { return encode(clipSelectionInputSchema.parse(input), 16_777_216); }
export async function decodeClipSelectionInput(bytes: Uint8Array, reference: { sha256: string; byteLength: number }, parent: ClipSelectionParent): Promise<ClipSelectionInput> {
  const value = clipSelectionInputSchema.parse(await decode(bytes, reference, 16_777_216));
  if (value.parent.id !== parent.id || value.parent.projectId !== parent.projectId || value.parent.generation !== parent.generation || value.parent.deploymentEpoch !== parent.deploymentEpoch || value.parent.inputHash !== parent.inputHash) throw new Error("Selection input lineage mismatch");
  return value;
}
export async function clipSelectionWindowInputHash(input: { selectionHash: string; windowIndex: number; startSec: number; endSec: number }): Promise<string> {
  return clipSelectionBytesHash(new TextEncoder().encode(canonical(input)));
}

/** Preserve the detector's individual-clip salvage and lenient raw cue contract. */
export async function encodeClipSelectionResult(binding: ClipSelectionResultBinding, content: string, metadata: { tokensUsed: number; providerRequestId: string | null }) {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error("Selection provider result is not JSON"); }
  const complete = clipDetectionLlmResponseSchema.safeParse(parsed);
  let clips = complete.success ? complete.data.clips : [];
  if (!complete.success && parsed && typeof parsed === "object" && "clips" in parsed && Array.isArray(parsed.clips)) clips = parsed.clips.flatMap(raw => {
    const clip = clipDetectionLlmResponseSchema.shape.clips.element.safeParse(raw);
    return clip.success ? [clip.data] : [];
  });
  return encode(clipSelectionResultSchema.parse({ version: 1, ...binding, tokensUsed: metadata.tokensUsed, providerRequestId: metadata.providerRequestId, clips }), 1_048_576);
}
export async function decodeClipSelectionResult(bytes: Uint8Array, reference: { sha256: string; byteLength: number }, binding: ClipSelectionResultBinding) {
  const value = clipSelectionResultSchema.parse(await decode(bytes, reference, 1_048_576));
  if (value.parentId !== binding.parentId || value.parentGeneration !== binding.parentGeneration || value.selectionHash !== binding.selectionHash || value.windowIndex !== binding.windowIndex) throw new Error("Selection result lineage mismatch");
  return value;
}
