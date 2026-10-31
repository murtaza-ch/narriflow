import { expect,test } from "bun:test";
import { exportBundleInputBinding,encodeExportBundleInput,decodeExportBundleInput } from "./export-bundle-input";
import type { ExportBundleExecutionInput } from "@narriflow/validators/export-bundle-execution";

function fixture():Omit<ExportBundleExecutionInput,"bindingHash"> {
  const variantId=crypto.randomUUID();
  return {version:1,kind:"export_bundle",bundleId:crypto.randomUUID(),workflowRunId:crypto.randomUUID(),toolchainFingerprint:"a".repeat(64),
    manifest:{schemaVersion:1,operationId:crypto.randomUUID(),projectId:crypto.randomUUID(),createdAt:"2026-10-31T00:00:00Z",excluded:[],
      included:[{clipId:crypto.randomUUID(),exportId:crypto.randomUUID(),editorRevision:1,files:[{variantId,aspectRatio:"9:16",name:"project/001-first/9x16.mp4",sizeBytes:3}]}]},
    sources:[{name:`variant_${variantId.replaceAll("-","")}`,variantId,object:{storageKey:"projects/frozen/export.mp4",etag:'"frozen"',byteLength:3}}]};
}

test("bundle binding ignores object key enumeration order while retaining exact frozen source identity",async()=>{
  const input=fixture(),reordered=Object.fromEntries(Object.entries(input).reverse()) as typeof input;
  expect(await exportBundleInputBinding(reordered)).toBe(await exportBundleInputBinding(input));
  expect(await exportBundleInputBinding({...input,sources:input.sources.map(source=>({...source,object:{...source.object,etag:'"changed"'}}))})).not.toBe(await exportBundleInputBinding(input));
});

test("the private capsule verifies its raw digest separately from its semantic binding",async()=>{
  const input=fixture(),encoded=await encodeExportBundleInput({...input,bindingHash:await exportBundleInputBinding(input)});
  const object={storageKey:"projects/frozen/bundle.json",etag:'"input"',byteLength:encoded.byteLength,sha256:encoded.sha256};
  expect(await decodeExportBundleInput(encoded.bytes,object)).toEqual(encoded.input);
  const changed=encoded.bytes.slice();changed[20]^=1;
  await expect(decodeExportBundleInput(changed,object)).rejects.toThrow("export_bundle_input_invalid");
});
