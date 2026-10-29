"use client";

import { CLIENT_ERROR_CODES, invalidateScoped } from "@narriflow/api-client/core";
import { useProgressStream } from "@narriflow/api-client/progress";
import type { WorkflowStageUpdatedEvent } from "@narriflow/validators";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApiRuntime, useWorkspaceScope } from "@/app/_components/api-provider";

export type IngestStageStatus =
  "queued"
  | "downloading"
  | "normalizing"
  | "ready"
  | "failed";

export interface IngestStreamState {
  ingestStatus: IngestStageStatus;
  errorCode: string | null;
}

function isTerminal(status: IngestStageStatus): boolean {
  return status === "ready" || status === "failed";
}

/**
 * Subscriber for the pinned import pill + Configure-step CTA. It joins the
 * Project's shared progress stream (the same single connection the Project and
 * export pages use) and derives ingest stage words + terminal state from
 * `workflow.stage.updated` events. It leaves the stream on the first terminal
 * (ready/failed) state and never joins while the current `initial.ingestStatus`
 * is already terminal.
 *
 * The caller's `initial.ingestStatus` is the source of truth for what
 * "current" means: when it changes (Retry hands over a fresh `queued`), local
 * state resets to it and the hook joins again. It resumes after the newest
 * event it has applied, not from the start of the log, so the failure that
 * Retry replaced is never replayed.
 */
export function useIngestStream(
  projectId: string,
  initial: IngestStreamState,
): IngestStreamState {
  const runtime = useApiRuntime();
  const scope = useWorkspaceScope();
  const [state, setState] = useState<IngestStreamState>(initial);
  const [done, setDone] = useState(isTerminal(initial.ingestStatus));
  const cursor = useRef(0);

  useEffect(() => {
    setState({ ingestStatus: initial.ingestStatus, errorCode: initial.errorCode });
    setDone(isTerminal(initial.ingestStatus));
  }, [initial.ingestStatus, initial.errorCode]);

  const onEvent = useCallback(
    (event: WorkflowStageUpdatedEvent) => {
      cursor.current = Math.max(cursor.current, event.seq);
      if (event.projectId !== projectId || !event.stage.startsWith("ingest")) return;

      if (event.status === "failed") {
        setState({ ingestStatus: "failed", errorCode: event.errorCode });
        setDone(true);
      } else if (event.stage === "ingest_ready" && event.status === "completed") {
        setState({ ingestStatus: "ready", errorCode: null });
        setDone(true);
      } else if (event.stage === "ingest_queued") {
        setState({ ingestStatus: "queued", errorCode: null });
        setDone(false);
      } else if (event.stage === "ingest_downloading") {
        setState({ ingestStatus: "downloading", errorCode: null });
        setDone(false);
      } else if (event.stage === "ingest_normalizing") {
        setState({ ingestStatus: "normalizing", errorCode: null });
        setDone(false);
      }
    },
    [projectId],
  );

  // Access ended or the stream was refused: re-read the intake, whose own answer drives recovery.
  const reread = useCallback(() => {
    if (scope) void invalidateScoped(runtime.queryClient, scope, "ingest");
  }, [runtime, scope]);

  useProgressStream(runtime, scope, projectId, {
    enabled: !done,
    sinceSeq: cursor.current,
    onEvent,
    onRevoked: reread,
    onFatal: (error) => {
      if (error.code !== CLIENT_ERROR_CODES.scopeChanged) reread();
    },
  });

  return state;
}

export function ingestStageWord(status: IngestStageStatus): string {
  if (status === "queued") return "Queued";
  if (status === "downloading") return "Downloading";
  if (status === "normalizing") return "Normalizing";
  if (status === "ready") return "Ready";
  return "Failed";
}
