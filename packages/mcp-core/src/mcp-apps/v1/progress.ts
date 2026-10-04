function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Tool input and safe operation metadata retain status identity even when
 * the negotiated Tasks result contains a flat task handle. */
export function narriflowProgressRequest(payload: Record<string, unknown>, input: Record<string, unknown>, metadata: Record<string, unknown>) {
  const operation = record(metadata["narriflow/operation"]);
  const exported = record(payload.export);
  const project = record(payload.project);
  const workspaceId = input.workspaceId ?? operation.workspaceId ?? payload.workspaceId ?? project.workspaceId;
  const projectId = exported.projectId ?? project.projectId ?? payload.projectId ?? operation.projectId ?? input.projectId;
  if (exported.exportId || operation.domainKind === "export") {
    const clipId = exported.clipId ?? operation.clipId ?? input.clipId;
    const exportId = exported.exportId ?? operation.domainId ?? input.exportId;
    if (!workspaceId || !projectId || !clipId || !exportId) throw new Error("Export status is unavailable. Open Narriflow to review this export.");
    return { name: "narriflow_get_clip_export", arguments: { workspaceId, projectId, clipId, exportId } };
  }
  if (!projectId) throw new Error("Project status is unavailable. Open Narriflow to review this operation.");
  return { name: "narriflow_get_project", arguments: { ...(workspaceId ? { workspaceId } : {}), projectId } };
}
