"use client";

import { CLIENT_ERROR_CODES, invalidateScoped } from "@narriflow/api-client/core";
import { ingestKeys, ingestSnapshotQueryOptions } from "@narriflow/api-client/ingest";
import { useProgressStream } from "@narriflow/api-client/progress";
import type { WorkflowStageUpdatedEvent } from "@narriflow/validators";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApiRuntime } from "@/app/_components/api-provider";
import { useIntake } from "./intake-context";

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

/** The stream is the signal; the snapshot only covers a stream that is down or an event that never arrived. */
const INGEST_SNAPSHOT_POLL_MS = 5_000;

/**
 * Subscriber for the pinned import pill + Configure-step CTA. It joins the
 * Project's shared progress stream (the same single connection the Project and
 * export pages use) and derives ingest stage words + terminal state from
 * `workflow.stage.updated` events. While the import is not terminal it also
 * polls the intake snapshot, so the pill and CTA still settle when the stream
 * is unavailable. It leaves both on the first terminal (ready/failed) state and
 * never joins while the current `initial.ingestStatus` is already terminal.
 *
 * `attempt` counts accepted retries. Every change of `initial` or `attempt`
 * resets local state to `initial` and joins again, even when the new `initial`
 * equals the old one (a retry hands over the same queued/null a fresh import
 * starts with). The hook resumes after the newest event it has applied, not
 * from the start of the log, so the failure that Retry replaced is never
 * replayed, and a snapshot read before the reset is never applied.
 */
export function useIngestStream(
  projectId: string,
  initial: IngestStreamState,
  { attempt = 0, pollMs = INGEST_SNAPSHOT_POLL_MS }: { attempt?: number; pollMs?: number } = {},
): IngestStreamState {
  const runtime = useApiRuntime();
  const { scope, transport } = useIntake();
  const { userId, workspaceId } = scope;
  const [state, setState] = useState<IngestStreamState>(initial);
  const [done, setDone] = useState(isTerminal(initial.ingestStatus));
  const cursor = useRef(0);
  const resetAt = useRef(0);
  const doneRef = useRef(done);
  doneRef.current = done;

  const snapshotOptions = ingestSnapshotQueryOptions({ transport, scope, projectId });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the trigger, not an input: each accepted retry resets even when `initial` is unchanged.
  useEffect(() => {
    resetAt.current = Date.now();
    // A read that started before this reset may still describe the import that failed.
    void runtime.queryClient.cancelQueries({ queryKey: ingestKeys.snapshot({ userId, workspaceId }, projectId) });
    setState({ ingestStatus: initial.ingestStatus, errorCode: initial.errorCode });
    setDone(isTerminal(initial.ingestStatus));
  }, [initial.ingestStatus, initial.errorCode, attempt, runtime, userId, workspaceId, projectId]);

  const snapshot = useQuery({
    ...snapshotOptions,
    enabled: !done,
    refetchInterval: pollMs,
  });
  const { data: snapshotData, dataUpdatedAt } = snapshot;
  useEffect(() => {
    if (!snapshotData || !("project" in snapshotData) || doneRef.current || dataUpdatedAt <= resetAt.current) return;
    // Older than an event already applied: the stream is ahead of this read.
    if (snapshotData.lastSeq < cursor.current) return;
    const status = snapshotIngestStatus(snapshotData.project.ingestStatus);
    setState({ ingestStatus: status, errorCode: status === "failed" ? snapshotData.project.ingestErrorCode : null });
    setDone(isTerminal(status));
  }, [snapshotData, dataUpdatedAt]);

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
    void invalidateScoped(runtime.queryClient, scope, "ingest");
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

function snapshotIngestStatus(status: string): IngestStageStatus {
  return status === "downloading" || status === "normalizing" || status === "ready" || status === "failed" ? status : "queued";
}

export function ingestStageWord(status: IngestStageStatus): string {
  if (status === "queued") return "Queued";
  if (status === "downloading") return "Downloading";
  if (status === "normalizing") return "Normalizing";
  if (status === "ready") return "Ready";
  return "Failed";
}
