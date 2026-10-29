import { useEffect, useRef } from "react";
import type { ApiRuntime, WorkspaceScope } from "../core";
import { type ProgressHub, type ProgressSubscriber, createProgressHub } from "./hub";

const hubs = new WeakMap<ApiRuntime, ProgressHub>();

/** The one hub of an app instance (its runtime), created on first use. */
export function progressHubFor(runtime: ApiRuntime): ProgressHub {
  let hub = hubs.get(runtime);
  if (!hub) {
    hub = createProgressHub({ transport: runtime.transport, queryClient: runtime.queryClient });
    hubs.set(runtime, hub);
  }
  return hub;
}

export interface UseProgressStreamOptions extends ProgressSubscriber {
  /** Subscribe only while true (default true). */
  enabled?: boolean;
}

/**
 * Subscribes to a Project's progress for the life of the component. Handlers
 * and `sinceSeq` are read when they are needed, so a re-render never
 * reconnects; the subscription follows only the identity, Workspace, Project
 * and `enabled`. The connection itself is shared with every other consumer.
 */
export function useProgressStream(
  runtime: ApiRuntime,
  scope: WorkspaceScope | null,
  projectId: string | null,
  options: UseProgressStreamOptions,
): void {
  const latest = useRef(options);
  latest.current = options;
  const enabled = options.enabled ?? true;
  const userId = scope?.userId ?? null;
  const workspaceId = scope?.workspaceId ?? null;

  useEffect(() => {
    if (!enabled || userId === null || workspaceId === null || projectId === null) return;
    return progressHubFor(runtime).subscribe({ userId, workspaceId }, projectId, {
      sinceSeq: latest.current.sinceSeq ?? 0,
      onEvent: (event) => latest.current.onEvent?.(event),
      onOpen: (info) => latest.current.onOpen?.(info),
      onRevoked: (control) => latest.current.onRevoked?.(control),
      onFatal: (error) => latest.current.onFatal?.(error),
    });
  }, [runtime, enabled, userId, workspaceId, projectId]);
}
