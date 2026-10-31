
import { type WorkerProcessModule } from "../worker-process";


export const DUBBING_FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;
export const DUBBING_PROBE_TIMEOUT_MS = 30_000;

export async function probeDubbedMediaDuration(
  workerProcess: WorkerProcessModule,
  signal: AbortSignal,
  filePath: string,
): Promise<number | null> {
  return (
    await workerProcess.inspectMedia({
      sourcePath: filePath,
      signal,
      deadlineMs: DUBBING_PROBE_TIMEOUT_MS,
    })
  ).durationSec;
}

export async function muxDubbedVideo(params: {
  workerProcess: WorkerProcessModule;
  signal: AbortSignal;
  videoPath: string;
  audioPath: string;
  outputPath: string;
}) {
  await params.workerProcess.execute({
    command: "ffmpeg",
    args: [
      "-y",
      "-i",
      params.videoPath,
      "-i",
      params.audioPath,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-shortest",
      "-movflags",
      "+faststart",
      params.outputPath,
    ],
    signal: params.signal,
    deadlineMs: DUBBING_FFMPEG_TIMEOUT_MS,
  });
}
