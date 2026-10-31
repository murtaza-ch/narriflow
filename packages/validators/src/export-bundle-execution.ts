import { z } from "zod";
import { exportBundleManifestSchema, MAX_EXPORT_BUNDLE_INPUT_BYTES, CAMPAIGN_SELECTION_LIMIT } from "./campaign-operation";

const sha256=z.string().regex(/^[a-f0-9]{64}$/);
export const EXPORT_BUNDLE_OUTPUT_MAX_BYTES=MAX_EXPORT_BUNDLE_INPUT_BYTES+64*1024**2;
export const exportBundleExecutionInputSchema=z.strictObject({
  version:z.literal(1),kind:z.literal("export_bundle"),bundleId:z.string().uuid(),workflowRunId:z.string().uuid(),bindingHash:sha256,toolchainFingerprint:sha256,
  manifest:exportBundleManifestSchema,
  sources:z.array(z.strictObject({name:z.string().regex(/^variant_[a-f0-9]{32}$/),variantId:z.string().uuid(),object:z.strictObject({
    storageKey:z.string().min(1).max(1024),etag:z.string().max(160).regex(/^"[^\r\n"]+"$/),byteLength:z.number().int().positive().safe().max(MAX_EXPORT_BUNDLE_INPUT_BYTES),sha256:sha256.optional(),
  })})).min(1).max(CAMPAIGN_SELECTION_LIMIT*4),
}).superRefine((input,context)=>{
  const entries=input.manifest.included.flatMap(item=>item.files);
  if(input.manifest.included.length>CAMPAIGN_SELECTION_LIMIT || input.manifest.included.some(item=>!item.files.length||item.files.length>4) ||
    entries.length!==input.sources.length || new Set(entries.map(entry=>entry.variantId)).size!==entries.length || new Set(entries.map(entry=>entry.name)).size!==entries.length ||
    new Set(input.sources.map(source=>source.variantId)).size!==input.sources.length || input.sources.some(source=>source.name!==`variant_${source.variantId.replaceAll("-","")}` || !entries.some(entry=>entry.variantId===source.variantId&&entry.sizeBytes===source.object.byteLength))) {
    context.addIssue({code:"custom",path:["sources"],message:"Bundle sources must match the frozen manifest exactly"});
  }
});
export type ExportBundleExecutionInput=z.infer<typeof exportBundleExecutionInputSchema>;
