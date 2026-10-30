import { extname } from "node:path";
import { deriveCaptionCues, formatSubtitles } from "@narriflow/composition-plan";
import { buildClipCutPlan, clipSourceEdgeSec, isStandardFrameRate, sourceProbeSchema, type ClipCutPlan, type SourceRange, type TimelineFormat } from "@narriflow/validators";
import { effectiveCaptionLanguage, resolveRenderedClipDocument } from "./clip-export-subtitles";
import { clipExportSubtitleBaseName, clipTitleSlug } from "./clip-export.service";
import { ClipTimelineError, renderTimeline, TIMELINE_CONTENT_TYPES, TIMELINE_FILE_EXTENSIONS, type TimelineCut } from "./timeline-export";

export interface ClipTimelineFile {
  fileName: string;
  contentType: string;
  content: string;
}

/** The original source file a timeline cuts, and the name the timeline and
 * its download share. Every clip of a project shares one source name. */
export function clipTimelineSource(project: { title: string; sourceStorageKey: string | null }) {
  if (!project.sourceStorageKey) {
    throw new ClipTimelineError("timeline_source_unavailable", "The original media for this project is no longer stored, so there is nothing for a timeline to cut");
  }
  const extension = extname(project.sourceStorageKey).toLowerCase();
  return {
    storageKey: project.sourceStorageKey,
    fileName: `${clipTitleSlug(project.title)}-source${/^\.[a-z0-9]{1,5}$/.test(extension) ? extension : ".mp4"}`,
  };
}

/** The cut plan's kept segments as timeline cuts. Each cut ends where the next
 * begins, so rounding to frames can never open a gap or an overlap. */
function timelineCuts(plan: ClipCutPlan): TimelineCut[] {
  return plan.segments.map((segment, index) => ({
    sourceStartSec: segment.sourceStartSec,
    editedStartSec: segment.editedStartSec,
    editedEndSec: plan.segments[index + 1]?.editedStartSec ?? plan.editedDurationSec,
  }));
}

/** What the cut plan removes from the clip's window: the explicit deletions
 * plus any kept range too short to render. Handing these to the caption cue
 * derivation as the document's deleted ranges times the cues on the plan's own
 * segments, so they stay aligned with the timeline. */
function planDeletions(plan: ClipCutPlan): SourceRange[] {
  const deletions: SourceRange[] = [];
  let cursor = plan.map.clipStartSec;
  for (const segment of plan.segments) {
    if (segment.sourceStartSec > cursor) deletions.push({ startSec: cursor, endSec: segment.sourceStartSec });
    cursor = segment.sourceEndSec;
  }
  if (plan.map.clipEndSec > cursor) deletions.push({ startSec: cursor, endSec: plan.map.clipEndSec });
  return deletions;
}

/** The files of one clip's editor timeline: the timeline cutting the original
 * source at the clip's kept ranges, and its captions as SRT. Both come from
 * the clip's render timing and cut plan, so they keep the footage and words an
 * export render keeps, and the captions are timed on the timeline's own cuts.
 * Scenes are not on the editor timeline, so captions are timed without them. */
export function clipTimelineFiles(input: {
  /** The stored clip, with every field its Clip Editor Document is read from. */
  clip: { title: string | null; hookText: string; editorRevision: number };
  project: {
    title: string;
    sourceStorageKey: string | null;
    sourceProbe: unknown;
    sourceDurationSeconds: number | null;
    languageCode?: string | null;
    transcript?: { languageCode: string | null } | null;
  };
  format: TimelineFormat;
}) {
  const { clip, project } = input;
  const source = clipTimelineSource(project);
  const probe = sourceProbeSchema.safeParse(project.sourceProbe);
  if (!probe.success) {
    throw new ClipTimelineError("timeline_source_unmeasured", "This video was imported before timeline export existed. Import it again to export a timeline");
  }
  const { video } = probe.data;
  if (!video) {
    throw new ClipTimelineError("timeline_video_required", "Timeline export needs a video source; this project's original media has no video");
  }
  if (!isStandardFrameRate(video.frameRate)) {
    const fps = Math.round((video.frameRate.numerator / video.frameRate.denominator) * 1000) / 1000;
    throw new ClipTimelineError("timeline_source_rate_unsupported",
      `This video's frame rate (${fps} fps) is not one editors share, so a timeline would not cut on the right frames. Timelines support 23.976, 24, 25, 29.97, 30, 47.952, 48, 50, 59.94, and 60 fps`,
      { fps });
  }

  const document = resolveRenderedClipDocument(clip, clipSourceEdgeSec(project));
  const plan = buildClipCutPlan(document.deletedRanges, { startSec: document.clipStartSec, endSec: document.clipEndSec });

  const clipTitle = clip.title?.trim() || clip.hookText;
  const baseName = clipExportSubtitleBaseName(clipTitle, clip.editorRevision);
  const cues = deriveCaptionCues({ ...document, deletedRanges: planDeletions(plan), sceneBlocks: [] }, { ignoreVisibility: true, language: effectiveCaptionLanguage(project) });

  return {
    editorRevision: clip.editorRevision,
    baseName,
    timeline: {
      fileName: `${baseName}.${TIMELINE_FILE_EXTENSIONS[input.format]}`,
      contentType: TIMELINE_CONTENT_TYPES[input.format],
      content: renderTimeline(input.format, {
        title: clipTitle,
        sourceFileName: source.fileName,
        source: probe.data,
        cuts: timelineCuts(plan),
      }),
    } satisfies ClipTimelineFile,
    subtitles: {
      fileName: `${baseName}.srt`,
      contentType: "application/x-subrip; charset=utf-8",
      content: formatSubtitles(cues, "srt"),
    } satisfies ClipTimelineFile,
  };
}
