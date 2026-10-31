/** The render container has four physical CPUs. Six x264 frame workers retain
 * the pinned four-CPU encoder output; decoder and filter pools use four.
 * These are per-pool limits, not a count of all OS threads in FFmpeg. */
export const RENDER_FFMPEG_THREAD_POLICY = Object.freeze({
  id: "render-4cpu-v1",
  decoderThreads: 4,
  filterThreads: 4,
  x264Threads: 6,
});

/** Bound execution without changing the composition compiler's command.
 * Existing stricter limits, such as two-thread native probes, remain in force. */
export function renderFfmpegArgs(input: readonly string[]): string[] {
  if (!input.includes("-i")) return [...input];
  const policy = RENDER_FFMPEG_THREAD_POLICY;
  function configured(args: readonly string[], flag: (value: string) => boolean, maximum: number): boolean {
    let present = false;
    for (let index = 0; index < args.length; index++) {
      if (!flag(args[index]!)) continue;
      const count = Number(args[index + 1]);
      if (!Number.isInteger(count) || count < 1 || count > maximum) throw new Error("ffmpeg_thread_policy_invalid");
      present = true;
    }
    return present;
  }
  const codecThreads = (value: string) => /^-threads(?::v(?::[0-9]+)?)?$/.test(value);
  const prefix: string[] = [];
  if (!configured(input, value => value === "-filter_threads", policy.filterThreads)) prefix.push("-filter_threads", String(policy.filterThreads));
  if (!configured(input, value => value === "-filter_complex_threads", policy.filterThreads)) prefix.push("-filter_complex_threads", String(policy.filterThreads));
  const output = [...prefix];
  let cursor = 0;
  for (let index = 0; index < input.length; index++) {
    if (input[index] !== "-i") continue;
    const segment = input.slice(cursor, index);
    output.push(...segment);
    if (!configured(segment, codecThreads, policy.decoderThreads)) output.push("-threads", String(policy.decoderThreads));
    output.push(input[index]!, input[index + 1]!);
    cursor = index + 2;
    index++;
  }
  const tail = input.slice(cursor);
  const x264 = tail.some((value, index) => ["-c:v", "-vcodec"].includes(value) && tail[index + 1] === "libx264");
  if (x264 && !configured(tail, codecThreads, policy.x264Threads)) {
    output.push(...tail.slice(0, -1), "-threads:v", String(policy.x264Threads), tail.at(-1)!);
  } else output.push(...tail);
  return output;
}
