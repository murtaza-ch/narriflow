import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { frozenDubbingRequestSchema } from "@narriflow/validators/dubbing-execution";
import { DubbingExecution, createDubbingExecution } from "./dubbing-execution";
import { dubSpeechRequestBody, dubTranslationRequestBody, dubbingArtifactBindingHash } from "./dubbing-policy";
import { WorkflowRunLifecycle } from "./workflow-run-lifecycle";
import { createExecutionStorage } from "./execution-storage";

const capsules = new WeakMap<PrismaClient, Map<string, Uint8Array>>();
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
/** Uses the admitted immutable Dub request and the actual native control,
 * grants and finalizer. Only provider/storage responses are controlled. */
export async function startDubbingTestExecution(database: PrismaClient, runId: string) {
  const dub = await database.clipDub.findUniqueOrThrow({ where: { workflowRunId: runId } }), request = frozenDubbingRequestSchema.parse(dub.frozenRequest);
  let objects = capsules.get(database);if (!objects) { objects = new Map();capsules.set(database, objects); }
  const workflow = new WorkflowRunLifecycle({ prisma: database });
  const reference = (await database.$transaction(tx => workflow.dispatchRunWithinTransaction(tx, runId))).reference;
  const domain = new DubbingExecution(database, { toolchainFingerprint: "a".repeat(64), register: async () => {},
    head: async storageKey => ({ storageKey, etag: '"base"', byteLength: request.baseRender.byteLength, sha256: hash("abc") }),
    inputStorage: { read: async object => { const bytes = objects!.get(object.storageKey);if (!bytes) throw Error("Unknown fixture capsule");return bytes.slice(); },
      write: async (key, bytes) => { objects!.set(key, bytes.slice());return { etag: '"capsule"', byteLength: bytes.byteLength, sha256: hash(bytes) }; } },
  });
  const prepared = await domain.prepareExecution(reference);if (prepared.kind !== "waiting") throw Error(`Dub preparation ${prepared.kind}`);
  const fence = { reference: prepared.deadline.reference, attemptToken: prepared.deadline.attemptToken, owner: randomUUID() };
  const evidence = new Map<string, unknown>();
  const runtime = createDubbingExecution({ database, domain, deliverWakes: async () => {},
    storage: createExecutionStorage({ accountId: "a".repeat(32), bucket: "dub-test", accessKeyId: "fixture", secretAccessKey: "fixture" }),
    artifacts: { head: async assignment => assignment.role === "dub_mix" ? { etag: assignment.contentType === "video/mp4" ? '"video"' : '"audio"', contentType: assignment.contentType, byteLength: assignment.contentType === "video/mp4" ? 8192n : 4096n }
      : { etag: '"proof"', contentType: assignment.contentType, byteLength: BigInt(new TextEncoder().encode(JSON.stringify(evidence.get(assignment.id))).byteLength) }, readJson: async artifact => evidence.get(artifact.artifactId) },
  });
  const verified = () => ({ requestHash: hash(randomUUID()), metadata: { version: 1 as const, keyId: "dub-test", audience: "executor-control" as const, method: "POST" as const,
    canonicalTarget: "/api/execution/command", bodySha256: "0".repeat(64), timestamp: Math.floor(Date.now() / 1000), deliveryId: randomUUID(), signature: "0".repeat(64) } });
  const send = (command: unknown) => runtime.control.execute({ command, verifiedRequest: verified() });
  const acquired = await send({ action: "acquire", ...fence, leaseSeconds: 120 });if (acquired.disposition !== "acquired") throw Error(`Dub acquisition ${acquired.disposition}`);
  await send({ action: "process-start", fence });
  const packageReply = await runtime.transfer.execute({ command: { action: "work-package", fence }, verifiedRequest: verified() });
  if (packageReply.disposition !== "work_package") throw Error("Missing Dub package");
  const outputs = packageReply.outputs;
  async function commit(stage: "translation_intent" | "translation_result" | "speech_intent" | "final_result", fields: object) {
    const bindingHash = await dubbingArtifactBindingHash(dub.requestHash!, stage), output = outputs.find(output => output.bindingHash === bindingHash);
    if (!output) throw Error(`Missing Dub ${stage} assignment`);
    const value = { version: 1, kind: "dubbing_checkpoint", stage, dubId: dub.id, requestHash: dub.requestHash, ...fields }, raw = JSON.stringify(value);
    evidence.set(output.artifactId, value);
    return send({ action: "commit-artifact", fence, artifact: { artifactId: output.artifactId, role: "probe", bindingHash, contentType: "application/json", byteLength: new TextEncoder().encode(raw).byteLength, etag: '"proof"', sha256: hash(raw) } });
  }
  return { fence, send,
    command: (action: string, fields: Record<string, unknown> = {}) => send({ action, fence, ...fields }),
    translationIntent: () => commit("translation_intent", { bodySha256: hash(JSON.stringify(dubTranslationRequestBody(request))) }),
    async complete() {
      const current = await database.clipDub.findUniqueOrThrow({ where: { id: dub.id } }), text = current.translatedText ?? "El guion congelado";
      if (!current.translationResultArtifactId) {
        if (!current.translationIntentArtifactId) await commit("translation_intent", { bodySha256: hash(JSON.stringify(dubTranslationRequestBody(request))) });
        await commit("translation_result", { text, providerRequestId: "resp_fixture" });
      }
      if (!current.speechIntentArtifactId) await commit("speech_intent", { bodySha256: hash(JSON.stringify(dubSpeechRequestBody(request, text))) });
      for (const stage of ["audio", "video"] as const) {
        if (stage === "audio" ? current.audioArtifactId : current.videoArtifactId) continue;
        const bindingHash = await dubbingArtifactBindingHash(dub.requestHash!, stage), output = outputs.find(output => output.bindingHash === bindingHash);
        if (!output) throw Error(`Missing Dub ${stage} output`);
        await send({ action: "commit-artifact", fence, artifact: { artifactId: output.artifactId, role: "dub_mix", bindingHash,
          contentType: stage === "audio" ? "audio/mpeg" : "video/mp4", byteLength: stage === "audio" ? 4096 : 8192, etag: stage === "audio" ? '"audio"' : '"video"', sha256: (stage === "audio" ? "c" : "d").repeat(64) } });
      }
      return commit("final_result", { outcome: "completed", audio: { byteLength: 4096, sha256: "c".repeat(64) }, video: { byteLength: 8192, sha256: "d".repeat(64) }, probe: { state: "ready", durationSec: 10 } });
    },
  };
}
