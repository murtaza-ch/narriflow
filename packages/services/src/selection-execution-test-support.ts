import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { buildGenerationContentPack } from "@narriflow/validators";
import { WorkflowRunLifecycle } from "./workflow-run-lifecycle";
import { createClipSelectionPreparation, type ClipSelectionStorage } from "./clip-selection-preparation";
import { createClipSelectionLifecycle } from "./clip-selection-window";
import { createClipSelectionControl } from "./clip-selection-control";
import { clipSelectionBytesHash } from "./clip-selection-input";

/** Controlled R2/provider boundaries, with actual persisted window ownership,
 * charged starts, immutable result objects, and the real global finalizer. */
export async function prepareSelectionTestExecution(database: PrismaClient, runId: string, clips: unknown[] = [0, 40, 80].map(start => ({
  title: `Story ${start}`, start_time: start, end_time: start + 30, hook_text: "Hook", payoff_text: "Payoff", reasoning: "Fixture", category: "hook", platform_fit: ["tiktok"], hook_strength: 70, emotional_intensity: 70, story_completeness_score: 70, broll_cues: [] }))) {
    const run = await database.workflowRun.findUniqueOrThrow({ where: { id: runId } });
    const project = await database.project.findUniqueOrThrow({ where: { id: run.projectId } });
    await database.project.update({ where: { id: run.projectId }, data: { sourceDurationSeconds: project.sourceDurationSeconds ?? 120, ingestStatus: "ready" } });
    if (!run.contentPackId) {
      const pack = await database.contentPack.create({ data: { projectId: run.projectId, ...buildGenerationContentPack({ clipCountTarget: 3, clipLengthPreset: "30_to_60s" }) } });
      await database.workflowRun.update({ where: { id: run.id }, data: { contentPackId: pack.id } });
    }
    await database.transcript.upsert({ where: { projectId: run.projectId }, update: {}, create: { projectId: run.projectId, status: "completed", sourceRevision: 1, workflowAttemptId: randomUUID(), languageCode: "en", speakerCount: 1,
      text: "Frozen transcript", utterancesJson: Array.from({ length: 120 }, (_, index) => ({ index, speaker: 0, speakerLabel: "Speaker 1", startSec: index, endSec: index + 1,
        text: `Story ${index}.`, confidence: null, words: [{ word: `Story${index}.`, startSec: index, endSec: index + 1, confidence: null }] })) } });
    const workflow = new WorkflowRunLifecycle({ prisma: database }), reference = (await database.$transaction(tx => workflow.dispatchRunWithinTransaction(tx, run.id))).reference;
    const objects = new Map<string, Uint8Array>();
    const storage: ClipSelectionStorage = {
      async write(key, bytes) { objects.set(key, bytes.slice()); return { etag: '"sealed"', byteLength: bytes.byteLength, sha256: await clipSelectionBytesHash(bytes) }; },
      async read(object) { const bytes = objects.get(object.storageKey); if (!bytes || object.etag !== '"sealed"') throw Error("Changed private selection object"); return bytes.slice(); },
    };
    const preparation = createClipSelectionPreparation({ database, storage, provider: { model: "gpt-5.4-mini", reasoningEffort: "medium", maxOutputTokens: 32000 } });
    const prepared = await preparation.prepare(reference);
    if (prepared.kind !== "prepared") throw Error("Expected selection preparation");
    const control = createClipSelectionControl({ preparation, storage, lifecycle: createClipSelectionLifecycle({ database, maxInFlightRequests: 1, maxEstimatedTokens: 240000 }), finalization: workflow,
      deliver: async ids => { if (await database.executionDispatch.count({ where: { id: { in: [...ids] } } }) !== ids.length) throw Error("Selection fixture wake was not committed"); },
      provider: { async generate() { return { kind: "completed", tokensUsed: 123, providerRequestId: "workflow-selection-fixture", rateLimitHeaders: {}, content: JSON.stringify({ clips }) }; } },
    });
    for (const window of prepared.windows) { const result = await control.runWindow(window); if (result.kind !== "complete" || result.outcome !== "completed") throw Error("Selection fixture result was not committed"); }
    return { control, reference };
}
