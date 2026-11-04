import type { ExecutionArtifact, ExecutionAttempt, PrismaClient } from "@prisma/client";
import type { ExecutionDispatchReference, ExecutorFence } from "@narriflow/validators/execution";
import { clipPreparationObjectSchema, type ClipPreparationInput, type ClipPreparationObject } from "@narriflow/validators/clip-preparation";
import type { RenderExecutionInput } from "@narriflow/validators/render-execution";
import { decodeClipPreparationInput } from "./clip-preparation-input";
import { decodeRenderExecutionInput, encodeRenderExecutionInput } from "./render-execution-input";
import { prepareRenderArtifact, renderArtifactBindingHash } from "./render-artifact";
import type { ClipPreparationService, ReadyClipPreparation } from "./clip-preparation";
import { RenderGroupLifecycle } from "./render-group-lifecycle";
import type { NativeValidationPreparation } from "./native-validation";
import { createExecutorControl, ExecutorControlError, type ExecutorArtifactHead } from "./executor-control";
import type { ExecutorArtifactCommit } from "./executor-domain-control";
import { createExecutionTransfer } from "./execution-transfer";
import type { createExecutionStorage } from "./execution-storage";
import { isExecutionInputKey } from "./execution-input-key";
import type { VerifiedExecutionRequest } from "./execution-signature";
import { sha256Hex } from "./execution-hash";

export interface RenderGroupExecutionDependencies {
  toolchainFingerprint: string;
  preparation: Pick<ClipPreparationService, "admitForGroup" | "readReadyForGroup">;
  inputStorage: {
    write(key: string, bytes: Uint8Array): Promise<{ etag: string; byteLength: number; sha256: string }>;
    read(reference: ClipPreparationObject): Promise<Uint8Array>;
  };
  snapshot(reference: ExecutionDispatchReference, preparation: ClipPreparationInput, ready: ReadyClipPreparation): Promise<RenderExecutionInput>;
  register(ids: readonly string[]): Promise<void>;
}

/** A metadata-only command. There is no polling coordinator or native work under SQL locks. */
export class RenderGroupExecutionService {
  readonly domain: RenderGroupLifecycle;
  constructor(private readonly database: PrismaClient, private readonly dependencies: RenderGroupExecutionDependencies) {
    if (!/^[a-f0-9]{64}$/.test(dependencies.toolchainFingerprint)) throw new Error("render_input_invalid");
    this.domain = new RenderGroupLifecycle({ prisma: database });
  }
  async loadInput(row: Pick<ExecutionAttempt, "inputStorageKey" | "inputEtag" | "inputByteLength" | "inputChecksumSha256">) {
    if (!row.inputStorageKey || !row.inputEtag || !row.inputByteLength || !row.inputChecksumSha256) throw new ExecutorControlError("invalid_reference");
    const reference = { storageKey: row.inputStorageKey, etag: row.inputEtag, byteLength: Number(row.inputByteLength), sha256: row.inputChecksumSha256 };
    const input = await decodeRenderExecutionInput(await this.dependencies.inputStorage.read(reference), reference);
    if (input.preparation.toolchainFingerprint !== this.dependencies.toolchainFingerprint) throw new ExecutorControlError("invalid_reference");
    return input;
  }
  /** An inexpensive rejection before capsule I/O, never authority. Only the
   * final locked transaction may turn these immutable bytes into a grant. */
  async preloadInput(fence: ExecutorFence, requireStarted: boolean, verified: VerifiedExecutionRequest) {
    const reference = fence.reference;
    if (reference.kind !== "modal_execution" || reference.subject.kind !== "render_group") throw new ExecutorControlError("invalid_reference");
    const [attempt] = await this.database.$queryRaw<Array<ExecutionAttempt & {
      dispatchKind: string; subjectKind: string; subjectId: string; currentEpoch: number; now: Date; priorRequestHash: string | null;
    }>>`SELECT attempt.*, dispatch.kind AS "dispatchKind", dispatch."subjectKind", dispatch."subjectId", epoch.epoch AS "currentEpoch", receipt."requestHash" AS "priorRequestHash",
        clock_timestamp() AT TIME ZONE 'UTC' AS now
      FROM "ExecutionAttempt" attempt JOIN "ExecutionDispatch" dispatch ON dispatch.id = attempt."dispatchId"
      LEFT JOIN "ExecutionInboxReceipt" receipt ON receipt.audience = ${verified.metadata.audience} AND receipt."deliveryId" = ${verified.metadata.deliveryId}::uuid
      CROSS JOIN "ExecutionEpoch" epoch WHERE attempt."attemptToken" = ${fence.attemptToken}::uuid AND epoch.id = 1`;
    if (attempt?.priorRequestHash && attempt.priorRequestHash !== verified.requestHash) throw new ExecutorControlError("replay_conflict");
    if (!attempt || attempt.dispatchId !== reference.dispatchId || attempt.deploymentEpoch !== reference.deploymentEpoch ||
      attempt.generation !== reference.generation || attempt.inputHash !== reference.inputHash || attempt.dispatchKind !== reference.kind ||
      attempt.subjectKind !== reference.subject.kind || attempt.subjectId !== reference.subject.id || attempt.functionName !== "render_group") throw new ExecutorControlError("invalid_reference");
    if (attempt.currentEpoch !== reference.deploymentEpoch || attempt.owner !== fence.owner || attempt.revokedAt ||
      !["admitted", "running"].includes(attempt.status) || !attempt.leaseExpiresAt || attempt.leaseExpiresAt <= attempt.now || attempt.operationDeadlineAt <= attempt.now ||
      (requireStarted && (!attempt.processStartedAt || attempt.status !== "running"))) throw new ExecutorControlError("authority_lost");
    if (!attempt.inputStorageKey || !attempt.inputEtag || !attempt.inputByteLength || !attempt.inputChecksumSha256) throw new ExecutorControlError("invalid_reference");
    const tuple = { storageKey: attempt.inputStorageKey, etag: attempt.inputEtag, byteLength: Number(attempt.inputByteLength), sha256: attempt.inputChecksumSha256 };
    if (!clipPreparationObjectSchema.safeParse(tuple).success || !isExecutionInputKey(tuple.storageKey) || tuple.byteLength > 16 * 1024 ** 2) throw new ExecutorControlError("invalid_reference");
    return { tuple, input: await this.loadInput(attempt) };
  }
  async prepareExecution(reference: ExecutionDispatchReference): Promise<NativeValidationPreparation> {
    const initial = await this.domain.prepareInputDeadline(reference);
    await this.dependencies.register(initial.dispatchIds);
    if (initial.kind !== "ready") return initial;
    if (!initial.group.inputStorageKey) {
      const admission = await this.dependencies.preparation.admitForGroup(reference);
      if (admission.kind === "failed") {
        await this.dependencies.register(await this.domain.failPreparation(reference, admission.preparationId));
        return { kind: "terminal" };
      }
      if (admission.kind !== "ready") return { kind: "dependency_wait", dueAt: initial.deadlineAt, deadlineDispatchId: initial.deadlineDispatchId,
        dispatchIds: [...new Set([...initial.dispatchIds, ...admission.dispatchIds])] };
      const ready = await this.dependencies.preparation.readReadyForGroup(reference);
      if (!ready) throw new Error("render_input_unavailable");
      const preparation = await decodeClipPreparationInput(await this.dependencies.inputStorage.read(ready.input), ready.input);
      const input = await this.dependencies.snapshot(reference, preparation, ready);
      if (input.groupId !== initial.group.id || input.workflowRunId !== initial.parent.id || input.workSetGeneration !== initial.group.workSetGeneration ||
        input.preparation.bindingHash !== ready.bindingHash || input.preparation.preparationId !== ready.preparationId || input.preparation.toolchainFingerprint !== this.dependencies.toolchainFingerprint) throw new Error("render_input_invalid");
      const encoded = await encodeRenderExecutionInput(input);
      const key = await this.domain.planInputWrite(reference, ready.preparationId);
      const stored = await this.dependencies.inputStorage.write(key, encoded.bytes);
      if (stored.byteLength !== encoded.byteLength || stored.sha256 !== encoded.sha256 || !/^"[^\r\n"]+"$/.test(stored.etag)) throw new Error("render_input_invalid");
      await this.domain.adoptInput(reference, ready.preparationId, { storageKey: key, ...stored });
    }
    const prepared = await this.domain.admitPreparedExecution(reference);
    if (prepared.kind === "waiting") await this.dependencies.register(prepared.dispatchIds);
    return prepared;
  }
}

/** Same capsule drives provenance, current output assignments and exact scoped reads. */
export function createRenderGroupExecution(options: {
  database: PrismaClient; service: RenderGroupExecutionService; storage: ReturnType<typeof createExecutionStorage>;
  artifacts: { head(assignment: Readonly<ExecutionArtifact>): Promise<ExecutorArtifactHead | null>; readJson(artifact: ExecutorArtifactCommit, maxBytes: number): Promise<unknown> };
  deliverWakes(ids: readonly string[]): Promise<void>;
}) {
  const { service, database } = options;
  const control = createExecutorControl({ database, subjectKind: "render_group", domain: service.domain,
    prepareContext: async attempt => {
      const input = await service.loadInput(attempt);
      const raw = new TextEncoder().encode(`${input.preparation.source.storageKey}#${input.preparation.source.byteLength}`);
      const source = await sha256Hex(raw);
      return { source, analysis: input.preparation.bindingHash, toolchain: input.preparation.toolchainFingerprint };
    }, artifacts: { head: options.artifacts.head, prepare: async (assignment, artifact, reported) => {
      const attempt = await database.executionAttempt.findUniqueOrThrow({ where: { attemptToken: assignment.attemptToken } });
      const input = await service.loadInput(attempt);
      return prepareRenderArtifact(artifact, reported, { inputHash: attempt.inputHash, memberIds: input.variants.map(variant => variant.renderId),
        stockCredits: input.autoBroll.resolved.map(slot => slot.attribution), readJson: options.artifacts.readJson });
    } }, deliverWakes: options.deliverWakes,
  });
  const transfer = createExecutionTransfer({ database, authority: control, storage: options.storage,
    preparePackage: (command, verified) => service.preloadInput(command.fence, command.action === "source-read", verified),
    resolvePackageWithinAuthority: async (_tx, authority, ref, prepared) => {
    if (authority.functionName !== "render_group" || authority.fence.reference.kind !== "modal_execution" || authority.fence.reference.subject.kind !== "render_group" || !authority.input) throw new ExecutorControlError("invalid_reference");
    const work = ref.work;
    if (!prepared || !work?.input || !work.pending.length ||
      [authority.input, work.input].some(tuple => tuple.storageKey !== prepared.tuple.storageKey || tuple.etag !== prepared.tuple.etag ||
        Number(tuple.byteLength) !== prepared.tuple.byteLength || tuple.sha256 !== prepared.tuple.sha256)) throw new ExecutorControlError("authority_lost");
    const input = prepared.input, configuration: unknown = JSON.parse(work.exportIdentity);
    if (input.groupId !== ref.groupId || input.workflowRunId !== ref.workflowRunId || input.workSetGeneration !== ref.workSetGeneration ||
      input.preparation.projectId !== ref.projectId || input.preparation.clipId !== work.clipId || input.preparation.preparationId !== work.preparationId || input.preparation.bindingHash !== work.bindingHash ||
      input.preparation.sourceRevision !== work.sourceRevision || input.preparation.source.storageKey !== work.sourceStorageKey ||
      !Array.isArray(configuration) || configuration.length !== 5 || input.preparation.editorRevision !== configuration[2] || input.watermark !== configuration[4] ||
      (configuration[0] === "automatic" && work.editorRevision !== input.preparation.editorRevision)) throw new ExecutorControlError("authority_lost");
    const pending = work.pending;
    if (pending.some(member => {
      const variant = input.variants.find(value => value.renderId === member.id);
      return !variant || variant.aspectRatio !== member.aspectRatio || variant.resolution !== member.resolution || variant.exportVariantId !== member.exportVariantId ||
        (variant.export?.id ?? null) !== configuration[1] || (variant.export && variant.export.watermark !== configuration[4]);
    })) throw new ExecutorControlError("authority_lost");
    const outputs = await Promise.all(pending.flatMap(variant => (["render_variant", "render_outcome"] as const).map(async role => ({ role, bindingHash: await renderArtifactBindingHash({ inputHash: authority.fence.reference.inputHash, renderId: variant.id, role }),
      contentType: role === "render_variant" ? "video/mp4" : "application/json", maxBytes: role === "render_variant" ? 10 * 1024 ** 3 : 65536 }))));
    const assets = [...input.assets.visuals, ...input.assets.fonts, ...input.assets.audio, ...(input.assets.logo ? [input.assets.logo] : [])];
    return { input: { kind: "object" }, outputs, initialSourceNames: ["original"], sources: [{ name: "original", ...input.preparation.source }, ...assets.map(asset => ({ name: asset.name, ...asset.object }))],
      ...(work.retentionExpiresAt ? { permissionExpiresAt: work.retentionExpiresAt } : {}) };
  } });
  return { control, transfer, prepareExecution: service.prepareExecution.bind(service) };
}
