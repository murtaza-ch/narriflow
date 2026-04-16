import { spawn } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import {
  clipService,
  downloadObjectToFile,
  projectService,
  putFileFromPath,
} from "@narriflow/services";
import {
  captionPresetSchema,
  clipAspectRatioDbSchema,
  clipAspectRatioFromDb,
  clipAspectRatioOptions,
} from "@narriflow/validators";
import type { CaptionPreset, ClipAspectRatio, TranscriptUtterance } from "@narriflow/validators";

interface WorkflowRunJob {
  id: string;
  projectId: string;
  project: {
    title: string;
    sourceStorageKey: string | null;
    sourceDurationSeconds: number | null;
  };
}

interface SourceProbe {
  width: number;
  height: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

interface PendingRenderOutput {
  clipRenderId: string;
  clipId: string;
  clipIndex: number;
  aspectRatio: ClipAspectRatio;
  outputPath: string;
  storageKey: string;
  subtitlePath?: string | null;
}

class WorkflowWorkerError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const aspectRatioConfig = new Map(
  clipAspectRatioOptions.map((option) => [option.value, option]),
);

const captionStyleByAspectRatio: Record<
  ClipAspectRatio,
  { fontSize: number; marginV: number }
> = {
  "9:16": { fontSize: 24, marginV: 110 },
  "1:1": { fontSize: 22, marginV: 72 },
  "16:9": { fontSize: 28, marginV: 56 },
  "4:5": { fontSize: 23, marginV: 90 },
};

function log(
  level: "info" | "error",
  message: string,
  context?: Record<string, unknown>,
) {
  console.log(
    JSON.stringify({
      level,
      message,
      ts: new Date().toISOString(),
      ...context,
    }),
  );
}

async function execCommand(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(
          new WorkflowWorkerError(
            "worker_command_missing",
            `${command} is not installed`,
          ),
        );
        return;
      }

      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new WorkflowWorkerError(
          "worker_command_failed",
          `${command} failed with code ${code}: ${stderr.slice(-500)}`,
        ),
      );
    });
  });
}

async function execCommandOutput(
  command: string,
  args: string[],
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(
          new WorkflowWorkerError(
            "worker_command_missing",
            `${command} is not installed`,
          ),
        );
        return;
      }

      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(
        new WorkflowWorkerError(
          "worker_command_failed",
          `${command} failed with code ${code}: ${stderr.slice(-500)}`,
        ),
      );
    });
  });
}

async function probeSource(sourcePath: string): Promise<SourceProbe> {
  const output = await execCommandOutput("ffprobe", [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_streams",
    sourcePath,
  ]);

  const data = JSON.parse(output) as {
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
    }>;
  };

  const streams = data.streams ?? [];
  const videoStream = streams.find((stream) => stream.codec_type === "video");
  const audioStream = streams.find((stream) => stream.codec_type === "audio");

  return {
    width: videoStream?.width ?? 0,
    height: videoStream?.height ?? 0,
    hasVideo: Boolean(videoStream),
    hasAudio: Boolean(audioStream),
  };
}

function formatSrtTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function generateSrtFromSlice(
  utterances: TranscriptUtterance[],
  clipStartSec: number,
  textTransform?: string,
): string {
  if (utterances.length === 0) {
    return "";
  }

  const WORDS_PER_CUE = 3;
  const cues: string[] = [];
  let cueIndex = 1;

  for (const utterance of utterances) {
    const words = utterance.words;

    if (words.length > 0) {
      // Word-level mode: group into 2-3 word cues
      for (let i = 0; i < words.length; i += WORDS_PER_CUE) {
        const group = words.slice(i, i + WORDS_PER_CUE);
        const start = Math.max(0, group[0]!.startSec - clipStartSec);
        const end = Math.max(start + 0.1, group[group.length - 1]!.endSec - clipStartSec);
        const text = applyTextTransform(group.map((w) => w.word).join(" "), textTransform);
        cues.push(`${cueIndex}\n${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}\n${text}\n`);
        cueIndex++;
      }
    } else {
      // Fallback: utterance-level cue
      const start = Math.max(0, utterance.startSec - clipStartSec);
      const end = Math.max(start + 0.1, utterance.endSec - clipStartSec);
      const text = applyTextTransform(utterance.text, textTransform);
      cues.push(`${cueIndex}\n${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}\n${text}\n`);
      cueIndex++;
    }
  }

  return cues.join("\n");
}

function formatAssTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.round((seconds % 1) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function hexToAssColor(hex: string, alphaHex = "00"): string {
  const r = hex.slice(1, 3);
  const g = hex.slice(3, 5);
  const b = hex.slice(5, 7);
  return `&H${alphaHex}${b}${g}${r}`;
}

function applyTextTransform(text: string, transform?: string): string {
  switch (transform) {
    case "uppercase": return text.toUpperCase();
    case "lowercase": return text.toLowerCase();
    case "capitalize": return text.replace(/\b\w/g, (c) => c.toUpperCase());
    default: return text;
  }
}

function generateAssFromSlice(
  utterances: TranscriptUtterance[],
  clipStartSec: number,
  aspectRatio: ClipAspectRatio,
  captionPreset: CaptionPreset,
): string {
  const config = aspectRatioConfig.get(aspectRatio);
  if (!config) return "";

  const resX = config.width;
  const resY = config.height;
  const posXPx = Math.round(((captionPreset.positionX ?? 50) / 100) * resX);
  const posYPx = Math.round(((captionPreset.positionY ?? 88) / 100) * resY);

  const fontName = captionPreset.fontName ?? "Arial";
  const fontSize = captionPreset.fontSize ?? captionStyleByAspectRatio[aspectRatio].fontSize;
  const primaryColor = hexToAssColor(captionPreset.primaryColor ?? "#FFFFFF");
  const highlightColor = hexToAssColor(captionPreset.highlightColor ?? "#00FF88");
  const outlineColor = hexToAssColor(captionPreset.outlineColor ?? "#000000");
  const bold = captionPreset.bold !== false ? -1 : 0;
  const outlineWidth = captionPreset.outlineWidth ?? 2;
  const shadow = captionPreset.shadow ?? 1;
  const spacing = Math.round((captionPreset.letterSpacing ?? 0) * fontSize);

  // Backdrop: use BorderStyle=3 (opaque box) with BackColour
  let borderStyle = 1;
  let backColour = "&H00000000";
  if (captionPreset.backgroundColor) {
    borderStyle = 3;
    const bgAlpha = Math.round((1 - (captionPreset.backgroundOpacity ?? 0.6)) * 255);
    const bgAlphaHex = bgAlpha.toString(16).toUpperCase().padStart(2, "0");
    backColour = hexToAssColor(captionPreset.backgroundColor, bgAlphaHex);
  }

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${resX}`,
    `PlayResY: ${resY}`,
    "WrapStyle: 2",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${fontName},${fontSize},${primaryColor},${primaryColor},${outlineColor},${backColour},${bold},0,0,0,100,100,${spacing},0,${borderStyle},${outlineWidth},${shadow},5,0,0,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  const WORDS_PER_CUE = 3;
  const events: string[] = [];

  const txtTransform = captionPreset.textTransform;

  for (const utterance of utterances) {
    const words = utterance.words;

    if (words.length > 0) {
      for (let i = 0; i < words.length; i += WORDS_PER_CUE) {
        const group = words.slice(i, i + WORDS_PER_CUE);
        const groupEnd = Math.max(0, group[group.length - 1]!.endSec - clipStartSec);
        const transformedWords = group.map((w) => applyTextTransform(w.word, txtTransform));

        for (let j = 0; j < group.length; j++) {
          const activeStart = Math.max(0, group[j]!.startSec - clipStartSec);
          const activeEnd =
            j + 1 < group.length
              ? Math.max(activeStart + 0.05, group[j + 1]!.startSec - clipStartSec)
              : Math.max(activeStart + 0.1, groupEnd);

          const text = transformedWords
            .map((word, k) =>
              k === j
                ? `{\\1c${highlightColor}&}${word}{\\1c${primaryColor}&}`
                : word,
            )
            .join(" ");

          events.push(
            `Dialogue: 0,${formatAssTimestamp(activeStart)},${formatAssTimestamp(activeEnd)},Default,,0,0,0,,{\\pos(${posXPx},${posYPx})}${text}`,
          );
        }
      }
    } else {
      const start = Math.max(0, utterance.startSec - clipStartSec);
      const end = Math.max(start + 0.1, utterance.endSec - clipStartSec);
      const text = applyTextTransform(utterance.text, txtTransform);
      events.push(
        `Dialogue: 0,${formatAssTimestamp(start)},${formatAssTimestamp(end)},Default,,0,0,0,,{\\pos(${posXPx},${posYPx})}${text}`,
      );
    }
  }

  return header + "\n" + events.join("\n") + "\n";
}

function escapeSubtitlePath(filePath: string) {
  return filePath.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

function hexToFfmpegColor(hex: string): string {
  // Converts #RRGGBB to \&H00BBGGRR\& (FFmpeg ASS BGRA color format, alpha=00=opaque)
  const r = hex.slice(1, 3);
  const g = hex.slice(3, 5);
  const b = hex.slice(5, 7);
  return `\\&H00${b}${g}${r}\\&`;
}

function buildSubtitleFilter(
  aspectRatio: ClipAspectRatio,
  subtitlePath: string | null,
  captionPreset?: CaptionPreset | null,
) {
  if (!subtitlePath) {
    return null;
  }

  const escapedPath = escapeSubtitlePath(subtitlePath);

  // ASS files carry their own styling and positioning
  if (subtitlePath.endsWith(".ass")) {
    return `ass='${escapedPath}'`;
  }

  // SRT path: apply force_style
  const captionStyle = captionStyleByAspectRatio[aspectRatio];
  const fontSize = captionPreset?.fontSize ?? captionStyle.fontSize;

  const fontName = captionPreset?.fontName ?? "Arial";
  const primaryColor = captionPreset?.primaryColor
    ? hexToFfmpegColor(captionPreset.primaryColor)
    : "\\&H00FFFFFF\\&";
  const outlineColor = captionPreset?.outlineColor
    ? hexToFfmpegColor(captionPreset.outlineColor)
    : "\\&H00000000\\&";
  const outlineWidth = captionPreset?.outlineWidth ?? 2;
  const shadow = captionPreset?.shadow ?? 1;
  const bold = captionPreset?.bold !== false ? 1 : 0;
  const alignment =
    captionPreset?.position === "top" ? 8 :
    captionPreset?.position === "center" ? 5 : 2;

  const spacing = Math.round((captionPreset?.letterSpacing ?? 0) * fontSize);

  let borderStyle = 1;
  let backColour = "";
  if (captionPreset?.backgroundColor) {
    borderStyle = 3;
    const bgAlpha = Math.round((1 - (captionPreset.backgroundOpacity ?? 0.6)) * 255);
    const bgAlphaHex = bgAlpha.toString(16).toUpperCase().padStart(2, "0");
    const r = captionPreset.backgroundColor.slice(1, 3);
    const g = captionPreset.backgroundColor.slice(3, 5);
    const b = captionPreset.backgroundColor.slice(5, 7);
    backColour = `,BackColour=\\&H${bgAlphaHex}${b}${g}${r}\\&,BorderStyle=${borderStyle}`;
  }

  const forceStyle =
    `FontSize=${fontSize},Alignment=${alignment},MarginV=${captionStyle.marginV},FontName=${fontName},` +
    `PrimaryColour=${primaryColor},OutlineColour=${outlineColor},Outline=${outlineWidth},Shadow=${shadow},Bold=${bold}` +
    (spacing > 0 ? `,Spacing=${spacing}` : "") +
    backColour;

  return `subtitles='${escapedPath}':force_style='${forceStyle}'`;
}

function buildCropAndScaleFilter(
  probe: SourceProbe,
  aspectRatio: ClipAspectRatio,
) {
  const config = aspectRatioConfig.get(aspectRatio);

  if (!config) {
    throw new WorkflowWorkerError(
      "unsupported_aspect_ratio",
      `Unsupported aspect ratio: ${aspectRatio}`,
    );
  }

  if (!probe.hasVideo) {
    return null;
  }

  const srcRatio = probe.width / probe.height;
  const targetRatio = config.width / config.height;

  let cropW: number;
  let cropH: number;

  if (srcRatio >= targetRatio) {
    cropH = probe.height;
    cropW = Math.round(probe.height * targetRatio);
  } else {
    cropW = probe.width;
    cropH = Math.round(probe.width / targetRatio);
  }

  return `crop=${cropW}:${cropH},scale=${config.width}:${config.height},format=yuv420p`;
}

function buildSingleVideoFilter(
  probe: SourceProbe,
  aspectRatio: ClipAspectRatio,
  srtPath: string | null,
  captionPreset?: CaptionPreset | null,
) {
  const chain = [buildCropAndScaleFilter(probe, aspectRatio)];
  const subtitleFilter = buildSubtitleFilter(aspectRatio, srtPath, captionPreset);

  if (subtitleFilter) {
    chain.push(subtitleFilter);
  }

  return chain.filter(Boolean).join(",");
}

function buildSingleVideoArgs(params: {
  sourcePath: string;
  outputPath: string;
  startSec: number;
  endSec: number;
  aspectRatio: ClipAspectRatio;
  probe: SourceProbe;
  srtPath: string | null;
  captionPreset?: CaptionPreset | null;
}) {
  const videoFilter = buildSingleVideoFilter(
    params.probe,
    params.aspectRatio,
    params.srtPath,
    params.captionPreset,
  );

  const args = [
    "-y",
    "-ss",
    String(params.startSec),
    "-to",
    String(params.endSec),
    "-i",
    params.sourcePath,
    "-filter_complex",
    `[0:v]${videoFilter}[outv]`,
    "-map",
    "[outv]",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "23",
  ];

  if (params.probe.hasAudio) {
    args.push("-map", "0:a:0?", "-c:a", "aac", "-b:a", "128k");
  } else {
    args.push("-an");
  }

  args.push(
    "-movflags",
    "+faststart",
    "-max_muxing_queue_size",
    "1024",
    params.outputPath,
  );

  return args;
}

function buildMultiVideoArgs(params: {
  sourcePath: string;
  outputs: PendingRenderOutput[];
  startSec: number;
  endSec: number;
  probe: SourceProbe;
  srtPath: string | null;
  captionPreset?: CaptionPreset | null;
}) {
  const splitOutputs = params.outputs
    .map((_, index) => `[v${index}]`)
    .join("");

  const filterSections = [
    `[0:v]split=${params.outputs.length}${splitOutputs}`,
    ...params.outputs.map((output, index) => {
      const subtitlePath = output.subtitlePath ?? params.srtPath;
      const singleFilter = buildSingleVideoFilter(
        params.probe,
        output.aspectRatio,
        subtitlePath,
        params.captionPreset,
      );
      return `[v${index}]${singleFilter}[outv${index}]`;
    }),
  ];

  const args = [
    "-y",
    "-ss",
    String(params.startSec),
    "-to",
    String(params.endSec),
    "-i",
    params.sourcePath,
    "-filter_complex",
    filterSections.join(";"),
  ];

  for (const [index, output] of params.outputs.entries()) {
    args.push("-map", `[outv${index}]`);

    if (params.probe.hasAudio) {
      args.push("-map", "0:a:0?", "-c:a", "aac", "-b:a", "128k");
    } else {
      args.push("-an");
    }

    args.push(
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "23",
      "-movflags",
      "+faststart",
      "-max_muxing_queue_size",
      "1024",
      output.outputPath,
    );
  }

  return args;
}

function buildAudioOnlyArgs(params: {
  sourcePath: string;
  outputPath: string;
  startSec: number;
  endSec: number;
  aspectRatio: ClipAspectRatio;
  clipDurationSec: number;
  srtPath: string | null;
  captionPreset?: CaptionPreset | null;
}) {
  const config = aspectRatioConfig.get(params.aspectRatio);

  if (!config) {
    throw new WorkflowWorkerError(
      "unsupported_aspect_ratio",
      `Unsupported aspect ratio: ${params.aspectRatio}`,
    );
  }

  const subtitleFilter = buildSubtitleFilter(params.aspectRatio, params.srtPath, params.captionPreset);
  const args = [
    "-y",
    "-ss",
    String(params.startSec),
    "-to",
    String(params.endSec),
    "-i",
    params.sourcePath,
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=${config.width}x${config.height}:d=${params.clipDurationSec},format=yuv420p`,
  ];

  if (subtitleFilter) {
    args.push("-filter_complex", `[1:v]${subtitleFilter}[outv]`, "-map", "[outv]");
  } else {
    args.push("-map", "1:v");
  }

  args.push(
    "-map",
    "0:a:0",
    "-shortest",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    "-max_muxing_queue_size",
    "1024",
    params.outputPath,
  );

  return args;
}

async function uploadRenderedOutput(params: {
  workflowRunId: string;
  projectId: string;
  output: PendingRenderOutput;
  clipDurationSec: number;
}) {
  const outputStat = await stat(params.output.outputPath);

  await putFileFromPath({
    key: params.output.storageKey,
    filePath: params.output.outputPath,
    contentType: "video/mp4",
    metadata: {
      project_id: params.projectId,
      clip_id: params.output.clipId,
      workflow_run_id: params.workflowRunId,
      format: params.output.aspectRatio,
    },
  });

  await clipService.completeClipRenderVariant(params.output.clipRenderId, {
    storageKey: params.output.storageKey,
    sizeBytes: Number(outputStat.size),
    durationSec: params.clipDurationSec,
  });

  log("info", "clip_render_variant_completed", {
    workflowRunId: params.workflowRunId,
    clipId: params.output.clipId,
    clipRenderId: params.output.clipRenderId,
    clipIndex: params.output.clipIndex,
    aspectRatio: params.output.aspectRatio,
    sizeBytes: Number(outputStat.size),
  });
}

export async function processClipRenderingRun(run: WorkflowRunJob) {
  if (!run.project.sourceStorageKey) {
    await projectService.failClipRenderingWorkflowRun(
      run.id,
      "source_storage_key_missing",
    );
    log("error", "clip_rendering_run_failed", {
      workflowRunId: run.id,
      projectId: run.projectId,
      code: "source_storage_key_missing",
    });
    return;
  }

  log("info", "clip_rendering_run_started", {
    workflowRunId: run.id,
    projectId: run.projectId,
  });

  const tempDir = await mkdtemp(join(tmpdir(), "narriflow-render-"));

  try {
    const sourceExt = extname(run.project.sourceStorageKey) || ".bin";
    const sourcePath = join(tempDir, `source${sourceExt}`);

    try {
      await downloadObjectToFile({
        key: run.project.sourceStorageKey,
        filePath: sourcePath,
      });
    } catch (error) {
      throw new WorkflowWorkerError(
        "source_download_failed",
        `Failed to download source: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }

    const probe = await probeSource(sourcePath);

    log("info", "clip_rendering_source_probed", {
      workflowRunId: run.id,
      width: probe.width,
      height: probe.height,
      hasVideo: probe.hasVideo,
      hasAudio: probe.hasAudio,
    });

    const pendingRenders = await clipService.getPendingClipRendersForProject(
      run.projectId,
    );

    if (pendingRenders.length === 0) {
      throw new WorkflowWorkerError(
        "no_renderable_clips",
        "No clip render variants with status=pending found",
      );
    }

    const rendersByClipId = new Map<string, typeof pendingRenders>();

    for (const render of pendingRenders) {
      const existing = rendersByClipId.get(render.clipId) ?? [];
      existing.push(render);
      rendersByClipId.set(render.clipId, existing);
    }

    const clipGroups = [...rendersByClipId.values()].sort(
      (left, right) => left[0]!.clip.index - right[0]!.clip.index,
    );

    await projectService.publishWorkflowProgress({
      projectId: run.projectId,
      workflowRunId: run.id,
      stage: "clip_rendering",
      status: "running",
      progress: 10,
      errorCode: null,
    });

    let renderedVariantCount = 0;

    for (let clipGroupIndex = 0; clipGroupIndex < clipGroups.length; clipGroupIndex++) {
      const renderGroup = clipGroups[clipGroupIndex]!;
      const clip = renderGroup[0]!.clip;
      const clipDurationSec = clip.endSec - clip.startSec;
      const utterances = clip.transcriptSlice as unknown as TranscriptUtterance[];
      const captionPreset = clip.captionPreset
        ? captionPresetSchema.nullable().parse(clip.captionPreset)
        : null;
      const hasCustomPosition =
        captionPreset?.positionX !== undefined &&
        captionPreset?.positionY !== undefined;

      const srtContent = generateSrtFromSlice(utterances, clip.startSec, captionPreset?.textTransform);
      let srtPath: string | null = null;

      if (!hasCustomPosition && srtContent.length > 0) {
        srtPath = join(tempDir, `clip-${clip.id}.srt`);
        await writeFile(srtPath, srtContent, "utf-8");
      }

      const outputs: PendingRenderOutput[] = renderGroup.map((render) => {
        const aspectRatio = clipAspectRatioFromDb[
          clipAspectRatioDbSchema.parse(render.aspectRatio)
        ];
        const slug =
          clipAspectRatioOptions.find((option) => option.value === aspectRatio)
            ?.slug ?? "9x16";

        return {
          clipRenderId: render.id,
          clipId: clip.id,
          clipIndex: clip.index,
          aspectRatio,
          outputPath: join(tempDir, `clip-${clip.id}-${slug}.mp4`),
          storageKey: `projects/${run.projectId}/renders/${clip.id}/${slug}.mp4`,
        };
      });

      // Generate per-aspect-ratio ASS files when custom position is set
      if (hasCustomPosition && captionPreset && utterances.length > 0) {
        for (const output of outputs) {
          const assContent = generateAssFromSlice(
            utterances,
            clip.startSec,
            output.aspectRatio,
            captionPreset,
          );
          if (assContent.length > 0) {
            const assPath = join(
              tempDir,
              `clip-${clip.id}-${output.aspectRatio.replace(":", "x")}.ass`,
            );
            await writeFile(assPath, assContent, "utf-8");
            output.subtitlePath = assPath;
          }
        }
      }

      await Promise.all(
        outputs.map((output) =>
          clipService.markClipRenderVariantRendering(output.clipRenderId),
        ),
      );

      if (!probe.hasVideo) {
        for (const output of outputs) {
          try {
            const ffmpegArgs = buildAudioOnlyArgs({
              sourcePath,
              outputPath: output.outputPath,
              startSec: clip.startSec,
              endSec: clip.endSec,
              aspectRatio: output.aspectRatio,
              clipDurationSec,
              srtPath: output.subtitlePath ?? srtPath,
              captionPreset,
            });

            await execCommand("ffmpeg", ffmpegArgs);
            await uploadRenderedOutput({
              workflowRunId: run.id,
              projectId: run.projectId,
              output,
              clipDurationSec,
            });
            renderedVariantCount += 1;
          } catch (error) {
            const errorCode =
              error instanceof WorkflowWorkerError
                ? error.code
                : "ffmpeg_render_failed";

            await clipService.failClipRenderVariant(output.clipRenderId, errorCode);

            log("error", "clip_render_variant_failed", {
              workflowRunId: run.id,
              clipId: output.clipId,
              clipRenderId: output.clipRenderId,
              clipIndex: output.clipIndex,
              aspectRatio: output.aspectRatio,
              code: errorCode,
              message:
                error instanceof Error ? error.message : "Unknown render error",
            });
          }
        }
      } else {
        try {
          const ffmpegArgs =
            outputs.length === 1
              ? buildSingleVideoArgs({
                  sourcePath,
                  outputPath: outputs[0]!.outputPath,
                  startSec: clip.startSec,
                  endSec: clip.endSec,
                  aspectRatio: outputs[0]!.aspectRatio,
                  probe,
                  srtPath: outputs[0]!.subtitlePath ?? srtPath,
                  captionPreset,
                })
              : buildMultiVideoArgs({
                  sourcePath,
                  outputs,
                  startSec: clip.startSec,
                  endSec: clip.endSec,
                  probe,
                  srtPath,
                  captionPreset,
                });

          await execCommand("ffmpeg", ffmpegArgs);

          for (const output of outputs) {
            try {
              await uploadRenderedOutput({
                workflowRunId: run.id,
                projectId: run.projectId,
                output,
                clipDurationSec,
              });
              renderedVariantCount += 1;
            } catch (error) {
              const errorCode =
                error instanceof WorkflowWorkerError
                  ? error.code
                  : "render_upload_failed";

              await clipService.failClipRenderVariant(
                output.clipRenderId,
                errorCode,
              );

              log("error", "clip_render_variant_failed", {
                workflowRunId: run.id,
                clipId: output.clipId,
                clipRenderId: output.clipRenderId,
                clipIndex: output.clipIndex,
                aspectRatio: output.aspectRatio,
                code: errorCode,
                message:
                  error instanceof Error ? error.message : "Unknown render error",
              });
            }
          }
        } catch (error) {
          const errorCode =
            error instanceof WorkflowWorkerError
              ? error.code
              : "ffmpeg_render_failed";

          await Promise.all(
            outputs.map((output) =>
              clipService.failClipRenderVariant(output.clipRenderId, errorCode),
            ),
          );

          log("error", "clip_render_group_failed", {
            workflowRunId: run.id,
            clipId: clip.id,
            clipIndex: clip.index,
            aspectRatios: outputs.map((output) => output.aspectRatio),
            code: errorCode,
            message:
              error instanceof Error ? error.message : "Unknown render error",
          });
        }
      }

      const progress = 10 + Math.round(((clipGroupIndex + 1) / clipGroups.length) * 80);
      await projectService.publishWorkflowProgress({
        projectId: run.projectId,
        workflowRunId: run.id,
        stage: "clip_rendering",
        status: "running",
        progress,
        errorCode: null,
      });
    }

    await projectService.completeClipRenderingWorkflowRun(run.id);

    log("info", "clip_rendering_run_completed", {
      workflowRunId: run.id,
      projectId: run.projectId,
      totalClipGroups: clipGroups.length,
      totalVariantCount: pendingRenders.length,
      renderedVariantCount,
      failedVariantCount: pendingRenders.length - renderedVariantCount,
    });
  } catch (error) {
    const code =
      error instanceof WorkflowWorkerError
        ? error.code
        : "workflow_unhandled_error";

    await projectService.failClipRenderingWorkflowRun(run.id, code);

    log("error", "clip_rendering_run_failed", {
      workflowRunId: run.id,
      projectId: run.projectId,
      code,
      message: error instanceof Error ? error.message : "Unknown worker error",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
