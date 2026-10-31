import { createClipSelectionControl } from "@narriflow/services/clip-selection-control";
import { createClipSelectionProvider } from "@narriflow/services/clip-selection-provider";
import type { ClipSelectionStorage, createClipSelectionPreparation } from "@narriflow/services/clip-selection-preparation";
import type { createClipSelectionLifecycle } from "@narriflow/services/clip-selection-window";
import type { ExecutionDispatchReference } from "@narriflow/validators/execution";

export interface SelectionMemoryMetadata { sourceSeconds: number; words: number; utterances: number; inputBytes: number; windows: Array<{ reference: ExecutionDispatchReference; metadata: NonNullable<Awaited<ReturnType<ReturnType<typeof createClipSelectionPreparation>["readWindow"]>>> }> }

/** Only the database authority port is synthetic; the controller and provider serialization are real. */
export function createSelectionMemoryControl(fixture: SelectionMemoryMetadata, storage: ClipSelectionStorage, providerFetch: (init?: RequestInit) => Promise<Response>) {
  let calls = 0;
  const preparation = { async readWindow(reference: ExecutionDispatchReference) { return fixture.windows.find(window => window.reference.dispatchId === reference.dispatchId)?.metadata ?? null; } } as ReturnType<typeof createClipSelectionPreparation>;
  const lifecycle = {
    async admit(reference: ExecutionDispatchReference, invocation: { owner: string }) { const metadata = fixture.windows.find(window => window.reference.dispatchId === reference.dispatchId)!.metadata;
      return { kind: "acquired", attempt: { reference, token: crypto.randomUUID(), owner: invocation.owner }, input: metadata.input, windowIndex: metadata.windowIndex,
        operationDeadlineAt: new Date(Date.now() + 600000), leaseExpiresAt: new Date(Date.now() + 120000), dispatchIds: [] }; },
    async start() { const now = new Date(); return { kind: "started", now, leaseExpiresAt: new Date(now.getTime() + 120000), operationDeadlineAt: new Date(now.getTime() + 600000) }; },
    async complete() { return { kind: "completed", dispatchIds: [] }; },
    async retry() { return { kind: "failed", dispatchIds: [] }; }, async rejectInput() { return { kind: "failed", dispatchIds: [] }; },
  } as unknown as ReturnType<typeof createClipSelectionLifecycle>;
  const control = createClipSelectionControl({ preparation, lifecycle, storage, async deliver() {}, provider: { generate: input => createClipSelectionProvider({ ...input.configuration, apiKey: "synthetic-memory-fixture",
    fetch: async (url, init) => { if (String(url) !== "https://api.openai.com/v1/responses") throw new Error("Unexpected provider endpoint"); calls++; return providerFetch(init); },
  }).generate(input) } });
  return { control, calls: () => calls };
}
