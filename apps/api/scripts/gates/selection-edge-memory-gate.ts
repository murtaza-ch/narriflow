import type { ClipSelectionStorage } from "@narriflow/services/clip-selection-preparation";
import { encodeClipSelectionInput, clipSelectionWindowInputHash } from "@narriflow/services/clip-selection-input";
import { buildClipSelectionPlan } from "@narriflow/services/clip-selection-plan";
import { writeClipSelectionObject } from "@narriflow/services/clip-selection-preparation";
import { createSyntheticSelectionCapsule, syntheticSelectionProviderReply } from "./selection-fixture";
import { createSelectionMemoryControl, type SelectionMemoryMetadata } from "./selection-memory-control";

/** One real isolate invocation holds all six windows. No real provider is contacted. */
export async function runSelectionEdgeMemoryGate(storage: ClipSelectionStorage, remove: (keys: readonly string[]) => Promise<void>) {
  const capsule = await createSyntheticSelectionCapsule(), input = await encodeClipSelectionInput(capsule), plan = buildClipSelectionPlan(capsule.planning);
  if (plan.kind !== "selection" || plan.windows.length !== 6) throw new Error("selection_edge_gate_fixture_invalid");
  const keys = new Set<string>(), inputKey = `projects/${capsule.parent.projectId}/selection/${capsule.parent.id}/${input.sha256}.json`;
  const tracked: ClipSelectionStorage = { read: reference => storage.read(reference), async write(key, bytes) { keys.add(key); return storage.write(key, bytes); } };
  try {
    const stored = await writeClipSelectionObject(tracked, inputKey, input);
    const windows = await Promise.all(plan.windows.map(async window => ({ reference: { dispatchId: crypto.randomUUID(), deploymentEpoch: capsule.parent.deploymentEpoch, generation: 1,
      kind: "operation_driver" as const, subject: { kind: "clip_selection_window" as const, id: crypto.randomUUID() }, inputHash: await clipSelectionWindowInputHash({ selectionHash: input.sha256, windowIndex: window.windowIndex, startSec: window.startSec, endSec: window.endSec }) },
      metadata: { parent: capsule.parent, status: "queued", selectionHash: input.sha256, windowIndex: window.windowIndex, startSec: window.startSec, endSec: window.endSec, input: stored } })));
    console.warn(JSON.stringify({ level: "info", message: "selection_edge_gate_fixture", projectId: capsule.parent.projectId, parentId: capsule.parent.id, inputSha256: input.sha256, windowIds: windows.map(window => window.reference.subject.id) }));
    const fixture: SelectionMemoryMetadata = { sourceSeconds: 10800, words: 28800, utterances: 960, inputBytes: input.byteLength, windows };
    const reply = syntheticSelectionProviderReply();
    const execution = createSelectionMemoryControl(fixture, tracked, async init => {
      await new Promise(resolve => setTimeout(resolve, 10000)); init?.signal?.throwIfAborted();
      return new Response(reply, { headers: { "content-type": "application/json", "x-request-id": "synthetic-edge-memory-provider" } });
    });
    const started = performance.now();
    const outcomes = await Promise.all(windows.map(window => execution.control.runWindow(window.reference)));
    if (execution.calls() !== 6 || outcomes.some(outcome => outcome.kind !== "complete" || outcome.outcome !== "completed") || keys.size !== 7) throw new Error("selection_edge_gate_execution_failed");
    return { passed: true, oneIsolateInvocation: true, sourceSeconds: 10800, words: 28800, utterances: 960, privateInputBytes: input.byteLength, windows: 6, concurrentProviderWaits: 6,
      syntheticProviderHoldMs: 10000, wallMs: Math.round(performance.now() - started), domainDatabasePortsSynthetic: true, realSelectionStorageInjected: true, externalProviderRequests: 0, objectsRemoved: keys.size, completedAt: new Date().toISOString() };
  } finally { await remove([...keys]); }
}
