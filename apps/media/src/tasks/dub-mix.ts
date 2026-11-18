
import { type WorkerProcessModule } from "../worker-process";

export const DUBBING_FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;
export const DUBBING_PROBE_TIMEOUT_MS = 30_000;

export async function probeDubbedMediaDuration(
  workerProcess: WorkerProcessModule,
  signal: AbortSignal,
  filePath: string,
  localOnly = false,
): Promise<number | null> {
  return (
    await workerProcess.inspectMedia({
      sourcePath: filePath,
      signal,
      deadlineMs: DUBBING_PROBE_TIMEOUT_MS,
      ...(localOnly ? { localOnly: true } : {}),
    })
  ).durationSec;
}

/** Sample rate of trimmed dub clips and the mixed dub audio. */
export const DUB_AUDIO_SAMPLE_RATE = 24_000;
const DUB_TRIM_EDGE_SEC = 0.05;
const DUB_TRIM_THRESHOLD = "-50dB";

const localOnlyArgs = (localOnly: boolean | undefined) =>
  localOnly ? ["-protocol_whitelist", "file,pipe"] : [];

/** Removes leading and trailing silence but keeps ~50 ms at each edge; interior pauses stay. */
export const DUB_TRIM_FILTER = (() => {
  const strip = `silenceremove=start_periods=1:start_threshold=${DUB_TRIM_THRESHOLD}:start_silence=${DUB_TRIM_EDGE_SEC}`;
  return `${strip},areverse,${strip},areverse`;
})();

export function buildTrimDubClipArgs(params: {
  inputPath: string;
  outputPath: string;
  localOnly?: boolean;
}): string[] {
  return [
    "-y",
    ...localOnlyArgs(params.localOnly),
    "-i",
    params.inputPath,
    "-vn",
    "-af",
    DUB_TRIM_FILTER,
    "-ac",
    "1",
    "-ar",
    String(DUB_AUDIO_SAMPLE_RATE),
    "-c:a",
    "pcm_s16le",
    params.outputPath,
  ];
}

export async function trimDubClip(params: {
  workerProcess: WorkerProcessModule;
  signal: AbortSignal;
  inputPath: string;
  outputPath: string;
  localOnly?: boolean;
}) {
  await params.workerProcess.execute({
    command: "ffmpeg",
    args: buildTrimDubClipArgs(params),
    signal: params.signal,
    deadlineMs: DUBBING_FFMPEG_TIMEOUT_MS,
  });
}

export type DubMixClip = { path: string; startSec: number; tempo: number };

const seconds = (value: number) => value.toFixed(6).replace(/\.?0+$/u, "");

/** One clip: atempo (only when sped up) then adelay to its start on every channel. */
export function dubClipFilter(clip: DubMixClip, index: number): string {
  const steps = [
    `aresample=${DUB_AUDIO_SAMPLE_RATE}`,
    "aformat=sample_fmts=fltp:channel_layouts=mono",
  ];
  if (clip.tempo > 1) steps.push(`atempo=${seconds(clip.tempo)}`);
  steps.push(`adelay=${Math.max(0, Math.round(clip.startSec * 1000))}:all=1`);
  return `[${index}:a]${steps.join(",")}[c${index}]`;
}

export function buildMixDubAudioArgs(params: {
  clips: DubMixClip[];
  editedDurationSec: number;
  outputPath: string;
  localOnly?: boolean;
}): string[] {
  const { clips, editedDurationSec } = params;
  if (clips.length === 0) throw new Error("dub_mix_no_clips");
  const labels = clips.map((_, index) => `[c${index}]`).join("");
  const duration = seconds(editedDurationSec);
  // A silent bed as long as the clip keeps the mix open to the edited duration.
  // Padding after amix instead is unreliable: ffmpeg ends the output at the last
  // narration in about one run in seven, shortening the dub.
  const graph = [
    ...clips.map(dubClipFilter),
    `anullsrc=r=${DUB_AUDIO_SAMPLE_RATE}:cl=mono,atrim=duration=${duration}[bed]`,
    `${labels}[bed]amix=inputs=${clips.length + 1}:normalize=0:dropout_transition=0:duration=longest,atrim=end=${duration}[mix]`,
  ].join(";");
  return [
    "-y",
    ...clips.flatMap((clip) => [...localOnlyArgs(params.localOnly), "-i", clip.path]),
    "-filter_complex",
    graph,
    "-map",
    "[mix]",
    "-c:a",
    "libmp3lame",
    "-ac",
    "1",
    "-ar",
    String(DUB_AUDIO_SAMPLE_RATE),
    "-b:a",
    "96k",
    params.outputPath,
  ];
}

export async function mixDubAudio(params: {
  workerProcess: WorkerProcessModule;
  signal: AbortSignal;
  clips: DubMixClip[];
  editedDurationSec: number;
  outputPath: string;
  localOnly?: boolean;
}) {
  await params.workerProcess.execute({
    command: "ffmpeg",
    args: buildMixDubAudioArgs(params),
    signal: params.signal,
    deadlineMs: DUBBING_FFMPEG_TIMEOUT_MS,
  });
}
