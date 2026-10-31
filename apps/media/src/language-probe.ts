import { HTTP_SOURCE_RW_TIMEOUT_US } from "./worker-process";
import type { LanguageProbeWindow } from "@narriflow/services/language-probe-contract";
export { selectProbeWindows, PROBE_MIN_DURATION_SEC, PROBE_WINDOW_SEC, PROBE_WINDOW_CENTERS, type LanguageProbeWindow } from "@narriflow/services/language-probe-contract";

/** One ffmpeg process: an input-seeked window per input, concatenated to mono 16 kHz WAV. */
export function buildProbeFfmpegArgs(
  sourceUrl: string,
  windows: readonly LanguageProbeWindow[],
  outputPath: string,
  options: { ifMatch?: string; threads?: number } = {},
): string[] {
  const inputs = windows.flatMap((window) => [
    "-rw_timeout",
    String(HTTP_SOURCE_RW_TIMEOUT_US),
    "-ss",
    String(window.startSec),
    "-t",
    String(window.durationSec),
    ...(options.ifMatch ? ["-headers", `If-Match: ${options.ifMatch}\r\n`] : []),
    ...(options.threads ? ["-threads", String(options.threads)] : []),
    "-i",
    sourceUrl,
  ]);
  const labels = windows.map((_, index) => `[${index}:a:0]`).join("");
  return [
    "-y",
    "-nostdin",
    ...(options.threads ? ["-filter_complex_threads", String(options.threads)] : []),
    ...inputs,
    "-filter_complex",
    `${labels}concat=n=${windows.length}:v=0:a=1,aresample=16000[a]`,
    "-map",
    "[a]",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    ...(options.threads ? ["-threads", String(options.threads)] : []),
    outputPath,
  ];
}
