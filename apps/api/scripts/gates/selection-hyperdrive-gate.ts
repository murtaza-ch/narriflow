import type { PrismaClient } from "@prisma/client";
import { createDatabaseScope, getPrismaClient, withDatabaseScope } from "@narriflow/db/client";
import { withServiceEnvironment } from "@narriflow/services/runtime-environment";
import { createClipSelectionPreparation, type ClipSelectionStorage } from "@narriflow/services/clip-selection-preparation";
import { createClipSelectionLifecycle } from "@narriflow/services/clip-selection-window";
import { createClipSelectionControl } from "@narriflow/services/clip-selection-control";
import { WorkflowRunLifecycle } from "@narriflow/services/workflow-run-lifecycle";
import { workflowRunExecutionInputHash } from "@narriflow/services/workflow-execution-input";
import { appendExecutionDispatch } from "@narriflow/services/execution-dispatch";
import { clipSelectionBytesHash, encodeClipSelectionResult } from "@narriflow/services/clip-selection-input";
import { createSyntheticSelectionCapsule } from "./selection-fixture";

/** Fixed isolated fixture only. No HTTP caller can select SQL, IDs, text or a database. */
export async function runSelectionHyperdriveGate(connectionString: string) {
  return withDatabaseScope(createDatabaseScope({ connectionString, pool: { max: 1 } }), () => runSelectionFinalizationFixture(getPrismaClient()!));
}

/** Public gate seam used by the disposable-schema test before an edge deployment. */
export async function runSelectionFinalizationFixture(database: PrismaClient) {
  return withServiceEnvironment({}, async () => {
    const [guard] = await database.$queryRaw<Array<{ marker: string | null; closed: boolean; database: string; schema: string }>>`SELECT current_database() AS database, current_schema() AS schema,
      to_regclass(quote_ident(current_schema()) || '."_narriflow_platform_lock_gate"')::text AS marker, NOT "admissionOpen" AS closed FROM "ExecutionEpoch" WHERE id=1`;
    const isolated = guard && ((guard.database === "serverless_integration_gates" && guard.schema === "public") ||
      (/^narriflow_serverless_gates_[a-z0-9_]+$/.test(guard.database) && /^serverless_execution_test_[a-z0-9]+$/.test(guard.schema)));
    if (!isolated || !guard?.marker || !guard.closed) throw new Error("selection_gate_requires_closed_isolated_platform_branch");
    const synthetic = await createSyntheticSelectionCapsule();
    const user = await database.user.create({ data: { clerkId: `selection-hyperdrive-gate:${crypto.randomUUID()}` } });
    let projectId: string | null = null;
    try {
      const workspace = await database.workspace.create({ data: { ownerUserId: user.id, name: "Synthetic selection Hyperdrive gate" } });
      const project = await database.project.create({ data: { workspaceId: workspace.id, title: synthetic.planning.projectTitle, sourceMediaUrl: "r2://synthetic/selection-gate", sourceStorageKey: "synthetic/selection/source.mp4", sourceDurationSeconds: 10800, ingestStatus: "ready" } });
      projectId = project.id;
      const pack = await database.contentPack.create({ data: { projectId, outputTypes: ["short_clip"], clipCountTarget: 30, clipDurationSecTarget: 45,
        toneConstraints: synthetic.planning.contentPack.toneConstraints, captionPreset: synthetic.planning.contentPack.captionPreset, platformPlaybookVersion: "platform-playbook-v1" } });
      const transcript = await database.transcript.create({ data: { projectId, status: "completed", workflowAttemptId: crypto.randomUUID(), sourceRevision: 1, selectionGeneration: 1,
        text: synthetic.planning.fullText, utterancesJson: synthetic.planning.utterances, languageCode: "en", speakerCount: 2 } });
      const epoch = (await database.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).epoch;
      const run = await database.workflowRun.create({ data: { projectId, stage: "moment_detection", status: "queued", idempotencyKey: crypto.randomUUID(), contentPackId: pack.id, deploymentEpoch: epoch } });
      const inputHash = await workflowRunExecutionInputHash({ ...run, sourceAudioId: null, sourceRevision: 1, sourceTranscript: { id: transcript.id, generation: 1, attemptId: transcript.workflowAttemptId } });
      const reference = await database.$transaction(async tx => (await appendExecutionDispatch(tx, { deploymentEpoch: epoch, generation: run.generation, kind: "operation_driver", subject: { kind: "workflow_run", id: run.id }, inputHash, dueAt: run.createdAt })).reference);
      const objects = new Map<string, Uint8Array>();
      const storage: ClipSelectionStorage = {
        async write(key, bytes) { objects.set(key, bytes.slice()); return { etag: '"synthetic-sealed"', byteLength: bytes.byteLength, sha256: await clipSelectionBytesHash(bytes) }; },
        async read(object) { const bytes = objects.get(object.storageKey); if (!bytes || object.etag !== '"synthetic-sealed"') throw new Error("selection_gate_private_object_missing"); return bytes.slice(); },
      };
      const preparation = createClipSelectionPreparation({ database, storage, provider: synthetic.provider });
      const prepareStarted = performance.now(), prepared = await preparation.prepare(reference), prepareMs = Math.round(performance.now() - prepareStarted);
      if (prepared.kind !== "prepared" || prepared.windowCount !== 6) throw new Error("selection_gate_window_count");
      const windows = await database.clipSelectionWindow.findMany({ where: { workflowRunId: run.id }, orderBy: { windowIndex: "asc" } });
      // Synthetic completed evidence isolates finalization timing. It makes no
      // provider call and does not claim the executor-admission gate.
      for (const window of windows) {
        const clips = Array.from({ length: 8 }, (_, index) => ({ title: `Synthetic complete story ${window.windowIndex}-${index}`, start_time: window.startSec + index * 180, end_time: window.startSec + index * 180 + 45,
          hook_text: "A synthetic hook", payoff_text: "A synthetic payoff", reasoning: "A complete synthetic story", category: "story", platform_fit: ["tiktok"], hook_strength: 80, emotional_intensity: 80, story_completeness_score: 95, broll_cues: [] }));
        const result = await encodeClipSelectionResult({ parentId: run.id, parentGeneration: run.generation, selectionHash: window.selectionHash, windowIndex: window.windowIndex }, JSON.stringify({ clips }), { tokensUsed: 1000, providerRequestId: `synthetic-${window.windowIndex}` });
        const storageKey = `execution/${epoch}/clip_selection_window/${window.id}/1/server/selection_window/${crypto.randomUUID()}/${result.sha256}.json`;
        const sealed = await storage.write(storageKey, result.bytes);
        await database.clipSelectionWindow.update({ where: { id: window.id }, data: { status: "completed", completedAt: new Date(), resultStorageKey: storageKey, resultEtag: sealed.etag,
          resultHash: result.sha256, resultByteLength: BigInt(result.byteLength), tokensUsed: 1000, providerRequestId: `synthetic-${window.windowIndex}` } });
      }
      const workflow = new WorkflowRunLifecycle({ prisma: database }), authorityTransactionMs: number[] = [];
      const control = createClipSelectionControl({ preparation, lifecycle: createClipSelectionLifecycle({ database, maxInFlightRequests: 4, maxEstimatedTokens: 200000 }), storage,
        finalization: { async finalizeClipSelection(...args) { const started = performance.now(); try { return await workflow.finalizeClipSelection(...args); } finally { authorityTransactionMs.push(Math.round(performance.now() - started)); } } },
        async deliver(ids) { if (ids.length && await database.executionDispatch.count({ where: { id: { in: [...new Set(ids)] } } }) !== new Set(ids).size) throw new Error("selection_gate_wake_missing"); },
        provider: { async generate() { throw new Error("selection_gate_must_not_call_provider"); } },
      });
      const finalizeStarted = performance.now(), finalized = await control.runParent(reference), finalizeMs = Math.round(performance.now() - finalizeStarted);
      const replayStarted = performance.now(), replay = await control.runParent(reference), replayMs = Math.round(performance.now() - replayStarted);
      const clips = await database.clip.count({ where: { projectId } }), renders = await database.clipRender.count({ where: { clip: { projectId } } });
      const renderRuns = await database.workflowRun.count({ where: { projectId, stage: "clip_rendering" } });
      const terminalEvents = await database.workflowEvent.count({ where: { workflowRunId: run.id, status: "completed" } });
      const parent = await database.workflowRun.findUniqueOrThrow({ where: { id: run.id } });
      if (finalized.kind !== "complete" || finalized.outcome !== "completed" || replay.kind !== "complete" || replay.outcome !== "completed" || clips !== 30 || renders !== 30 || renderRuns !== 1 || terminalEvents !== 1 || parent.attemptId || parent.leaseOwner || parent.leaseExpiresAt || parent.attemptCount !== 0 || finalizeMs >= 120000) throw new Error("selection_gate_finalization_invariant_failed");
      return { passed: true, sourceSeconds: 10800, words: 28800, windowCount: 6, clips, renders, renderRuns, terminalEvents, parentUnleased: true, prepareMs, finalizeMs, authorityTransactionMs, replayMs,
        providerRequests: 0, privateStorageSynthetic: true, schedulerConfirmationSynthetic: true, database: "isolated-platform-gates", completedAt: new Date().toISOString() };
    } finally {
      if (projectId) {
        const compactProject = btoa(String.fromCharCode(...projectId.replaceAll("-", "").match(/../g)!.map(value => Number.parseInt(value, 16))))
          .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
        const [runs, windows, events, workspaceEvents] = await Promise.all([
          database.workflowRun.findMany({ where: { projectId }, select: { id: true } }), database.clipSelectionWindow.findMany({ where: { projectId }, select: { id: true } }),
          database.workflowEvent.findMany({ where: { projectId }, select: { id: true } }), database.workspaceEvent.findMany({ where: { workspace: { ownerUserId: user.id } }, select: { id: true } }),
        ]);
        const cleanup = await database.mediaCleanupObligation.findMany({ where: { projectId }, select: { id: true, createdAt: true } });
        await database.executionDispatch.deleteMany({ where: { OR: [{ subjectId: { in: [...runs, ...windows, ...events, ...workspaceEvents].map(row => row.id) } }, { subjectId: { startsWith: `pe1.${compactProject}.` } },
          ...cleanup.map(row => ({ subjectId: { startsWith: `mc1.${row.createdAt.getTime()}.${row.id.replaceAll("-", "")}.` } }))] } });
        await database.mediaCleanupObligation.deleteMany({ where: { projectId } });
      }
      await database.workspace.deleteMany({ where: { ownerUserId: user.id } }); await database.user.delete({ where: { id: user.id } });
    }
  });
}
