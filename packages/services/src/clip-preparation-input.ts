import { clipPreparationResultSchema, type ClipPreparationResult, clipPreparationInputSchema, type ClipPreparationInput, type ClipPreparationObject } from "@narriflow/validators/clip-preparation";
import { sha256Hex } from "./execution-hash";
import { canonicalJson } from "./canonical-json";

const MAX_INPUT_BYTES = 16 * 1024 * 1024;
async function sha256(bytes: Uint8Array): Promise<string> {
  return await sha256Hex(Uint8Array.from(bytes));
}
export async function clipPreparationBinding(input: Omit<ClipPreparationInput, "bindingHash">): Promise<string> {
  const { preparationId: _id, bindingHash: _binding, ...raw } = input as ClipPreparationInput;
  const fields = clipPreparationInputSchema.omit({ preparationId: true, bindingHash: true }).parse(raw);
  return sha256(new TextEncoder().encode(canonicalJson(fields)));
}
export async function encodeClipPreparationInput(raw: ClipPreparationInput) {
  const input = clipPreparationInputSchema.parse(raw);
  if (input.bindingHash !== await clipPreparationBinding(input)) throw new Error("clip_preparation_binding_invalid");
  if (input.document.clipEndSec > input.sourceProbe.durationSec + 0.001) throw new Error("clip_preparation_binding_invalid");
  const bytes = new TextEncoder().encode(canonicalJson(input));
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_INPUT_BYTES) throw new Error("clip_preparation_input_invalid");
  return { bytes, byteLength: bytes.byteLength, sha256: await sha256(bytes), input };
}
export async function decodeClipPreparationInput(bytes: Uint8Array, reference: ClipPreparationObject): Promise<ClipPreparationInput> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_INPUT_BYTES || bytes.byteLength !== reference.byteLength || await sha256(bytes) !== reference.sha256) throw new Error("clip_preparation_input_invalid");
  try { return (await encodeClipPreparationInput(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))).input; }
  catch { throw new Error("clip_preparation_input_invalid"); }
}

export async function encodeClipPreparationResult(raw: ClipPreparationResult) {
  const result = clipPreparationResultSchema.parse(raw);
  const bytes = new TextEncoder().encode(canonicalJson(result));
  if (bytes.byteLength === 0 || bytes.byteLength > 1024 * 1024) throw new Error("clip_preparation_result_invalid");
  return { bytes, byteLength: bytes.byteLength, sha256: await sha256(bytes), result };
}
export async function decodeClipPreparationResult(bytes: Uint8Array, reference: ClipPreparationObject): Promise<ClipPreparationResult> {
  if (bytes.byteLength === 0 || bytes.byteLength > 1024 * 1024 || bytes.byteLength !== reference.byteLength || await sha256(bytes) !== reference.sha256) throw new Error("clip_preparation_result_invalid");
  try { return (await encodeClipPreparationResult(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))).result; }
  catch { throw new Error("clip_preparation_result_invalid"); }
}
