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
