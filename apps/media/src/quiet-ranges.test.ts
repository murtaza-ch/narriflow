import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeQuietRanges } from "@narriflow/validators";
import { measureQuietRanges, parseSilenceDetectMetadata, QuietRangesError } from "./quiet-ranges";
import { productionWorkerProcessModule } from "./worker-process";

describe("parseSilenceDetectMetadata", () => {
  test("pairs starts with ends, clamps a negative start and ignores other lines", () => {
    const text = [
      "frame:28   pts:28672   pts_time:1.792", "lavfi.silence_start=1.5",
      "frame:54   pts:55296   pts_time:3.456", "lavfi.silence_end=3.500062", "lavfi.silence_duration=2.000062",
      "frame:60   pts:1   pts_time:4", "lavfi.silence_start=-0.012",
      "lavfi.silence_end=0.7", "lavfi.silence_duration=0.712",
      "lavfi.other=9",
    ].join("\n");
    expect(parseSilenceDetectMetadata(text)).toEqual([{ startSec: 1.5, endSec: 3.500062 }, { startSec: 0, endSec: 0.7 }]);
  });

  test("derives a missing start from the duration and drops a final unclosed start", () => {
    const text = "lavfi.silence_end=5\nlavfi.silence_duration=1.5\nlavfi.silence_start=9\nlavfi.silence_end=10\nlavfi.silence_start=20\n";
    expect(parseSilenceDetectMetadata(text)).toEqual([{ startSec: 3.5, endSec: 5 }, { startSec: 9, endSec: 10 }]);
  });

  test("an empty or unrelated file has no ranges", () => {
    expect(parseSilenceDetectMetadata("")).toEqual([]);
    expect(parseSilenceDetectMetadata("lavfi.silence_start=abc\nlavfi.silence_end=\n")).toEqual([]);
  });
});

describe("measureQuietRanges", () => {
  const signal = new AbortController().signal;
  const ffmpeg = (args: string[]) => productionWorkerProcessModule.execute({ command: "ffmpeg", args: ["-hide_banner", "-loglevel", "error", "-y", ...args], signal, deadlineMs: 60_000 });

  test("measures real quiet gaps between tones and ignores a quiet tail it cannot close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quiet-ranges-test-"));
    try {
      const path = join(directory, "tone-silence-tone.wav");
      // tone 0-1.5 s, silence 1.5-3.5 s, tone 3.5-4.5 s, silence 4.5-5.0 s (to the end).
      await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=1.5", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono:d=2",
        "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=16000:duration=1", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono:d=0.5",
        "-filter_complex", "[0:a][1:a][2:a][3:a]concat=n=4:v=0:a=1", "-ac", "1", path]);
      const encoded = await measureQuietRanges({ audioPath: path, deadlineMs: 30_000 }, { signal, workerProcess: productionWorkerProcessModule });
      expect(encoded).not.toBeNull();
      const ranges = decodeQuietRanges(encoded!);
      expect(ranges.length).toBe(1);
      expect(ranges[0]!.startSec).toBeCloseTo(1.5, 1);
      expect(ranges[0]!.endSec).toBeCloseTo(3.5, 1);
      // Whole-centisecond rounding only ever shrinks a quiet interval.
      expect(ranges[0]!.startSec).toBeGreaterThanOrEqual(1.5 - 1e-9);
      expect(ranges[0]!.endSec).toBeLessThanOrEqual(3.5 + 0.01);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 60_000);

  test("audio with no quiet gap measures an empty list, not null", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quiet-ranges-test-"));
    try {
      const path = join(directory, "tone.wav");
      await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=1", "-ac", "1", path]);
      expect(await measureQuietRanges({ audioPath: path, deadlineMs: 30_000 }, { signal, workerProcess: productionWorkerProcessModule })).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 60_000);

  test("refuses a relative, missing or badly timed input before running anything", async () => {
    const ports = { signal, workerProcess: productionWorkerProcessModule };
    await expect(measureQuietRanges({ audioPath: "relative.wav", deadlineMs: 30_000 }, ports)).rejects.toBeInstanceOf(QuietRangesError);
    await expect(measureQuietRanges({ audioPath: "/definitely/missing.wav", deadlineMs: 30_000 }, ports)).rejects.toBeInstanceOf(QuietRangesError);
    await expect(measureQuietRanges({ audioPath: "/tmp/x.wav", deadlineMs: 5 }, ports)).rejects.toBeInstanceOf(QuietRangesError);
  });
});
