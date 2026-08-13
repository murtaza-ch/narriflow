"use client";

import { useEffect, useState } from "react";
import { parseWorkflowEventMessage } from "@/lib/project-state";

export type IngestStageStatus =
  | "queued"
  | "downloading"
  | "normalizing"
  | "ready"
  | "failed";

export interface IngestStreamState {
  ingestStatus: IngestStageStatus;
  errorCode: string | null;
}

/**
 * Minimal local subscriber for the pinned import pill + Configure-step CTA:
 * connects to the project's existing `/api/stream/[projectId]` SSE route
 * (see `projects/[projectId]/project-events.tsx` for the fuller consumer —
 * not imported here since that file lives outside this phase's file
 * ownership) and derives ingest stage words + terminal state from
 * `workflow.stage.updated` events. Connects once per distinct server-provided
 * `initial.ingestStatus` and self-closes on the first terminal (ready/failed)
 * event for that connection; never opens a connection at all while the
 * current `initial.ingestStatus` is already terminal.
 *
 * Re-keying the effect on `initial.ingestStatus` (rather than latching a ref
 * on mount) is what makes Retry work: `retryIngestFormAction` +
 * `router.refresh()` re-renders this component's server parent with a fresh
 * non-terminal `ingestStatus` prop, and that prop change must reopen the
 * stream instead of leaving the previous terminal ("failed") state stuck —
 * a plain `useRef` computed once at mount could never see that change.
 */
export function useIngestStream(
  projectId: string,
  initial: IngestStreamState,
): IngestStreamState {
  const [state, setState] = useState<IngestStreamState>(initial);

  // The server-provided status is the source of truth for what "current"
  // means: whenever it changes (a fresh render with a new prop, e.g. after
  // Retry), reset local state to match it before deciding whether to
  // (re)connect. This also covers the retry case where the new status is
  // itself non-terminal (e.g. "queued") but no live event has arrived yet.
  useEffect(() => {
    setState({
      ingestStatus: initial.ingestStatus,
      errorCode: initial.errorCode,
    });
  }, [initial.ingestStatus, initial.errorCode]);

  useEffect(() => {
    if (initial.ingestStatus === "ready" || initial.ingestStatus === "failed") return;

    let closed = false;
    const source = new EventSource(`/api/stream/${projectId}?sinceSeq=0`);

    const onWorkflowUpdate = (event: MessageEvent<string>) => {
      if (closed) return;
      const parsed = parseWorkflowEventMessage(event.data);
      if (!parsed || parsed.projectId !== projectId) return;
      if (!parsed.stage.startsWith("ingest")) return;

      if (parsed.status === "failed") {
        setState({ ingestStatus: "failed", errorCode: parsed.errorCode });
        closed = true;
        source.close();
        return;
      }
      if (parsed.stage === "ingest_ready" && parsed.status === "completed") {
        setState({ ingestStatus: "ready", errorCode: null });
        closed = true;
        source.close();
        return;
      }
      if (parsed.stage === "ingest_queued") {
        setState({ ingestStatus: "queued", errorCode: null });
      } else if (parsed.stage === "ingest_downloading") {
        setState({ ingestStatus: "downloading", errorCode: null });
      } else if (parsed.stage === "ingest_normalizing") {
        setState({ ingestStatus: "normalizing", errorCode: null });
      }
    };

    source.addEventListener("workflow.stage.updated", onWorkflowUpdate as EventListener);

    return () => {
      closed = true;
      source.removeEventListener("workflow.stage.updated", onWorkflowUpdate as EventListener);
      source.close();
    };
    // [projectId, initial.ingestStatus] — NOT `state`/`isCurrentInitialTerminal`
    // derived from it: reconnecting on every locally-derived status change
    // (each live event this effect itself sets) would drop and re-replay the
    // stream for no benefit. `initial.ingestStatus` is the one value that
    // must reopen the connection when it changes, since it is the only signal
    // that the server has fresh, authoritative state (e.g. Retry) — the
    // effect otherwise closes itself the moment a terminal event lands.
  }, [projectId, initial.ingestStatus]);

  return state;
}

export function ingestStageWord(status: IngestStageStatus): string {
  if (status === "queued") return "Queued";
  if (status === "downloading") return "Downloading";
  if (status === "normalizing") return "Normalizing";
  if (status === "ready") return "Ready";
  return "Failed";
}
