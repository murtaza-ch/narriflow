import { exportBundleExecutionInputSchema, type ExportBundleExecutionInput } from "@narriflow/validators/export-bundle-execution";
import type { PrivateJsonObject } from "./private-json-storage";

const digest=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new Uint8Array(bytes))),value=>value.toString(16).padStart(2,"0")).join("");
function canonical(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonical).join(",")}]`;
  if(value!==null&&typeof value==="object")return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(Reflect.get(value,key))}`).join(",")}}`;
  return JSON.stringify(value);
}
export async function exportBundleInputBinding(input:Omit<ExportBundleExecutionInput,"bindingHash">) {
  return digest(new TextEncoder().encode(canonical(input)));
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
