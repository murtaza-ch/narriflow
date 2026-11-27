import type { ClipSelectionWindow, Prisma, PrismaClient } from "@prisma/client";
import { captionEmojiPicksSchema, fillerTaggingOutcomeSchema, listFillerClassifier, parseStoredContentPack, sourceProbeSchema, transcriptUtteranceSchema, type CaptionEmojiPick, type ClipSelectionInput,
  type ClipSelectionParent, type FillerTaggingOutcome, type TranscriptUtterance } from "@narriflow/validators";
import type { ExecutionDispatchReference } from "@narriflow/validators/execution";
import { appendExecutionDispatch } from "./execution-dispatch";
import { prepareDetectedClipSeed } from "./clip-detection-persistence";
import { clipSelectionBytesHash, clipSelectionWindowInputHash, encodeClipSelectionInput, encodeClipSelectionResult } from "./clip-selection-input";
import { buildClipSelectionPlan } from "./clip-selection-plan";
import { CLIP_DETECTION_JSON_SCHEMA, SYSTEM_PROMPT } from "./clip-selection-policy";
import { clipSelectionTranscriptHash, lockClipSelectionParent, lockClipSelectionWindow, registerClipSelectionWindow, type ClipSelectionObjectReference } from "./clip-selection-window";
import { WorkflowFailure } from "./workflow-attempt-contract";
import type { ClipSelectionFinalizationProof } from "./clip-selection-finalization";
import { admitMediaCleanupObligations } from "./media-cleanup";
import { lockPlannedExecutionObject } from "./execution-object-cleanup";

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

/** Tags hesitation sounds for a language without a built-in list. Must
 *  finish by `deadline` (epoch ms) and never throw on provider failure. */
export interface ClipSelectionFillerTagger {
  tag(utterances: TranscriptUtterance[], languageCode: string, deadline: number): Promise<FillerTaggingOutcome>;
}

/** The utterances AI filler and emoji tagging cover: those the processing range keeps, as selection planning filters them. */
export function selectionTaggingUtterances(input: Pick<ClipSelectionInput, "planning">): TranscriptUtterance[] {
  const { processingStartSec: start, processingEndSec: end } = input.planning.contentPack;
  return input.planning.utterances.filter((utterance) => (start === null || utterance.endSec > start) && (end === null || utterance.startSec < end));
}

/** Tags once per preparation, only when this generation removes fillers in
 *  a language without a list. Optional enrichment: any failure or invalid
 *  outcome is null (no AI cuts), never a failed generation. */
export async function tagSelectionFillers(input: ClipSelectionInput, tagger: ClipSelectionFillerTagger | undefined, deadline: number): Promise<FillerTaggingOutcome | null> {
  const { removeFillerWords, languageCode } = input.editor.cleanup;
  if (!tagger || !removeFillerWords || !languageCode || listFillerClassifier(languageCode)) return null;
  const utterances = selectionTaggingUtterances(input);
  if (utterances.length === 0) return null;
  try {
    const outcome = fillerTaggingOutcomeSchema.safeParse(await tagger.tag(utterances, languageCode, deadline));
    if (!outcome.success) return null;
    const { keys: _keys, contract: _contract, ...counts } = outcome.data;
    console.warn(JSON.stringify({ level: "info", message: "clip_filler_tagging", workflowRunId: input.parent.id, languageCode, ...counts, keyCount: outcome.data.keys.length }));
    return outcome.data;
  } catch (error) {
    console.warn(JSON.stringify({ level: "warn", message: "clip_filler_tagging_failed", workflowRunId: input.parent.id, error: error instanceof Error ? error.message : String(error) }));
    return null;
  }
}

/** Suggests caption emojis over the source. Must finish by `deadline` (epoch
 *  ms); a failed chunk yields no picks. */
export interface ClipSelectionEmojiTagger {
  tag(input: { utterances: TranscriptUtterance[]; languageCode: string | null; title: string; deadline: number }): Promise<{ picks: CaptionEmojiPick[]; chunks: number;
    tagged: number; failed: number; skipped: number; tokensUsed: number }>;
}

/** Tags once per preparation, only when the pack adds emojis, over the same
 *  utterances as filler tagging. Optional enrichment: any failure or invalid
 *  outcome is null (clips without emojis), never a failed generation. */
export async function tagSelectionEmojis(input: ClipSelectionInput, tagger: ClipSelectionEmojiTagger | undefined, deadline: number): Promise<CaptionEmojiPick[] | null> {
  if (!tagger || !input.planning.contentPack.addEmojis) return null;
  const utterances = selectionTaggingUtterances(input);
  if (utterances.length === 0) return null;
  try {
    const startedAt = Date.now();
    const { picks, ...counts } = await tagger.tag({ utterances, languageCode: input.planning.sourceLanguageCode, title: input.planning.projectTitle, deadline });
    const parsed = captionEmojiPicksSchema.safeParse(picks);
    console.warn(JSON.stringify({ level: "info", message: "clip_emoji_tagging", workflowRunId: input.parent.id, languageCode: input.planning.sourceLanguageCode,
      chunks: counts.chunks, tagged: counts.tagged, failed: counts.failed, skipped: counts.skipped, tokensUsed: counts.tokensUsed,
      pickCount: parsed.success ? parsed.data.length : 0, valid: parsed.success, elapsedMs: Date.now() - startedAt }));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    console.warn(JSON.stringify({ level: "warn", message: "clip_emoji_tagging_failed", workflowRunId: input.parent.id, error: error instanceof Error ? error.message : String(error) }));
    return null;
  }
}

/**
 * The richest capsule that fits. Optional tags never make an input that fits
 * without them too large: emoji picks are dropped first, then filler tags. An
 * input too large even without tags throws as before.
 */
export async function fitSelectionTags(withTags: (aiFillers: FillerTaggingOutcome | null, emojiPicks: CaptionEmojiPick[] | null) => ClipSelectionInput,
  aiFillers: FillerTaggingOutcome | null, emojiPicks: CaptionEmojiPick[] | null, encode: typeof encodeClipSelectionInput = encodeClipSelectionInput) {
  const options = [{ aiFillers, emojiPicks }, ...(emojiPicks ? [{ aiFillers, emojiPicks: null }] : []), ...(aiFillers ? [{ aiFillers: null, emojiPicks: null }] : [])];
  for (const [index, option] of options.entries()) {
    try { return { ...option, encoded: await encode(withTags(option.aiFillers, option.emojiPicks)) }; }
    catch (error) { if (index === options.length - 1) throw error; }
  }
  throw new Error("unreachable");
}

/**
 * The capsule staged outside the commit transaction must still be the run's capsule. When the
 * run is still current but its inputs changed meanwhile (a brand or Content Pack edit), the run
 * is not superseded: this throws a retryable failure, the commit rolls back, and the next attempt
 * stages the current capsule. The staged objects keep their delayed cleanup obligations and are
 * deleted by media cleanup, since no window row ever references them.
 */
export function requireStagedCapsuleCurrent(stagedSha256: string, currentSha256: string): void {
  if (stagedSha256 !== currentSha256) throw new WorkflowFailure("selection_input_changed", "retryable", "Selection inputs changed while the capsule was staged");
}

export function createClipSelectionPreparation(config: { database: PrismaClient; storage: ClipSelectionStorage; provider: ClipSelectionInput["provider"]; guidance?: { promptLine(workspaceId: string): Promise<string | null> };
  fillerTagger?: ClipSelectionFillerTagger; emojiTagger?: ClipSelectionEmojiTagger; fillerTaggingBudgetMs?: number; now?: () => number }) {
  const transaction = <T>(body: (tx: Tx) => Promise<T>) => config.database.$transaction(body, { maxWait: 10_000, timeout: 30_000 });
  const responseSchemaHash = clipSelectionBytesHash(new TextEncoder().encode(JSON.stringify(CLIP_DETECTION_JSON_SCHEMA)));
  async function capsule(state: NonNullable<Awaited<ReturnType<typeof lockClipSelectionParent>>>, parentReference: ExecutionDispatchReference, audienceDataLine: string | null,
    aiFillers: FillerTaggingOutcome | null, emojiPicks: CaptionEmojiPick[] | null): Promise<ClipSelectionInput> {
    if (!state.run.contentPack || state.run.contentPack.draft) throw new WorkflowFailure("workflow_content_pack_invalid", "permanent", "Selection requires its committed Content Pack");
    const pack = parseStoredContentPack(state.run.contentPack), transcript = state.transcript;
    const probe = sourceProbeSchema.safeParse(state.project.sourceProbe);
    return { version: 1, parent: { id: state.run.id, projectId: state.project.id, generation: state.run.generation, deploymentEpoch: state.run.deploymentEpoch, inputHash: parentReference.inputHash },
      transcript: { id: transcript.id, generation: transcript.selectionGeneration, attemptId: transcript.workflowAttemptId, contentHash: await clipSelectionTranscriptHash(transcript),
        sourceRevision: transcript.sourceRevision, sourceAudioId: transcript.sourceAudioId, sourceAudioBindingHash: transcript.sourceAudio?.bindingHash ?? null },
      planning: { projectTitle: state.project.title, contentPack: pack, sourceDurationSec: (state.project.sourceDurationSeconds ?? transcript.durationSeconds) || null,
        sourceProbeDurationSec: probe.success ? probe.data.durationSec : null, utterances: transcriptUtteranceSchema.array().parse(transcript.utterancesJson ?? []), fullText: transcript.text ?? "",
        speakerCount: transcript.speakerCount, sourceLanguageCode: transcript.languageCode, audienceDataLine },
      editor: prepareDetectedClipSeed(state.project, pack, { quietRanges: transcript.sourceAudio?.quietRanges ?? null, languageCode: transcript.languageCode, aiFillers, emojiPicks }), provider: config.provider, systemPrompt: SYSTEM_PROMPT, responseSchemaHash: await responseSchemaHash };
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
      // Filler and emoji tagging share this deadline; it must end well inside
      // the 2-minute workflow command that runs preparation.
      const taggingDeadline = (config.now ?? Date.now)() + (config.fillerTaggingBudgetMs ?? 60_000);
      const initial = await transaction(async tx => {
        const state = await lockClipSelectionParent(tx, reference);
        if (!state) return { kind: "superseded" as const, dispatchIds: [] };
        if (["completed", "failed", "cancelled"].includes(state.run.status)) return { kind: state.run.status as "completed" | "failed" | "cancelled", dispatchIds: [] };
        const rows = await tx.clipSelectionWindow.findMany({ where: { workflowRunId: state.run.id, workflowGeneration: state.run.generation, deploymentEpoch: state.run.deploymentEpoch }, orderBy: { windowIndex: "asc" } });
        if (rows.length) return register(tx, rows);
        return { kind: "new" as const, state, capsule: await capsule(state, reference, null, null, null) };
      });
      if (initial.kind !== "new") return initial;
      // A failed optional guidance read keeps the current product's degradation.
      // Tagging is frozen here once. Spend policy (accepted): until the windows
      // commit, a failed command attempt or a concurrent preparation may tag
      // again, at most 11 times per command sequence (1 + 10 workflow retries),
      // about $0.84 each for a 3-hour source (emoji tagging adds about $0.12
      // when the pack adds emojis). The first committed capsule wins
      // and losers reuse its windows below; once windows exist, nothing tags.
      const [audienceDataLine, tagged, taggedEmojis] = await Promise.all([
        config.guidance?.promptLine(initial.state.project.workspaceId).catch(() => null) ?? Promise.resolve(null),
        tagSelectionFillers(initial.capsule, config.fillerTagger, taggingDeadline),
        tagSelectionEmojis(initial.capsule, config.emojiTagger, taggingDeadline),
      ]);
      const withTags = (aiFillers: FillerTaggingOutcome | null, emojiPicks: CaptionEmojiPick[] | null): ClipSelectionInput => ({ ...initial.capsule, planning: { ...initial.capsule.planning, audienceDataLine },
        editor: { ...initial.capsule.editor, cleanup: { ...initial.capsule.editor.cleanup, aiFillers }, emojiPicks } });
      // The final check below reuses this choice of tags.
      const { aiFillers, emojiPicks, encoded } = await fitSelectionTags(withTags, tagged, taggedEmojis), input = withTags(aiFillers, emojiPicks), plan = buildClipSelectionPlan(input.planning);
      const inputKey = `projects/${input.parent.projectId}/selection/${input.parent.id}/${crypto.randomUUID()}/${encoded.sha256}.json`;
      const planned = plan.kind === "selection" ? plan.windows : [{ windowIndex: 0, startSec: plan.clips[0]!.startSec, endSec: plan.clips[0]!.endSec, userPrompt: null }];
      const staged = await Promise.all(planned.map(async window => {
        const id = crypto.randomUUID(), inputHash = await clipSelectionWindowInputHash({ selectionHash: encoded.sha256, windowIndex: window.windowIndex, startSec: window.startSec, endSec: window.endSec });
        const empty = window.userPrompt === null ? await encodeClipSelectionResult({ parentId: input.parent.id, parentGeneration: input.parent.generation, selectionHash: encoded.sha256, windowIndex: window.windowIndex }, '{"clips":[]}', { tokensUsed: 0, providerRequestId: null }) : null;
        const resultKey = empty ? `execution/${input.parent.deploymentEpoch}/clip_selection_window/${id}/1/server/selection_window/${crypto.randomUUID()}/${empty.sha256}.json` : null;
        return { id, window, inputHash, empty, resultKey, estimatedTokens: Math.max(1, Math.ceil(((window.userPrompt?.length ?? 0) + input.systemPrompt.length) / 4) + input.provider.maxOutputTokens) };
      }));
      const objectKeys = [inputKey, ...staged.flatMap(item => item.resultKey ? [item.resultKey] : [])];
      const intent = await transaction(async tx => {
        const state = await lockClipSelectionParent(tx, reference);
        if (!state || !["queued", "waiting"].includes(state.run.status)) return { kind: "superseded" as const, dispatchIds: [] };
        const existing = await tx.clipSelectionWindow.findMany({ where: { workflowRunId: state.run.id, workflowGeneration: state.run.generation, deploymentEpoch: state.run.deploymentEpoch }, orderBy: { windowIndex: "asc" } });
        if (existing.length) return register(tx, existing);
        await admitMediaCleanupObligations(tx, objectKeys.map(objectKey => ({ origin: "selection_execution" as const, cleanupClass: "execution_input" as const,
          projectId: state.project.id, objectKey, notBefore: new Date(state.now.getTime() + 720_000) })));
        return { kind: "planned" as const };
      });
      if (intent.kind !== "planned") return intent;
      const inputReference = await confirmWrite(config.storage, inputKey, encoded);
      const proposed = await Promise.all(staged.map(async item => ({ ...item, result: item.empty ? await confirmWrite(config.storage, item.resultKey!, item.empty) : null })));
      return transaction(async tx => {
        const state = await lockClipSelectionParent(tx, reference);
        if (!state || !["queued", "waiting"].includes(state.run.status)) return { kind: "superseded", dispatchIds: [] };
        const existing = await tx.clipSelectionWindow.findMany({ where: { workflowRunId: state.run.id, workflowGeneration: state.run.generation, deploymentEpoch: state.run.deploymentEpoch }, orderBy: { windowIndex: "asc" } });
        if (existing.length) return register(tx, existing);
        requireStagedCapsuleCurrent(encoded.sha256, (await encodeClipSelectionInput(await capsule(state, reference, audienceDataLine, aiFillers, emojiPicks))).sha256);
        for (const storageKey of objectKeys.slice().sort()) await lockPlannedExecutionObject(tx, { origin: "selection_execution", storageKey });
        await tx.mediaCleanupObligation.updateMany({ where: { origin: "selection_execution", cleanupClass: "execution_input", objectKey: { in: objectKeys } }, data: { nextAttemptAt: new Date(state.now.getTime() + 720_000) } });
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
        const state = await lockClipSelectionWindow(tx, reference, true, false);
        if (!state?.current) return null;
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
