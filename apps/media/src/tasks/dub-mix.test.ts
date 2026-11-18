import { describe, expect, test } from "bun:test";
import type { WorkerProcessModule } from "../worker-process";
import {
  buildMixDubAudioArgs,
  buildTrimDubClipArgs,
  DUB_TRIM_FILTER,
  DUBBING_FFMPEG_TIMEOUT_MS,
  dubClipFilter,
  mixDubAudio,
  trimDubClip,
} from "./dub-mix";

describe("trimDubClip", () => {
  test("builds the silenceremove/areverse chain into mono 24 kHz pcm_s16le", () => {
    const args = buildTrimDubClipArgs({ inputPath: "in.mp3", outputPath: "out.wav" });
    expect(args).toEqual([
      "-y",
      "-i",
      "in.mp3",
      "-vn",
      "-af",
      "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05,areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05,areverse",
      "-ac",
      "1",
      "-ar",
      "24000",
      "-c:a",
      "pcm_s16le",
      "out.wav",
    ]);
    expect(DUB_TRIM_FILTER.split("areverse")).toHaveLength(3);
  });

  test("localOnly restricts protocols before the input", () => {
    const args = buildTrimDubClipArgs({ inputPath: "in.mp3", outputPath: "out.wav", localOnly: true });
    expect(args.slice(0, 4)).toEqual(["-y", "-protocol_whitelist", "file,pipe", "-i"]);
  });

  test("runs ffmpeg through the worker process with the dubbing deadline", async () => {
    const calls: unknown[] = [];
    const workerProcess = { execute: async (request: unknown) => void calls.push(request) } as unknown as WorkerProcessModule;
    const signal = new AbortController().signal;
    await trimDubClip({ workerProcess, signal, inputPath: "a.mp3", outputPath: "a.wav", localOnly: true });
    expect(calls).toEqual([
      {
        command: "ffmpeg",
        args: buildTrimDubClipArgs({ inputPath: "a.mp3", outputPath: "a.wav", localOnly: true }),
        signal,
        deadlineMs: DUBBING_FFMPEG_TIMEOUT_MS,
      },
    ]);
  });
});

describe("mixDubAudio", () => {
  test("applies atempo only when the tempo is above 1 and delays in milliseconds", () => {
    expect(dubClipFilter({ path: "a.wav", startSec: 1.2345, tempo: 1 }, 0)).toBe(
      "[0:a]aresample=24000,aformat=sample_fmts=fltp:channel_layouts=mono,adelay=1235:all=1[c0]",
    );
    expect(dubClipFilter({ path: "b.wav", startSec: 0, tempo: 1.25 }, 1)).toBe(
      "[1:a]aresample=24000,aformat=sample_fmts=fltp:channel_layouts=mono,atempo=1.25,adelay=0:all=1[c1]",
    );
  });

  test("mixes without normalisation, pads and trims to exactly the edited duration, encodes mono mp3", () => {
    const args = buildMixDubAudioArgs({
      clips: [
        { path: "a.wav", startSec: 0.5, tempo: 1 },
        { path: "b.wav", startSec: 4, tempo: 1.1 },
      ],
      editedDurationSec: 12.5,
      outputPath: "dub.mp3",
    });
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph.split(";")).toEqual([
      "[0:a]aresample=24000,aformat=sample_fmts=fltp:channel_layouts=mono,adelay=500:all=1[c0]",
      "[1:a]aresample=24000,aformat=sample_fmts=fltp:channel_layouts=mono,atempo=1.1,adelay=4000:all=1[c1]",
      "anullsrc=r=24000:cl=mono,atrim=duration=12.5[bed]",
      "[c0][c1][bed]amix=inputs=3:normalize=0:dropout_transition=0:duration=longest,atrim=end=12.5[mix]",
    ]);
    expect(args.filter((arg) => arg === "-i")).toHaveLength(2);
    expect(args.slice(args.indexOf("-map"))).toEqual([
      "-map",
      "[mix]",
      "-c:a",
      "libmp3lame",
      "-ac",
      "1",
      "-ar",
      "24000",
      "-b:a",
      "96k",
      "dub.mp3",
    ]);
  });

  test("localOnly restricts protocols before every input and integer durations have no decimals", () => {
    const args = buildMixDubAudioArgs({
      clips: [
        { path: "a.wav", startSec: 0, tempo: 1 },
        { path: "b.wav", startSec: 1, tempo: 1 },
      ],
      editedDurationSec: 10,
      outputPath: "dub.mp3",
      localOnly: true,
    });
    expect(args.slice(0, 7)).toEqual(["-y", "-protocol_whitelist", "file,pipe", "-i", "a.wav", "-protocol_whitelist", "file,pipe"]);
    expect(args[args.indexOf("-filter_complex") + 1]).toContain("anullsrc=r=24000:cl=mono,atrim=duration=10[bed]");
  });

  test("a single clip still goes through amix and no clips is refused", () => {
    const args = buildMixDubAudioArgs({
      clips: [{ path: "a.wav", startSec: 0, tempo: 1 }],
      editedDurationSec: 3,
      outputPath: "dub.mp3",
    });
    expect(args[args.indexOf("-filter_complex") + 1]).toContain("[c0][bed]amix=inputs=2:normalize=0:dropout_transition=0");
    expect(() => buildMixDubAudioArgs({ clips: [], editedDurationSec: 3, outputPath: "x.mp3" })).toThrow("dub_mix_no_clips");
  });

  test("runs ffmpeg through the worker process", async () => {
    const calls: { command: string; args: string[]; deadlineMs: number }[] = [];
    const workerProcess = {
      execute: async (request: { command: string; args: string[]; deadlineMs: number }) => void calls.push(request),
    } as unknown as WorkerProcessModule;
    await mixDubAudio({
      workerProcess,
      signal: new AbortController().signal,
      clips: [{ path: "a.wav", startSec: 0, tempo: 1 }],
      editedDurationSec: 3,
      outputPath: "dub.mp3",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("ffmpeg");
    expect(calls[0].deadlineMs).toBe(DUBBING_FFMPEG_TIMEOUT_MS);
  });
});
