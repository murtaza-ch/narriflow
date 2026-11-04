import { renderExecutionInputSchema, type RenderExecutionInput } from "@narriflow/validators/render-execution";
import type { ClipPreparationObject } from "@narriflow/validators/clip-preparation";
import { encodeClipPreparationInput } from "./clip-preparation-input";
import { clipPreparationEngineHash } from "./clip-preparation-policy";
import { sha256Hex } from "./execution-hash";
import { canonicalJson } from "./canonical-json";

async function digest(bytes: Uint8Array) {
  return await sha256Hex(Uint8Array.from(bytes));
}
export async function encodeRenderExecutionInput(raw: RenderExecutionInput) {
  const input = renderExecutionInputSchema.parse(raw);
  await encodeClipPreparationInput(input.preparation);
  if (input.preparation.engineHash !== await clipPreparationEngineHash(input.preparation.toolchainFingerprint)) throw new Error("render_input_invalid");
  const bytes = new TextEncoder().encode(canonicalJson(input));
  if (bytes.byteLength === 0 || bytes.byteLength > 16 * 1024 ** 2) throw new Error("render_input_invalid");
  return { input, bytes, byteLength: bytes.byteLength, sha256: await digest(bytes) };
}
export async function decodeRenderExecutionInput(bytes: Uint8Array, reference: ClipPreparationObject) {
  if (bytes.byteLength === 0 || bytes.byteLength > 16 * 1024 ** 2 || bytes.byteLength !== reference.byteLength || await digest(bytes) !== reference.sha256) throw new Error("render_input_invalid");
  try { return (await encodeRenderExecutionInput(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))).input; }
  catch { throw new Error("render_input_invalid"); }
}
