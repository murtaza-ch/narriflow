import { expect, test } from "bun:test";
import { renderFfmpegArgs } from "./ffmpeg-thread-policy";

test("a two-input render bounds each decoder and preserves explicit smaller codec pools", () => {
  const command = Object.freeze(["-threads", "2", "-i", "source.mp4", "-i", "broll.mp4", "-filter_complex", "[0:v][1:v]overlay[v]", "-map", "[v]", "-c:v", "libx264", "output.mp4"]);
  const actual = renderFfmpegArgs(command);
  expect(actual).toEqual(["-filter_threads", "4", "-filter_complex_threads", "4", "-threads", "2", "-i", "source.mp4", "-threads", "4", "-i", "broll.mp4", "-filter_complex", "[0:v][1:v]overlay[v]", "-map", "[v]", "-c:v", "libx264", "-threads:v", "6", "output.mp4"]);
  expect(renderFfmpegArgs(actual)).toEqual(actual);
});

test("stricter filter and output limits remain authoritative, while an unbounded decoder is refused", () => {
  const command = ["-filter_threads", "2", "-filter_complex_threads", "2", "-threads", "2", "-i", "source.mp4", "-c:v", "libx264", "-threads", "2", "output.mp4"];
  expect(renderFfmpegArgs(command)).toEqual(command);
  expect(() => renderFfmpegArgs(["-threads", "0", "-i", "source.mp4", "output.mp4"])).toThrow("ffmpeg_thread_policy_invalid");
  expect(() => renderFfmpegArgs(["-threads", "8", "-i", "source.mp4", "output.mp4"])).toThrow("ffmpeg_thread_policy_invalid");
  expect(renderFfmpegArgs(["-version"])).toEqual(["-version"]);
});
