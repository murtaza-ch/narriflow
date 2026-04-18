import { notFound } from "next/navigation";
import { requireCurrentAppUser } from "@narriflow/auth";
import {
  clipService,
  projectService,
  presignDownloadUrl,
} from "@narriflow/services";
import type { TranscriptUtterance, CaptionPreset } from "@narriflow/validators";
import { getEffectiveClipTiming } from "@narriflow/validators";
import { StudioShell } from "./_components/studio-shell";
import type { ClipInfo, TimelineSegment } from "./_components/studio-shell";

const DEFAULT_CAPTION_PRESET: CaptionPreset = {
  fontName: "Bebas Neue",
  primaryColor: "#FFFFFF",
  outlineColor: "#000000",
  outlineWidth: 2,
  shadow: 1,
  bold: true,
  position: "bottom",
  highlightColor: "#00FF88",
  animation: "word-by-word",
  fontSize: 36,
};

function clampTimelineTime(timeSec: number, clipDurationSec: number) {
  return Math.max(0, Math.min(clipDurationSec, timeSec));
}

function buildSegmentsFromUtterances(
  utterances: TranscriptUtterance[],
  clipStartSec: number,
  clipDurationSec: number,
): TimelineSegment[] {
  if (utterances.length === 0) {
    return [{ id: "seg-0", label: "Fill", startSec: 0, endSec: clipDurationSec }];
  }

  const segments: TimelineSegment[] = [];
  let cursorSec = 0;

  for (let i = 0; i < utterances.length; i++) {
    const nextUtterance = utterances[i + 1];
    const nextBoundarySec = nextUtterance
      ? clampTimelineTime(nextUtterance.startSec - clipStartSec, clipDurationSec)
      : clipDurationSec;
    const endSec = Math.max(cursorSec, nextBoundarySec);

    segments.push({
      id: `seg-${i}`,
      label: "Fill",
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

  const [snapshot, clips] = await Promise.all([
    projectService.getProjectSnapshot(appUser.id, projectId),
    clipService.listClips(appUser.id, projectId),
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

  const effective = getEffectiveClipTiming({
    utterances: clip.transcriptSlice,
    startSec: clip.startSec,
    endSec: clip.endSec,
    sourceDurationSec: snapshot.project.sourceDurationSeconds,
  });
  const utterances = effective.transcriptSlice;

  const captionPreset: CaptionPreset = clip.captionPreset
    ? { ...DEFAULT_CAPTION_PRESET, ...clip.captionPreset }
    : DEFAULT_CAPTION_PRESET;

  const clipInfo: ClipInfo = {
    id: clip.id,
    projectId: clip.projectId,
    title: clip.hookText,
    duration: effective.durationSec,
    startSec: effective.startSec,
    endSec: effective.endSec,
    aspectRatio: clip.renderVariants[0]?.aspectRatio ?? "9:16",
    viralityScore: clip.viralityScore,
    category: clip.category,
    credits: 10,
  };

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
      sourceVideoUrl={sourceVideoUrl}
      sourcePreviewId={snapshot.project.sourceStorageKey ?? snapshot.project.id}
      clipStartSec={effective.startSec}
      clipEndSec={effective.endSec}
    />
  );
}
