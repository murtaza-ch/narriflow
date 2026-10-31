import { productionRenderDiagnosticAdapter } from "../render-diagnostic-adapter";
import { createNativeRenderAdapters, type NativeRenderAdapterOverrides } from "../render-media-adapters";
import { ClipRenderAttempt, type ClipRenderAttemptAdapters, type ClipRenderAttemptDependencies } from "./clip-render-attempt";
import type { ResolveBrollCutaways } from "./broll";

/** Reads and writes cross the signed control boundary. There is no database or storage-account fallback. */
export type ClipRenderControlPorts = Pick<ClipRenderAttemptAdapters,
 "state" | "layoutEvidence" | "clip" | "audioAsset" | "assets" | "storage"> & {
 resolveBrollCutaways: ResolveBrollCutaways;
};

export interface ClipRenderAttemptRuntimeOptions extends Omit<ClipRenderAttemptDependencies, "adapters"> {
 ports: ClipRenderControlPorts;
 adapters?: NativeRenderAdapterOverrides;
}

export function createClipRenderAttempt(input: ClipRenderAttemptRuntimeOptions): ClipRenderAttempt {
 return new ClipRenderAttempt({
  ...input,
  adapters: (signal, decorate) => {
   const overrides = input.adapters;
   const native = createNativeRenderAdapters({
    config: input.config, signal,
    diagnose: decorate(overrides?.diagnose ?? productionRenderDiagnosticAdapter.diagnose),
    resolveBrollCutaways: input.ports.resolveBrollCutaways,
    overrides,
   });
   return {
    ...input.ports, ...overrides, ...native,
    clip: { ...input.ports.clip, ...overrides?.clip },
    storage: { ...input.ports.storage, ...overrides?.storage },
   };
  },
 });
}
