import { dubbingExecutionInputSchema, type DubbingExecutionInput } from "@narriflow/validators/dubbing-execution";
import { canonicalDubbingJson, frozenDubbingRequestHash } from "./dubbing-policy";
import type { PrivateJsonObject } from "./private-json-storage";
import { sha256Hex } from "./execution-hash";

async function digest(bytes: Uint8Array) {
  return await sha256Hex(new Uint8Array(bytes));
}
export async function dubbingInputBinding(input: Omit<DubbingExecutionInput, "bindingHash">) {
  return digest(new TextEncoder().encode(canonicalDubbingJson(input)));
}
export async function encodeDubbingInput(raw: DubbingExecutionInput) {
  const input = dubbingExecutionInputSchema.parse(raw), { bindingHash, ...value } = input;
  if (input.requestHash !== await frozenDubbingRequestHash(input.request) || bindingHash !== await dubbingInputBinding(value)) throw Error("dubbing_input_invalid");
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  if (bytes.length > 16 * 1024 ** 2) throw Error("dubbing_input_invalid");
  return { input, bytes, byteLength: bytes.length, sha256: await digest(bytes) };
}
export async function decodeDubbingInput(bytes: Uint8Array, object: PrivateJsonObject) {
  if (!bytes.length || bytes.length !== object.byteLength || bytes.length > 16 * 1024 ** 2 || await digest(bytes) !== object.sha256) throw Error("dubbing_input_invalid");
  return (await encodeDubbingInput(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))).input;
}
