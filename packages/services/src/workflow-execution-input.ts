/** Frozen server-derived provenance. No callback or scheduler payload chooses it. */
export interface WorkflowRunExecutionInput {
  id: string;
  projectId: string;
  stage: string;
  contentPackId: string | null;
  generation: number;
  deploymentEpoch: number;
  sourceAudioId: string | null;
  sourceRevision: number;
}

export async function workflowRunExecutionInputHash(input: WorkflowRunExecutionInput): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({
    id: input.id, projectId: input.projectId, stage: input.stage, contentPackId: input.contentPackId,
    generation: input.generation, deploymentEpoch: input.deploymentEpoch,
    sourceAudioId: input.sourceAudioId, sourceRevision: input.sourceRevision,
  }));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}
