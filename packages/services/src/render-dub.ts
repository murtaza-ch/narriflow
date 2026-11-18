import type { ClipDub, ExecutionArtifact } from "@prisma/client";
import { dubbingCheckpointSchema } from "@narriflow/validators/dubbing-execution";
import type { RenderDub } from "@narriflow/validators/render-execution";
import type { ExecutorArtifactCommit } from "./executor-domain-control";
import { DUBBING_STAGE_OUTPUTS, dubbingArtifactBindingHash, type DubbingArtifactStage } from "./dubbing-policy";

type DubRow = Pick<ClipDub, "id" | "projectId" | "clipId" | "status" | "targetLanguageCode" | "requestHash" | "editorRevision" | "audioStorageKey" | "audioArtifactId" | "timingArtifactId">;
type ArtifactRow = Pick<ExecutionArtifact, "id" | "role" | "bindingHash" | "storageKey" | "contentType" | "byteLength" | "checksumSha256" | "etag" | "committedAt">;

/** The dub a video export renders with, as the render group's snapshot reads it. */
export interface RenderDubSource {
  dub: DubRow;
  audio: ArtifactRow;
  timing: ArtifactRow;
}

const invalid = () => new Error("render_input_invalid");

/** One committed checkpoint object of the dub, exactly as its stage defines it. */
async function committed(row: ArtifactRow | undefined, id: string | null, requestHash: string, stage: DubbingArtifactStage) {
  const policy = DUBBING_STAGE_OUTPUTS[stage];
  if (!row || row.id !== id || !row.committedAt || row.role !== policy.role || row.contentType !== policy.contentType ||
    row.bindingHash !== await dubbingArtifactBindingHash(requestHash, stage) || !row.etag || !row.checksumSha256 || !row.byteLength ||
    row.byteLength > BigInt(policy.maxBytes)) throw invalid();
  return { storageKey: row.storageKey, etag: row.etag, byteLength: Number(row.byteLength), sha256: row.checksumSha256 };
}

/** The dub must be the completed dub of this clip's revision with both
 * artifacts sealed; anything else is a snapshot that must not render. */
export async function verifyRenderDub(source: RenderDubSource, expected: { projectId: string; clipId: string; editorRevision: number }) {
  const { dub } = source;
  if (dub.status !== "completed" || dub.projectId !== expected.projectId || dub.clipId !== expected.clipId || dub.editorRevision !== expected.editorRevision ||
    !dub.requestHash || !dub.audioStorageKey) throw invalid();
  const audio = await committed(source.audio, dub.audioArtifactId, dub.requestHash, "audio");
  if (audio.storageKey !== dub.audioStorageKey) throw invalid();
  const timing = await committed(source.timing, dub.timingArtifactId, dub.requestHash, "timing");
  return { audio, timing };
}

/** The timing artifact as the readers of an assigned artifact take it. */
export function renderDubTimingArtifact(row: ArtifactRow): ExecutorArtifactCommit {
  if (!row.etag || !row.checksumSha256 || !row.byteLength) throw invalid();
  return { artifactId: row.id, role: "probe", storageKey: row.storageKey, contentType: row.contentType, byteLength: row.byteLength,
    sha256: row.checksumSha256, etag: row.etag, bindingHash: row.bindingHash };
}

/** The caption words of the committed `timing` evidence, one array per sentence. */
export function renderDubSegments(evidence: unknown, dub: Pick<ClipDub, "id" | "requestHash">): RenderDub["segments"] {
  const checkpoint = dubbingCheckpointSchema.parse(evidence);
  if (checkpoint.stage !== "timing" || checkpoint.dubId !== dub.id || checkpoint.requestHash !== dub.requestHash) throw invalid();
  return checkpoint.segments.map(segment => segment.words.map(word => ({ text: word.text, spaceBefore: word.spaceBefore, startSec: word.startSec, endSec: word.endSec })));
}
