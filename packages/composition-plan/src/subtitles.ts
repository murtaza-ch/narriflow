import type { CaptionCue } from "./clip-composition-plan";

export type SubtitleFormat = "srt" | "vtt";

function timestamp(seconds: number, separator: "," | ".") {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}${separator}${pad(ms, 3)}`;
}

/** Cue text never spans lines or closes a cue early inside a subtitle file. */
function cueLine(text: string) {
  return text.replace(/\s+/g, " ").replace(/-->/g, "→").trim();
}

/** Renders derived caption cues as an SRT or WebVTT file. */
export function formatSubtitles(cues: readonly CaptionCue[], format: SubtitleFormat): string {
  const separator = format === "srt" ? "," : ".";
  const blocks = cues
    .map((cue) => ({ ...cue, text: cueLine(cue.text) }))
    .filter((cue) => cue.text && Math.round(cue.endSec * 1000) > Math.round(cue.startSec * 1000))
    .map((cue, index) => `${format === "srt" ? `${index + 1}\n` : ""}${timestamp(cue.startSec, separator)} --> ${timestamp(cue.endSec, separator)}\n${cue.text}`);
  if (format === "vtt") return `WEBVTT\n\n${blocks.map((block) => `${block}\n\n`).join("")}`;
  return blocks.map((block) => `${block}\n\n`).join("");
}
