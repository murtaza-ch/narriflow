function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Accepted work refreshes through its exact Operation Status. Tool input and
 * safe operation metadata retain that identity even when the negotiated Tasks
 * result contains a flat task handle. Only a Project snapshot refreshes itself. */
export function narriflowProgressRequest(payload: Record<string, unknown>, input: Record<string, unknown>, metadata: Record<string, unknown>) {
  const reference = record(payload.operation);
  const requested = record(input.operation);
  const operation = record(metadata["narriflow/operation"]);
  const project = record(payload.project);
  const workspaceId = input.workspaceId ?? operation.workspaceId ?? payload.workspaceId ?? project.workspaceId;
  const kind = reference.kind ?? operation.domainKind ?? requested.kind;
  const id = reference.id ?? operation.domainId ?? requested.id;
  if (kind || id) {
    if (!kind || !id) throw new Error("Operation status is unavailable. Open Narriflow to review this work.");
    return { name: "narriflow_get_operation", arguments: { ...(workspaceId ? { workspaceId } : {}), operation: { kind, id } } };
  }
  const projectId = project.projectId ?? payload.projectId ?? input.projectId;
  if (!projectId) throw new Error("Project status is unavailable. Open Narriflow to review this operation.");
  return { name: "narriflow_get_project", arguments: { ...(workspaceId ? { workspaceId } : {}), projectId } };
}
