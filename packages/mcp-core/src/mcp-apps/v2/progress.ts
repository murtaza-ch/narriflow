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

const SETTLED_OPERATION_STATES = ["completed", "partial", "failed", "cancelled"];
const SETTLED_EXPORT_STATUSES = ["ready", "failed"];
const SETTLED_PROJECT_STATUSES = ["ready", "completed", "failed", "cancelled"];

/** Whether this snapshot can still change. A `partial_ready` export counts as
 * live: Operation Status decides that one on the next read. */
export function progressIsLive(payload: Record<string, unknown>) {
  if (typeof payload.state === "string") return !SETTLED_OPERATION_STATES.includes(payload.state);
  if (payload.export) return !SETTLED_EXPORT_STATUSES.includes(String(record(payload.export).status));
  const status = record(payload.progress).status ?? payload.status;
  return typeof status === "string" && !SETTLED_PROJECT_STATUSES.includes(status);
}

function workId(payload: Record<string, unknown>) {
  return record(payload.operation).id ?? record(payload.export).exportId;
}

/** The host keeps the tool's original result and can deliver it again whenever it
 * re-renders the card. That old snapshot must not undo a finished state. */
export function isStaleProgressReplay(current: Record<string, unknown>, incoming: Record<string, unknown>) {
  const id = workId(current);
  return id !== undefined && id === workId(incoming) && !progressIsLive(current) && progressIsLive(incoming);
}

const PROGRESS_FAST_ATTEMPTS = 20;
const PROGRESS_MAX_ATTEMPTS = 200;
/** Read at once, because the card may be replaying an old result. Then quickly for
 * a minute, then gently. Null stops following: the button still works. */
export function progressRefreshDelayMs(attempt: number): number | null {
  if (attempt === 0) return 0;
  if (attempt >= PROGRESS_MAX_ATTEMPTS) return null;
  return attempt <= PROGRESS_FAST_ATTEMPTS ? 3_000 : 15_000;
}

/** What a finished operation can show in place: an export's files or a run's ranked clips. */
export function progressOutcomeRequest(payload: Record<string, unknown>, input: Record<string, unknown>, metadata: Record<string, unknown>) {
  const reference = record(payload.operation);
  const operation = record(metadata["narriflow/operation"]);
  const results = record(payload.results);
  const exported = record(payload.export);
  const workspaceId = input.workspaceId ?? operation.workspaceId ?? metadata.workspaceId;
  const scope = workspaceId ? { workspaceId } : {};
  const finished = payload.state === "completed" || payload.state === "partial" || exported.status === "ready";
  if (!finished) return null;
  const exportId = results.exportId ?? exported.exportId;
  if (exportId) return { name: "narriflow_get_export_download", arguments: { ...scope, exportId } };
  const projectId = results.projectId ?? payload.projectId ?? operation.projectId;
  if ((reference.kind ?? operation.domainKind) === "generation" && projectId) return { name: "narriflow_list_clips", arguments: { ...scope, projectId, limit: 10 } };
  return null;
}
