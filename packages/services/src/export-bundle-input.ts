import { exportBundleExecutionInputSchema, type ExportBundleExecutionInput } from "@narriflow/validators/export-bundle-execution";
import type { PrivateJsonObject } from "./private-json-storage";
import { sha256Hex } from "./execution-hash";
import { canonicalJson } from "./canonical-json";

const digest=async(bytes:Uint8Array)=>await sha256Hex(new Uint8Array(bytes));
export async function exportBundleInputBinding(input:Omit<ExportBundleExecutionInput,"bindingHash">) {
  return digest(new TextEncoder().encode(canonicalJson(input)));
}
export async function encodeExportBundleInput(raw:ExportBundleExecutionInput) {
  const input=exportBundleExecutionInputSchema.parse(raw),{bindingHash,...value}=input;
  if(bindingHash!==await exportBundleInputBinding(value))throw Error("export_bundle_input_invalid");
  const bytes=new TextEncoder().encode(JSON.stringify(input));
  if(bytes.byteLength>16*1024**2)throw Error("export_bundle_input_invalid");
  return {input,bytes,byteLength:bytes.byteLength,sha256:await digest(bytes)};
}
export async function decodeExportBundleInput(bytes:Uint8Array,object:PrivateJsonObject) {
  if(bytes.byteLength!==object.byteLength || bytes.byteLength>16*1024**2 || await digest(bytes)!==object.sha256)throw Error("export_bundle_input_invalid");
  return (await encodeExportBundleInput(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)))).input;
}
