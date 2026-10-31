import type { ClipSelectionInput } from "@narriflow/validators";
import type { ExecutionDispatchReference } from "@narriflow/validators/execution";
import { clipSelectionBytesHash, clipSelectionWindowInputHash, decodeClipSelectionInput, encodeClipSelectionResult } from "./clip-selection-input";
import { buildClipSelectionPlan } from "./clip-selection-plan";
import { CLIP_DETECTION_JSON_SCHEMA } from "./clip-selection-policy";
import type { ClipSelectionProviderResult } from "./clip-selection-provider";
import { writeClipSelectionObject, type ClipSelectionStorage, type createClipSelectionPreparation } from "./clip-selection-preparation";
import { clipSelectionWindowResultKey, type createClipSelectionLifecycle, type ClipSelectionWindowAdmission, type ClipSelectionWindowSettlement } from "./clip-selection-window";
import { WorkflowFailure } from "./workflow-attempt-contract";

export type ClipSelectionControlResult = { kind: "complete"; outcome: "completed" | "failed" | "cancelled" | "superseded" | "retried" } | { kind: "wait"; dueAt: Date };
export interface ClipSelectionControlPorts {
  preparation: ReturnType<typeof createClipSelectionPreparation>;
  lifecycle: ReturnType<typeof createClipSelectionLifecycle>;
  storage: ClipSelectionStorage;
  deliver(dispatchIds: readonly string[]): Promise<void>;
  provider: { generate(input: { configuration: ClipSelectionInput["provider"]; systemPrompt: string; userPrompt: string; operationDeadlineAt: Date; signal?: AbortSignal }): Promise<ClipSelectionProviderResult> };
  observeProvider?(input: { windowId: string; providerRequestId: string | null; rateLimitHeaders: Readonly<Record<string, string>> }): void;
  now?: () => Date;
}

/** Workflow steps receive only these metadata dispositions, never private input or model text. */
export function createClipSelectionControl(ports: ClipSelectionControlPorts) {
  const now = ports.now ?? (() => new Date());
  const responseSchemaHash = clipSelectionBytesHash(new TextEncoder().encode(JSON.stringify(CLIP_DETECTION_JSON_SCHEMA)));
  async function disposition(result: ClipSelectionWindowAdmission | ClipSelectionWindowSettlement): Promise<ClipSelectionControlResult> {
    if (result.dispatchIds.length) await ports.deliver(result.dispatchIds);
    if (result.kind === "acquired") throw new Error("An acquired owner requires a fresh start command");
    return result.kind === "wait" ? { kind: "wait", dueAt: result.dueAt } : { kind: "complete", outcome: result.kind };
  }
  return {
    async prepare(reference: ExecutionDispatchReference) {
      const prepared = await ports.preparation.prepare(reference);
      if (prepared.dispatchIds.length) await ports.deliver(prepared.dispatchIds);
      const { dispatchIds: _delivered, ...metadata } = prepared;
      return metadata;
    },
    async runWindow(reference: ExecutionDispatchReference, options: { signal?: AbortSignal } = {}): Promise<ClipSelectionControlResult> {
      options.signal?.throwIfAborted();
      const metadata = await ports.preparation.readWindow(reference);
      if (!metadata) return disposition(await ports.lifecycle.expire(reference));
      if (metadata.status !== "queued") return disposition(await ports.lifecycle.admit(reference, { owner: crypto.randomUUID() }));
      let bytes: Uint8Array;
      try { bytes = await ports.storage.read(metadata.input); }
      catch { throw new WorkflowFailure("selection_input_unavailable", "retryable", "The private selection input is unavailable"); }
      let capsule: ClipSelectionInput, userPrompt: string;
      try {
        capsule = await decodeClipSelectionInput(bytes, metadata.input, metadata.parent);
        if (metadata.selectionHash !== metadata.input.sha256 || capsule.responseSchemaHash !== await responseSchemaHash) throw new Error("Selection contract mismatch");
        const plan = buildClipSelectionPlan(capsule.planning);
        const window = plan.kind === "selection" ? plan.windows[metadata.windowIndex] : null;
        if (!window?.userPrompt || window.startSec !== metadata.startSec || window.endSec !== metadata.endSec || await clipSelectionWindowInputHash({ selectionHash: metadata.selectionHash,
          windowIndex: metadata.windowIndex, startSec: metadata.startSec, endSec: metadata.endSec }) !== reference.inputHash) throw new Error("Selection window mismatch");
        userPrompt = window.userPrompt;
      } catch { return disposition(await ports.lifecycle.rejectInput(reference)); }
      options.signal?.throwIfAborted();
      const admission = await ports.lifecycle.admit(reference, { owner: crypto.randomUUID() });
      if (admission.kind !== "acquired") return disposition(admission);
      // Confirmation failure leaves an uncharged live reservation. Its registered
      // lease observation, replay or absolute deadline can revoke it durably.
      if (admission.dispatchIds.length) await ports.deliver(admission.dispatchIds);
      options.signal?.throwIfAborted();
      const started = await ports.lifecycle.start(admission.attempt);
      if (started.kind === "superseded") return disposition(await ports.lifecycle.expire(reference));
      if (started.kind === "already_started") return { kind: "wait", dueAt: started.leaseExpiresAt };
      let settlement: ClipSelectionWindowSettlement;
      try {
        const remaining = Math.min(started.leaseExpiresAt.getTime(), started.operationDeadlineAt.getTime()) - started.now.getTime();
        const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(Math.max(1, Math.min(90_000, remaining)))]);
        const result = await ports.provider.generate({ configuration: capsule.provider, systemPrompt: capsule.systemPrompt, userPrompt,
          operationDeadlineAt: new Date(Math.min(started.leaseExpiresAt.getTime(), started.operationDeadlineAt.getTime())), signal });
        try { ports.observeProvider?.({ windowId: reference.subject.id, providerRequestId: result.providerRequestId, rateLimitHeaders: result.rateLimitHeaders }); } catch { /* Diagnostics cannot change a valid result. */ }
        if (result.kind === "retry") settlement = await ports.lifecycle.retry(admission.attempt, { code: result.code, dueAt: result.dueAt });
        else {
          const encoded = await encodeClipSelectionResult({ parentId: metadata.parent.id, parentGeneration: metadata.parent.generation, selectionHash: metadata.selectionHash, windowIndex: metadata.windowIndex }, result.content, result);
          const stored = await writeClipSelectionObject(ports.storage, clipSelectionWindowResultKey(admission.attempt, encoded.sha256), encoded);
          settlement = await ports.lifecycle.complete(admission.attempt, { ...stored, tokensUsed: result.tokensUsed, providerRequestId: result.providerRequestId });
        }
      } catch (error) {
        const failure = error instanceof WorkflowFailure ? error : new WorkflowFailure("selection_execution_failed", "retryable", "Selection could not be completed");
        settlement = await ports.lifecycle.retry(admission.attempt, { code: failure.code,
          ...(failure.disposition === "retryable" ? { dueAt: new Date(now().getTime() + 30_000) } : {}) });
      }
      return disposition(settlement);
    },
  };
}
