export interface GenerationTaskRun {
  id: string;
  stage: string;
  status: string;
  errorCode: string | null;
  idempotencyKey: string;
  contentPackId: string | null;
}

export interface GenerationTaskRender {
  id: string;
  status: string;
  errorCode: string | null;
  failureDisposition?: string | null;
}

/** The handoff freezes this generation's render IDs. First durable child
 * outcomes survive cache changes and exclude unrelated shared render work. */
export function generationTaskState(input: {
  origin: GenerationTaskRun;
  detection: GenerationTaskRun | null;
  renders: GenerationTaskRender[];
  renderRuns: GenerationTaskRun[];
  expectedRenderIds?: string[];
  renderOutcomes?: GenerationTaskRender[];
}) {
  const state = (status: string, cancelled = false) => ({ status, cancelled });
  const settledRun = (run: GenerationTaskRun) => {
    if (run.status === "cancelled" || run.errorCode === "MCP_CANCELLED") return state("cancelled", true);
    if (run.status === "failed") return state("failed");
    return state("working");
  };
  if (input.origin.status !== "completed") return settledRun(input.origin);
  const detection = input.detection;
  if (!detection || detection.stage !== "moment_detection" || detection.contentPackId !== input.origin.contentPackId ||
    detection.idempotencyKey !== `${input.origin.idempotencyKey}__moment_detection`) return state("working");
  if (detection.status !== "completed") return settledRun(detection);
  if (!input.expectedRenderIds) return state(input.renders.length ? "working" : "completed");
  const settled = new Map<string, GenerationTaskRender>();
  for (const outcome of input.renderOutcomes ?? []) if (!settled.has(outcome.id)) settled.set(outcome.id, outcome);
  const familyTerminal = input.renderRuns.length > 0 && input.renderRuns.every((run) => ["completed", "partial", "failed", "cancelled"].includes(run.status));
  const results = input.expectedRenderIds.map((id) => {
    const outcome = settled.get(id);
    if (outcome) return outcome;
    const current = input.renders.find((render) => render.id === id);
    return familyTerminal ? current : undefined;
  });
  if (results.some((render) => !render || !["completed", "failed"].includes(render.status))) {
    // Terminal work with a missing original artifact was superseded. A shared
    // run's unrelated success or failure cannot invent this generation's result.
    return state(familyTerminal ? "failed" : "working");
  }
  if (results.some((render) => render?.errorCode === "MCP_CANCELLED")) return state("cancelled", true);
  const failed = results.filter((render) => render?.status === "failed").length;
  return state(failed ? failed === results.length ? "failed" : "partial" : "completed");
}
