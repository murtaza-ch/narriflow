import type { ClipSelectionWindow, Prisma, PrismaClient } from "@prisma/client";
import { parseStoredContentPack, sourceProbeSchema, transcriptUtteranceSchema, type ClipSelectionInput, type ClipSelectionParent } from "@narriflow/validators";
import type { ExecutionDispatchReference } from "@narriflow/validators/execution";
import { appendExecutionDispatch } from "./execution-dispatch";
import { prepareDetectedClipSeed } from "./clip-detection-persistence";
import { clipSelectionBytesHash, clipSelectionWindowInputHash, encodeClipSelectionInput, encodeClipSelectionResult } from "./clip-selection-input";
import { buildClipSelectionPlan } from "./clip-selection-plan";
import { CLIP_DETECTION_JSON_SCHEMA, SYSTEM_PROMPT } from "./clip-selection-policy";
import { clipSelectionTranscriptHash, lockClipSelectionParent, lockClipSelectionWindow, registerClipSelectionWindow, type ClipSelectionObjectReference } from "./clip-selection-window";
import { WorkflowFailure } from "./workflow-attempt-contract";
import type { ClipSelectionFinalizationProof } from "./clip-selection-finalization";

type Tx = Prisma.TransactionClient;
export interface ClipSelectionStorage {
  /** Return measured HEAD metadata after writing the exact bytes to this private key. */
  write(storageKey: string, bytes: Uint8Array): Promise<{ etag: string; byteLength: number; sha256: string }>;
  /** If-Match and a bounded body read are required. The codec rechecks SHA and length. */
  read(reference: ClipSelectionObjectReference): Promise<Uint8Array>;
}
export type ClipSelectionPreparation = { kind: "prepared"; windowCount: number; windows: ExecutionDispatchReference[]; dispatchIds: string[] }
  | { kind: "completed" | "failed" | "cancelled" | "superseded"; dispatchIds: string[] };

async function confirmWrite(storage: ClipSelectionStorage, storageKey: string, object: { bytes: Uint8Array; sha256: string; byteLength: number }): Promise<ClipSelectionObjectReference> {
  const measured = await storage.write(storageKey, object.bytes);
  if (!/^"[^\r\n"]+"$/.test(measured.etag) || measured.sha256 !== object.sha256 || measured.byteLength !== object.byteLength) throw new Error("Selection storage proof mismatch");
  return { storageKey, etag: measured.etag, sha256: object.sha256, byteLength: object.byteLength };
}
export { confirmWrite as writeClipSelectionObject };

export function createClipSelectionPreparation(config: { database: PrismaClient; storage: ClipSelectionStorage; provider: ClipSelectionInput["provider"]; guidance?: { promptLine(workspaceId: string): Promise<string | null> } }) {
  const transaction = <T>(body: (tx: Tx) => Promise<T>) => config.database.$transaction(body, { maxWait: 10_000, timeout: 30_000 });
  const responseSchemaHash = clipSelectionBytesHash(new TextEncoder().encode(JSON.stringify(CLIP_DETECTION_JSON_SCHEMA)));
  async function capsule(state: NonNullable<Awaited<ReturnType<typeof lockClipSelectionParent>>>, parentReference: ExecutionDispatchReference, audienceDataLine: string | null): Promise<ClipSelectionInput> {
    if (!state.run.contentPack || state.run.contentPack.draft) throw new WorkflowFailure("workflow_content_pack_invalid", "permanent", "Selection requires its committed Content Pack");
    const pack = parseStoredContentPack(state.run.contentPack), transcript = state.transcript;
    const probe = sourceProbeSchema.safeParse(state.project.sourceProbe);
    return { version: 1, parent: { id: state.run.id, projectId: state.project.id, generation: state.run.generation, deploymentEpoch: state.run.deploymentEpoch, inputHash: parentReference.inputHash },
      transcript: { id: transcript.id, generation: transcript.selectionGeneration, attemptId: transcript.workflowAttemptId, contentHash: await clipSelectionTranscriptHash(transcript),
        sourceRevision: transcript.sourceRevision, sourceAudioId: transcript.sourceAudioId, sourceAudioBindingHash: transcript.sourceAudio?.bindingHash ?? null },
      planning: { projectTitle: state.project.title, contentPack: pack, sourceDurationSec: (state.project.sourceDurationSeconds ?? transcript.durationSeconds) || null,
        sourceProbeDurationSec: probe.success ? probe.data.durationSec : null, utterances: transcriptUtteranceSchema.array().parse(transcript.utterancesJson ?? []), fullText: transcript.text ?? "",
        speakerCount: transcript.speakerCount, sourceLanguageCode: transcript.languageCode, audienceDataLine },
      editor: prepareDetectedClipSeed(state.project, pack), provider: config.provider, systemPrompt: SYSTEM_PROMPT, responseSchemaHash: await responseSchemaHash };
  }
  async function register(tx: Tx, rows: ClipSelectionWindow[]): Promise<ClipSelectionPreparation> {
    if (!rows.length || rows.length !== rows[0]!.windowCount || rows.some((row, index) => row.windowIndex !== index || row.selectionHash !== rows[0]!.selectionHash || row.inputStorageKey !== rows[0]!.inputStorageKey)) throw new Error("Selection membership is incomplete");
    const windows: ExecutionDispatchReference[] = [], dispatchIds: string[] = [];
    for (const row of rows) if (row.status === "queued" || row.status === "running") {
      const reference = await registerClipSelectionWindow(tx, row); windows.push(reference); dispatchIds.push(reference.dispatchId);
      const deadline = await appendExecutionDispatch(tx, { ...reference, subject: reference.subject, dueAt: row.operationDeadlineAt,
        wakeKind: "selection_deadline", deadlineKind: "operation", observedDeadlineAt: row.operationDeadlineAt });
      dispatchIds.push(deadline.reference.dispatchId);
    }
    return { kind: "prepared", windowCount: rows.length, windows, dispatchIds };
  }
  return {
    async prepare(reference: ExecutionDispatchReference): Promise<ClipSelectionPreparation> {
      const initial = await transaction(async tx => {
        const state = await lockClipSelectionParent(tx, reference);
        if (!state) return { kind: "superseded" as const, dispatchIds: [] };
        if (["completed", "failed", "cancelled"].includes(state.run.status)) return { kind: state.run.status as "completed" | "failed" | "cancelled", dispatchIds: [] };
        const rows = await tx.clipSelectionWindow.findMany({ where: { workflowRunId: state.run.id, workflowGeneration: state.run.generation, deploymentEpoch: state.run.deploymentEpoch }, orderBy: { windowIndex: "asc" } });
        if (rows.length) return register(tx, rows);
        return { kind: "new" as const, state, capsule: await capsule(state, reference, null) };
      });
      if (initial.kind !== "new") return initial;
      // A failed optional guidance read keeps the current product's degradation.
      const audienceDataLine = await config.guidance?.promptLine(initial.state.project.workspaceId).catch(() => null) ?? null;
      const input: ClipSelectionInput = { ...initial.capsule, planning: { ...initial.capsule.planning, audienceDataLine } };
      const encoded = await encodeClipSelectionInput(input), plan = buildClipSelectionPlan(input.planning);
      const inputReference = await confirmWrite(config.storage, `projects/${input.parent.projectId}/selection/${input.parent.id}/${encoded.sha256}.json`, encoded);
      const planned = plan.kind === "selection" ? plan.windows : [{ windowIndex: 0, startSec: plan.clips[0]!.startSec, endSec: plan.clips[0]!.endSec, userPrompt: null }];
      const proposed = await Promise.all(planned.map(async window => {
        const id = crypto.randomUUID(), inputHash = await clipSelectionWindowInputHash({ selectionHash: encoded.sha256, windowIndex: window.windowIndex, startSec: window.startSec, endSec: window.endSec });
        const empty = window.userPrompt === null ? await encodeClipSelectionResult({ parentId: input.parent.id, parentGeneration: input.parent.generation, selectionHash: encoded.sha256, windowIndex: window.windowIndex }, '{"clips":[]}', { tokensUsed: 0, providerRequestId: null }) : null;
        const result = empty ? await confirmWrite(config.storage, `execution/${input.parent.deploymentEpoch}/clip_selection_window/${id}/1/server/selection_window/${empty.sha256}.json`, empty) : null;
        return { id, window, inputHash, result, estimatedTokens: Math.max(1, Math.ceil(((window.userPrompt?.length ?? 0) + input.systemPrompt.length) / 4) + input.provider.maxOutputTokens) };
      }));
      return transaction(async tx => {
        const state = await lockClipSelectionParent(tx, reference);
        if (!state || !["queued", "waiting"].includes(state.run.status)) return { kind: "superseded", dispatchIds: [] };
        const existing = await tx.clipSelectionWindow.findMany({ where: { workflowRunId: state.run.id, workflowGeneration: state.run.generation, deploymentEpoch: state.run.deploymentEpoch }, orderBy: { windowIndex: "asc" } });
        if (existing.length) return register(tx, existing);
        if ((await encodeClipSelectionInput(await capsule(state, reference, audienceDataLine))).sha256 !== encoded.sha256) return { kind: "superseded", dispatchIds: [] };
        const rows: ClipSelectionWindow[] = [];
        for (const item of proposed) rows.push(await tx.clipSelectionWindow.create({ data: { id: item.id, projectId: input.parent.projectId, workflowRunId: input.parent.id,
          workflowGeneration: input.parent.generation, deploymentEpoch: input.parent.deploymentEpoch, transcriptId: input.transcript.id, transcriptGeneration: input.transcript.generation,
          transcriptAttemptId: input.transcript.attemptId, transcriptContentHash: input.transcript.contentHash, sourceRevision: input.transcript.sourceRevision,
          sourceAudioId: input.transcript.sourceAudioId, sourceAudioBindingHash: input.transcript.sourceAudioBindingHash, selectionHash: encoded.sha256,
          windowCount: proposed.length, windowIndex: item.window.windowIndex, startSec: item.window.startSec, endSec: item.window.endSec, inputHash: item.inputHash,
          inputStorageKey: inputReference.storageKey, inputEtag: inputReference.etag, inputChecksumSha256: inputReference.sha256, inputByteLength: BigInt(inputReference.byteLength), estimatedTokens: item.estimatedTokens,
          operationDeadlineAt: new Date(state.now.getTime() + 600_000), createdAt: state.now, providerQueuedAt: state.now,
          ...(item.result ? { status: "completed", completedAt: state.now, resultStorageKey: item.result.storageKey, resultEtag: item.result.etag, resultHash: item.result.sha256,
            resultByteLength: BigInt(item.result.byteLength), tokensUsed: 0 } : {}) } }));
        await tx.workflowRun.update({ where: { id: state.run.id }, data: { status: "waiting", attemptId: null, leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null, nextAttemptAt: null } });
        return register(tx, rows);
      });
    },
    async readWindow(reference: ExecutionDispatchReference) {
      return transaction(async tx => {
        const state = await lockClipSelectionWindow(tx, reference, true);
        if (!state) return null;
        const { row } = state;
        const parentRegistration = await tx.executionDispatch.findFirstOrThrow({ where: { subjectKind: "workflow_run", subjectId: row.workflowRunId, kind: "operation_driver",
          deploymentEpoch: row.deploymentEpoch, generation: row.workflowGeneration, wakeKind: null, deadlineKind: null }, orderBy: { createdAt: "asc" } });
        const parent: ClipSelectionParent = { id: row.workflowRunId, projectId: row.projectId, generation: row.workflowGeneration, deploymentEpoch: row.deploymentEpoch, inputHash: parentRegistration.inputHash };
        return { parent, status: row.status, selectionHash: row.selectionHash, windowIndex: row.windowIndex, startSec: row.startSec, endSec: row.endSec,
          input: { storageKey: row.inputStorageKey, etag: row.inputEtag, sha256: row.inputChecksumSha256, byteLength: Number(row.inputByteLength) } };
      });
    },
    async readFinalization(reference: ExecutionDispatchReference) {
      return transaction(async tx => {
        const state = await lockClipSelectionParent(tx, reference);
        if (!state) return { kind: "superseded" as const };
        if (["completed", "failed", "cancelled"].includes(state.run.status)) return { kind: "terminal" as const };
        const rows = await tx.clipSelectionWindow.findMany({ where: { workflowRunId: state.run.id, workflowGeneration: state.run.generation, deploymentEpoch: state.run.deploymentEpoch }, orderBy: { windowIndex: "asc" } });
        if (!rows.length) return { kind: "not_prepared" as const };
        if (rows.some(row => row.transcriptId !== state.transcript.id || row.transcriptContentHash !== rows[0]!.transcriptContentHash || row.selectionHash !== rows[0]!.selectionHash) ||
          rows[0]!.transcriptContentHash !== await clipSelectionTranscriptHash(state.transcript)) return { kind: "superseded" as const };
        if (rows.some(row => row.status !== "completed")) {
          const due = rows.filter(row => (row.status === "queued" && row.operationDeadlineAt <= state.now) ||
            (row.status === "running" && (row.operationDeadlineAt <= state.now || row.leaseExpiresAt! <= state.now)));
          return { kind: "pending" as const, dueWindows: await Promise.all(due.map(row => registerClipSelectionWindow(tx, row))) };
        }
        const first = rows[0]!;
        const parent: ClipSelectionParent = { id: state.run.id, projectId: state.project.id, generation: state.run.generation, deploymentEpoch: state.run.deploymentEpoch, inputHash: reference.inputHash };
        const proof: ClipSelectionFinalizationProof = { selectionHash: first.selectionHash,
          input: { storageKey: first.inputStorageKey, etag: first.inputEtag, sha256: first.inputChecksumSha256, byteLength: Number(first.inputByteLength) },
          windows: rows.map(row => ({ id: row.id, generation: row.generation, windowIndex: row.windowIndex, result: { storageKey: row.resultStorageKey!, etag: row.resultEtag!, sha256: row.resultHash!, byteLength: Number(row.resultByteLength!) },
            tokensUsed: row.tokensUsed!, providerRequestId: row.providerRequestId })) };
        return { kind: "ready" as const, parent, proof };
      });
    },
  };
}
