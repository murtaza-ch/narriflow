"use client";

import { projectQueries, invalidateProject } from "@narriflow/api-client/projects";
import { useQuery } from "@tanstack/react-query";
import { skipToken } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useClipApi } from "@/lib/clip-media";
import type { ProjectFinishingView } from "./finishing-status";

/** What the page shows of a finishing run: when this changes, the page has fallen behind. */
export function finishingSignature(finishing: ProjectFinishingView): string {
  return [
    finishing.id,
    finishing.state,
    ...finishing.clips.map((clip) => `${clip.clipId}:${clip.exportId ?? ""}:${clip.exportStatus ?? ""}:${clip.copyWritten}`),
  ].join("|");
}

/**
 * Finishing writes no Project events, so a page showing it as working asks
 * again every so often until it ends. Only a changed answer refreshes the
 * Project's reads; an unchanged one costs a single small request.
 */
export function FinishingAutoRefresh({
  projectId,
  shown,
  everyMs = 15_000,
}: {
  projectId: string;
  /** The finishing state the page currently renders. */
  shown: ProjectFinishingView;
  everyMs?: number;
}) {
  const api = useClipApi();
  const options = api ? projectQueries.finishing(api.projects, api.scope, projectId) : null;
  const poll = useQuery({
    queryKey: options?.queryKey ?? ["nf", "projects", "finishing", "unavailable"],
    queryFn: options?.queryFn ?? skipToken,
    refetchInterval: everyMs,
    refetchIntervalInBackground: false,
  });

  const shownSignature = finishingSignature(shown);
  const answer = poll.data?.finishing;
  const answerSignature = answer ? finishingSignature(answer) : null;
  const refreshedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!api || !answerSignature || answerSignature === shownSignature) return;
    if (refreshedFor.current === answerSignature) return;
    refreshedFor.current = answerSignature;
    void invalidateProject(api.queryClient, api.scope, projectId);
  }, [api, answerSignature, shownSignature, projectId]);
  return null;
}
