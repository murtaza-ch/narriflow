import type { ContentPack } from "@narriflow/validators";
import type { DetectedClipArtifactInput } from "./workflow-run-lifecycle";
import type { ClipSelectionObjectReference } from "./clip-selection-window";

export interface ClipSelectionFinalizationProof {
  selectionHash: string;
  input: ClipSelectionObjectReference;
  windows: Array<{ id: string; generation: number; windowIndex: number; result: ClipSelectionObjectReference; tokensUsed: number; providerRequestId: string | null }>;
}
/** Constructed from verified private objects outside the authority transaction. */
export interface PreparedClipSelectionFinalization {
  proof: ClipSelectionFinalizationProof;
  outcome: { kind: "clips"; clips: DetectedClipArtifactInput[]; contentPack: ContentPack }
    | { kind: "failure"; code: "no_clips_detected" | "selection_input_invalid" | "selection_result_invalid" };
}
export type ClipSelectionFinalizationResult = { kind: "completed" | "failed" | "cancelled" | "superseded" | "not_prepared"; dispatchIds: string[] }
  | { kind: "wait"; dueAt: Date; dispatchIds: string[] };
