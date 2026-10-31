import type { SourceRange, TranscriptUtterance } from "@narriflow/validators";

/** Native analysis input retained until the standalone diagnostic wrapper is
 * ported to the single preparation producer. No field grants ownership. */
export interface ClipPendingAutoLayoutAnalysis {
  id: string;
  projectId: string;
  startSec: number;
  endSec: number;
  transcriptSlice: TranscriptUtterance[];
  deletedRanges: SourceRange[];
  editorRevision: number;
  previewStorageKey: string;
  previewStartSec: number;
  previewDurationSec: number;
  /** Native diagnostic correlation only. Publication requires the Core fence. */
  autoLayoutClaimToken: string;
  sourceStorageKey: string;
  leaseMs: number;
}


/** Frozen source observations supplied by the current immutable preparation.
 * The native consumer still validates source/window/editor/engine fingerprints. */
export interface DurableLayoutEvidence {
  automatic: unknown;
  screen: unknown;
  split: unknown;
}

export interface DurableLayoutEvidenceReader {
  readCompatibleDurable(clipId: string, frozen: { editorRevision: number; previewStorageKey: string }): Promise<DurableLayoutEvidence | null>;
}
