import { notFound } from "next/navigation";
import { requireCurrentAppUser } from "@narriflow/auth";
import {
  clipService,
  projectService,
  presignDownloadUrl,
} from "@narriflow/services";
import type { TranscriptUtterance, CaptionPreset } from "@narriflow/validators";
import {
  DEFAULT_CAPTION_PRESET,
  getEffectiveClipTiming,
  studioEditsSchema,
} from "@narriflow/validators";
import { StudioShell } from "./_components/studio-shell";
import type { ClipInfo, TimelineSegment } from "./_components/studio-shell";

function clampTimelineTime(timeSec: number, clipDurationSec: number) {
  return Math.max(0, Math.min(clipDurationSec, timeSec));
}

/** First words of the utterance — the segment's on-timeline label. */
function segmentLabel(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean).slice(0, 3).join(" ");
  return words || "Segment";
}

function buildSegmentsFromUtterances(
  utterances: TranscriptUtterance[],
  clipStartSec: number,
  clipDurationSec: number,
): TimelineSegment[] {
  if (utterances.length === 0) {
    return [{ id: "seg-0", label: "Clip", startSec: 0, endSec: clipDurationSec }];
  }

  const segments: TimelineSegment[] = [];
  let cursorSec = 0;

  for (let i = 0; i < utterances.length; i++) {
    const utterance = utterances[i]!;
    const nextUtterance = utterances[i + 1];
    const nextBoundarySec = nextUtterance
      ? clampTimelineTime(nextUtterance.startSec - clipStartSec, clipDurationSec)
      : clipDurationSec;
    const endSec = Math.max(cursorSec, nextBoundarySec);

    segments.push({
      id: `seg-${i}`,
      label: segmentLabel(utterance.text),
      startSec: cursorSec,
      endSec,
    });

    cursorSec = endSec;
  }

  return segments.filter((segment) => segment.endSec > segment.startSec);
}

export default async function StudioPage({
  params,
}: {
  params: Promise<{ projectId: string; clipId: string }>;
}) {
  const appUser = await requireCurrentAppUser();
  const { projectId, clipId } = await params;

  const [snapshot, clips, previewSource] = await Promise.all([
    projectService.getProjectSnapshot(appUser.id, projectId),
    clipService.listClips(appUser.id, projectId),
    clipService.getClipPreviewSource(appUser.id, projectId, clipId),
  ]);

  if (!snapshot.project) notFound();

  const clip = clips.find((c) => c.id === clipId);
  if (!clip) notFound();

  // Presign source video URL (works for both uploads and YouTube — both stored in R2)
  let sourceVideoUrl: string | null = null;
  if (snapshot.project.sourceStorageKey) {
    try {
      sourceVideoUrl = await presignDownloadUrl({
        key: snapshot.project.sourceStorageKey,
        expiresIn: 3600,
      });
    } catch {
      // Non-fatal
    }
  }

  // tailPadSec 0 — slice-only input: stored bounds are final (must stay in
  // lockstep with toClipSnapshot/preview/render or the studio timeline shows
  // a different duration than the rendered clip).
  const effective = getEffectiveClipTiming({
    utterances: clip.transcriptSlice,
    startSec: clip.startSec,
    endSec: clip.endSec,
    sourceDurationSec: snapshot.project.sourceDurationSeconds,
    tailPadSec: 0,
  });
  const utterances = effective.transcriptSlice;

  const captionPreset: CaptionPreset = clip.captionPreset
    ? { ...DEFAULT_CAPTION_PRESET, ...clip.captionPreset }
    : DEFAULT_CAPTION_PRESET;
  const initialStudioEdits = studioEditsSchema.parse(clip.studioEdits ?? {});

  const clipInfo: ClipInfo = {
    id: clip.id,
    projectId: clip.projectId,
    title: clip.hookText,
    clipTitle: clip.title,
    duration: effective.durationSec,
    startSec: effective.startSec,
    endSec: effective.endSec,
    aspectRatio: clip.renderVariants[0]?.aspectRatio ?? "9:16",
    viralityScore: clip.viralityScore,
    category: clip.category,
    brollUrl: clip.brollUrl ?? null,
  };

  /**
   * Server Action — re-checks whether this clip's preview proxy has landed
   * yet. A thin wrapper around the exact same `getClipPreviewSource` call
   * this page makes above for its own first render, so studio-shell.tsx's
   * poll effect and the initial SSR paint always agree on what "ready"
   * means. Bound to the authenticated user/project/clip via closure (not a
   * client-supplied id), so polling can't be used to probe another user's
   * clip.
   *
   * Passed down as a prop rather than imported by name into the (client)
   * studio-shell.tsx: a Server Action importable-by-name from a Client
   * Component has to live in a module with a top-of-file "use server"
   * directive, and this page is a regular Server Component, not that — the
   * documented mechanism for a Server-Component-local action is to hand it
   * down as a prop instead.
   */
  async function fetchPreviewStatus() {
    "use server";
    return clipService.getClipPreviewSource(appUser.id, projectId, clipId);
  }

  return (
    <StudioShell
      clipInfo={clipInfo}
      transcript={utterances}
      timelineSegments={buildSegmentsFromUtterances(
        utterances,
        effective.startSec,
        effective.durationSec,
      )}
      initialCaptionPreset={captionPreset}
      initialStudioEdits={initialStudioEdits}
      sourceVideoUrl={sourceVideoUrl}
      sourcePreviewId={snapshot.project.sourceStorageKey ?? snapshot.project.id}
      clipStartSec={effective.startSec}
      clipEndSec={effective.endSec}
      previewVideoUrl={previewSource.previewUrl}
      previewStartSec={previewSource.previewStartSec}
      // Once the source is purged, a still-missing proxy can never arrive —
      // the worker that cuts it reads straight from source storage — so the
      // studio shows a terminal message instead of polling/spinning forever.
      sourcePurged={!snapshot.project.sourceStorageKey}
      fetchPreviewStatus={fetchPreviewStatus}
    />
  );
}
