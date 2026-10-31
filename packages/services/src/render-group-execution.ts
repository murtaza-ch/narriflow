import type { ExecutionArtifact, ExecutionAttempt, PrismaClient } from "@prisma/client";
import type { ExecutionDispatchReference } from "@narriflow/validators/execution";
import type { ClipPreparationInput, ClipPreparationObject } from "@narriflow/validators/clip-preparation";
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
  constructor(database: PrismaClient, private readonly dependencies: RenderGroupExecutionDependencies) {
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
      if (admission.kind !== "ready") return { kind: "sleep", dueAt: initial.deadlineAt };
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
      const source = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", raw)), byte => byte.toString(16).padStart(2, "0")).join("");
      return { source, analysis: input.preparation.bindingHash, toolchain: input.preparation.toolchainFingerprint };
    }, artifacts: { head: options.artifacts.head, prepare: async (assignment, artifact, reported) => {
      const attempt = await database.executionAttempt.findUniqueOrThrow({ where: { attemptToken: assignment.attemptToken } });
      const input = await service.loadInput(attempt);
      return prepareRenderArtifact(artifact, reported, { inputHash: attempt.inputHash, memberIds: input.variants.map(variant => variant.renderId),
        stockCredits: input.autoBroll.resolved.map(slot => slot.attribution), readJson: options.artifacts.readJson });
    } }, deliverWakes: options.deliverWakes,
  });
  const transfer = createExecutionTransfer({ database, authority: control, storage: options.storage, resolvePackage: async authority => {
    if (authority.functionName !== "render_group" || authority.fence.reference.kind !== "modal_execution" || authority.fence.reference.subject.kind !== "render_group" || !authority.input) throw new ExecutorControlError("invalid_reference");
    const input = await service.loadInput({ inputStorageKey: authority.input.storageKey, inputEtag: authority.input.etag, inputByteLength: authority.input.byteLength, inputChecksumSha256: authority.input.sha256 });
    if (input.groupId !== authority.fence.reference.subject.id) throw new ExecutorControlError("invalid_reference");
    const members = await database.renderGroupMember.findMany({ where: { groupId: input.groupId, invalidatedAt: null }, select: { clipRenderId: true } });
    const ids = members.filter(member => input.variants.some(variant => variant.renderId === member.clipRenderId)).map(member => member.clipRenderId);
    const pending = await database.clipRender.findMany({ where: { id: { in: ids }, status: { in: ["pending", "rendering"] }, workflowRunId: input.workflowRunId }, select: { id: true } });
    const outputs = await Promise.all(pending.flatMap(variant => (["render_variant", "render_outcome"] as const).map(async role => ({ role, bindingHash: await renderArtifactBindingHash({ inputHash: authority.fence.reference.inputHash, renderId: variant.id, role }),
      contentType: role === "render_variant" ? "video/mp4" : "application/json", maxBytes: role === "render_variant" ? 10 * 1024 ** 3 : 65536 }))));
    const assets = [...input.assets.visuals, ...input.assets.fonts, ...input.assets.audio, ...(input.assets.logo ? [input.assets.logo] : [])];
    return { input: { kind: "object" }, outputs, sources: [{ name: "original", ...input.preparation.source }, ...assets.map(asset => ({ name: asset.name, ...asset.object }))] };
  } });
  return { control, transfer, prepareExecution: service.prepareExecution.bind(service) };
}
