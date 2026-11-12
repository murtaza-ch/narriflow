import { isAbsolute, join } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { QUIET_AUDIO_DETECTION, encodeQuietRanges, type EncodedQuietRanges } from "@narriflow/validators";
import type { WorkerProcessModule } from "./worker-process";

/** The metadata file lists one frame per silence edge; a pathological source
 *  (speech-length flicker) stops measuring instead of growing it. */
const MAX_METADATA_BYTES = 8 * 1024 * 1024;

export interface QuietRangesInput {
  audioPath: string;
  deadlineMs: number;
}

export class QuietRangesError extends Error {
  constructor(readonly code: "quiet_ranges_input_invalid" | "quiet_ranges_output_invalid") { super(code); this.name = "QuietRangesError"; }
}

export function buildQuietRangesFfmpegArgs(audioPath: string, metadataPath: string): string[] {
  const { noiseDb, minDurationSec } = QUIET_AUDIO_DETECTION;
  // Frames carry metadata only on a silence edge, so the print file holds one
  // short block per edge instead of one per audio frame.
  // `-progress pipe:1` reports the decoded end (`out_time_us`), which closes
  // a silence that runs to the end of the audio.
  return ["-nostdin", "-hide_banner", "-v", "error", "-progress", "pipe:1", "-i", audioPath, "-vn", "-map", "0:a:0",
    "-af", `silencedetect=noise=${noiseDb}dB:d=${minDurationSec},ametadata=mode=print:file=${metadataPath}`, "-f", "null", "-"];
}

/** The decoded end of the audio from FFmpeg's `-progress` output: the last
 *  `out_time_us`. Null when it never reported one. */
export function parseProgressEndSec(text: string): number | null {
  let end: number | null = null;
  for (const match of text.matchAll(/^out_time_us=(\d+)$/gm)) end = Number(match[1]) / 1_000_000;
  return end !== null && Number.isFinite(end) && end > 0 ? end : null;
}

/** Reads `ametadata=mode=print` output of `silencedetect`: `lavfi.silence_start`,
 *  `lavfi.silence_end` and `lavfi.silence_duration` lines. A start clamps to 0
 *  (FFmpeg reports a slightly negative start for audio that begins quiet). An
 *  end without a start derives its start from the duration. A final start with
 *  no end is silence running to the end of the audio: it closes at
 *  `audioEndSec` when known, and is dropped otherwise. */
export function parseSilenceDetectMetadata(text: string, audioEndSec: number | null = null): { startSec: number; endSec: number }[] {
  const ranges: { startSec: number; endSec: number }[] = [];
  let open: number | null = null;
  let end: number | null = null;
  const close = (duration: number | null) => {
    if (end === null) return;
    const startSec = Math.max(0, open ?? (duration === null ? Number.NaN : end - duration));
    if (Number.isFinite(startSec) && end > startSec) ranges.push({ startSec, endSec: end });
    open = null;
    end = null;
  };
  for (const line of text.split(/\r?\n/)) {
    const match = /^lavfi\.silence_(start|end|duration)(?:\.\d+)?=(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i.exec(line.trim());
    if (!match) continue;
    const value = Number(match[2]);
    if (!Number.isFinite(value)) continue;
    if (match[1] === "start") {
      close(null);
      open = value;
    } else if (match[1] === "end") {
      close(null);
      end = value;
    } else close(value);
  }
  close(null);
  if (open !== null && audioEndSec !== null && audioEndSec > Math.max(0, open)) {
    ranges.push({ startSec: Math.max(0, open), endSec: audioEndSec });
  }
  return ranges;
}

/** Quiet intervals of one audio file as encoded run lengths, on the clock of
 *  the audio as FFmpeg decodes it (the clock the transcript shares). Null when
 *  the source has more intervals than a Source Audio may store. */
export async function measureQuietRanges(input: QuietRangesInput, ports: {
  signal: AbortSignal;
  workerProcess: Pick<WorkerProcessModule, "execute" | "withScratchDirectory">;
}): Promise<EncodedQuietRanges | null> {
  ports.signal.throwIfAborted();
  if (!isAbsolute(input.audioPath) || input.audioPath.includes("\0") || input.audioPath.length > 2048 ||
    !Number.isInteger(input.deadlineMs) || input.deadlineMs < 1_000 || input.deadlineMs > 600_000) throw new QuietRangesError("quiet_ranges_input_invalid");
  const source = await stat(input.audioPath).catch(() => null);
  if (!source?.isFile()) throw new QuietRangesError("quiet_ranges_input_invalid");
  return ports.workerProcess.withScratchDirectory("quiet-ranges-", async (directory) => {
    const metadataPath = join(directory, "silence.txt");
    const result = await ports.workerProcess.execute({ command: "ffmpeg", args: buildQuietRangesFfmpegArgs(input.audioPath, metadataPath),
      signal: ports.signal, deadlineMs: input.deadlineMs, captureStdout: true, maxStdoutBytes: 4 * 1024 * 1024 });
    const audioEndSec = parseProgressEndSec(result.stdout.toString("utf8"));
    const metadata = await stat(metadataPath).catch(() => null);
    // No edge at all writes no frame; ametadata may not create the file then.
    if (!metadata) return encodeQuietRanges([]);
    if (!metadata.isFile() || metadata.size > MAX_METADATA_BYTES) throw new QuietRangesError("quiet_ranges_output_invalid");
    return encodeQuietRanges(parseSilenceDetectMetadata(await readFile(metadataPath, "utf8"), audioEndSec));
  });
}
