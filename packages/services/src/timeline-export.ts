import type { FrameRate, SourceProbe, TimelineFormat } from "@narriflow/validators";
import { ExpectedDomainFailureError, type ExpectedDomainFailureCatalog, type ExpectedDomainFailureDetails } from "./expected-domain-failure";

/** Editor timelines for one clip: the original source cut at the clip's kept
 * ranges, as Premiere Pro (FCP7 XML, xmeml v5), Final Cut Pro and DaVinci
 * Resolve (FCPXML 1.11), or any editor (CMX3600 EDL).
 *
 * Everything here is pure. Frames are counted from the source's exact
 * fractional rate (30000/1001 is 29.97, never 29.97). Timecode is
 * non-drop-frame unless the source's own start timecode is drop-frame, and the
 * source starts at the timecode it carries, else at 00:00:00:00. Scenes,
 * overlays, and burned-in captions are not timeline layers. */

const clipTimelineFailureCatalog = {
  clip_not_found: "missing",
  timeline_empty: "unprocessable",
  timeline_source_rate_unsupported: "unprocessable",
  timeline_source_unavailable: "conflict",
  timeline_source_unmeasured: "unprocessable",
  timeline_video_required: "unprocessable",
} as const satisfies ExpectedDomainFailureCatalog<string>;

export type ClipTimelineFailureCode = keyof typeof clipTimelineFailureCatalog;

export class ClipTimelineError extends ExpectedDomainFailureError<ClipTimelineFailureCode> {
  constructor(code: ClipTimelineFailureCode, message: string, details?: ExpectedDomainFailureDetails) {
    super({ code, kind: clipTimelineFailureCatalog[code], message, details });
    this.name = "ClipTimelineError";
  }
}

export interface TimelineCut {
  /** Absolute seconds in the source file where the cut starts. */
  sourceStartSec: number;
  /** Where the cut sits on the edited timeline. Cuts are contiguous: each one
   * ends where the next begins. */
  editedStartSec: number;
  editedEndSec: number;
}

export interface TimelineInput {
  title: string;
  /** How the timeline names the source file, which ships beside it. */
  sourceFileName: string;
  source: SourceProbe;
  /** Kept ranges in playback order. */
  cuts: readonly TimelineCut[];
}

export const TIMELINE_FILE_EXTENSIONS = { xmeml: "xml", fcpxml: "fcpxml", edl: "edl" } as const satisfies Record<TimelineFormat, string>;

export const TIMELINE_CONTENT_TYPES = {
  xmeml: "application/xml; charset=utf-8",
  fcpxml: "application/xml; charset=utf-8",
  edl: "text/plain; charset=utf-8",
} as const satisfies Record<TimelineFormat, string>;

export function renderTimeline(format: TimelineFormat, input: TimelineInput): string {
  const plan = planTimeline(input);
  if (format === "xmeml") return renderXmeml(input, plan);
  if (format === "fcpxml") return renderFcpxml(input, plan);
  return renderEdl(input, plan);
}

/** The frame the clock reads at `sec`, rounding to the nearest frame. Integer
 * arithmetic on milliseconds, so a half frame never depends on float noise. */
export function secondsToFrames(sec: number, rate: FrameRate): number {
  const ms = Math.round(sec * 1000);
  return Math.floor((2 * ms * rate.numerator + 1000 * rate.denominator) / (2000 * rate.denominator));
}

/** Whole frames that fit in `sec`; a file never claims a frame past its end. */
function wholeFrames(sec: number, rate: FrameRate): number {
  return Math.floor(Math.round(sec * 1000) * rate.numerator / (1000 * rate.denominator));
}

/** The nominal integer rate timecode counts in: 30 for 30000/1001. */
function timebase(rate: FrameRate): number {
  return Math.max(1, Math.round(rate.numerator / rate.denominator));
}

function isNtsc(rate: FrameRate): boolean {
  return rate.denominator % 1001 === 0;
}

/** Frames a drop-frame timecode skips each minute (except every tenth): 2 at
 * 29.97 and 4 at 59.94. Other rates have no drop-frame timecode. */
function dropFramesPerMinute(rate: FrameRate, dropFrame: boolean): number {
  const base = timebase(rate);
  return dropFrame && isNtsc(rate) && base % 30 === 0 ? base / 15 : 0;
}

/** Timecode for a frame count: non-drop-frame counts in the nominal timebase;
 * drop-frame skips labels so the clock stays true to real time and writes `;`
 * before the frames. */
export function framesToTimecode(frames: number, rate: FrameRate, dropFrame = false): string {
  const base = timebase(rate);
  const drop = dropFramesPerMinute(rate, dropFrame);
  let labelled = frames;
  if (drop > 0) {
    const perMinute = base * 60 - drop;
    const perTenMinutes = base * 600 - drop * 9;
    const remainder = frames % perTenMinutes;
    labelled += drop * 9 * Math.floor(frames / perTenMinutes) + (remainder < drop ? 0 : drop * Math.floor((remainder - drop) / perMinute));
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  const clock = [Math.floor(labelled / (base * 3600)), Math.floor(labelled / (base * 60)) % 60, Math.floor(labelled / base) % 60].map(pad).join(":");
  return `${clock}${drop > 0 ? ";" : ":"}${pad(labelled % base)}`;
}

/** The frame count a timecode label stands for. A `;` before the frames marks
 * drop-frame, which only the NTSC rates have. */
export function timecodeToFrames(timecode: string, rate: FrameRate): { frames: number; dropFrame: boolean } {
  const [, hours, minutes, seconds, separator, frames] = /^(\d+):(\d+):(\d+)([:;])(\d+)$/.exec(timecode) ?? [];
  if (frames === undefined) throw new Error(`Not a timecode: ${timecode}`);
  const base = timebase(rate);
  const drop = dropFramesPerMinute(rate, separator === ";");
  const totalMinutes = Number(hours) * 60 + Number(minutes);
  return {
    frames: (totalMinutes * 60 + Number(seconds)) * base + Number(frames) - drop * (totalMinutes - Math.floor(totalMinutes / 10)),
    dropFrame: drop > 0,
  };
}

interface FrameCut {
  /** Source frames the cut plays, counted from the start of the file. */
  inFrame: number;
  outFrame: number;
  /** Where it sits on the timeline. */
  startFrame: number;
  endFrame: number;
}

interface TimelinePlan {
  video: NonNullable<SourceProbe["video"]>;
  rate: FrameRate;
  cuts: FrameCut[];
  sourceFrames: number;
  durationFrames: number;
  /** The timecode of the source's first frame, as a frame count. */
  sourceStartFrames: number;
  /** Whether timecodes are written drop-frame (the source's own convention). */
  dropFrame: boolean;
}

function planTimeline(input: TimelineInput): TimelinePlan {
  const { video } = input.source;
  if (!video) throw new ClipTimelineError("timeline_video_required", "Timeline export needs a video source; this project's original media has no video");
  const rate = video.frameRate;
  const start = video.startTimecode ? timecodeToFrames(video.startTimecode, rate) : { frames: 0, dropFrame: false };
  const sourceFrames = wholeFrames(input.source.durationSec, rate);
  const cuts: FrameCut[] = [];
  for (const cut of input.cuts) {
    // Each cut sits where its own edited time says, so rounding never adds up
    // over many cuts and the timeline stays aligned with the captions.
    const startFrame = secondsToFrames(cut.editedStartSec, rate);
    const inFrame = Math.min(secondsToFrames(cut.sourceStartSec, rate), sourceFrames);
    const outFrame = Math.min(inFrame + secondsToFrames(cut.editedEndSec, rate) - startFrame, sourceFrames);
    if (outFrame <= inFrame) continue;
    cuts.push({ inFrame, outFrame, startFrame, endFrame: startFrame + outFrame - inFrame });
  }
  const last = cuts.at(-1);
  if (!last) throw new ClipTimelineError("timeline_empty", "Every kept range is shorter than one frame of this video, so there is nothing to export");
  return { video, rate, cuts, sourceFrames, durationFrames: last.endFrame, sourceStartFrames: start.frames, dropFrame: start.dropFrame };
}

// ---------------------------------------------------------------- XML

type XmlAttributes = Record<string, string | number>;
interface XmlNode {
  name: string;
  attrs?: XmlAttributes;
  children?: readonly XmlNode[];
  text?: string;
}

const xml = (name: string, content?: string | number | readonly XmlNode[], attrs?: XmlAttributes): XmlNode =>
  typeof content === "object" ? { name, attrs, children: content } : { name, attrs, text: content === undefined ? undefined : String(content) };

function escapeXml(value: string): string {
  return value
    .replace(/(?![\t\n\r])\p{Cc}/gu, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function serializeXml(node: XmlNode, depth = 0): string {
  const pad = "  ".repeat(depth);
  const attrs = Object.entries(node.attrs ?? {}).map(([key, value]) => ` ${key}="${escapeXml(String(value))}"`).join("");
  if (node.children?.length) {
    return `${pad}<${node.name}${attrs}>\n${node.children.map((child) => serializeXml(child, depth + 1)).join("\n")}\n${pad}</${node.name}>`;
  }
  if (node.text !== undefined) return `${pad}<${node.name}${attrs}>${escapeXml(node.text)}</${node.name}>`;
  return `${pad}<${node.name}${attrs}/>`;
}

function xmlDocument(doctype: string, root: XmlNode): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE ${doctype}>\n${serializeXml(root)}\n`;
}

/** The editor finds the source beside the timeline by this relative name. */
const mediaReference = (fileName: string) => encodeURIComponent(fileName);

// ------------------------------------------------------- FCP7 XML (xmeml v5)

function renderXmeml(input: TimelineInput, plan: TimelinePlan): string {
  const { rate, video } = plan;
  const audio = input.source.audio;
  const channels = audio?.channels ?? 0;
  const count = plan.cuts.length;
  const xmemlRate = () => xml("rate", [xml("timebase", timebase(rate)), xml("ntsc", isNtsc(rate) ? "TRUE" : "FALSE")]);
  const timecode = (startFrames: number) => xml("timecode", [
    xmemlRate(), xml("string", framesToTimecode(startFrames, rate, plan.dropFrame)), xml("frame", startFrames),
    xml("displayformat", plan.dropFrame ? "DF" : "NDF"),
  ]);
  const videoCharacteristics = () => xml("samplecharacteristics", [
    xmemlRate(), xml("width", video.width), xml("height", video.height),
    xml("anamorphic", "FALSE"), xml("pixelaspectratio", "square"), xml("fielddominance", "none"),
  ]);
  const audioCharacteristics = () => xml("samplecharacteristics", [xml("depth", 16), xml("samplerate", audio?.sampleRate ?? 48_000)]);
  const file = (first: boolean) => first
    ? xml("file", [
      xml("name", input.sourceFileName), xml("pathurl", mediaReference(input.sourceFileName)), xmemlRate(),
      xml("duration", plan.sourceFrames), timecode(plan.sourceStartFrames),
      xml("media", [
        xml("video", [videoCharacteristics()]),
        ...(audio ? [xml("audio", [audioCharacteristics(), xml("channelcount", channels)])] : []),
      ]),
    ], { id: "file-1" })
    : xml("file", undefined, { id: "file-1" });

  const videoId = (index: number) => `clipitem-${index + 1}`;
  const audioId = (channel: number, index: number) => `clipitem-${count + channel * count + index + 1}`;
  // Every item names the whole video + audio group it belongs to.
  const links = (index: number) => [
    xml("link", [xml("linkclipref", videoId(index)), xml("mediatype", "video"), xml("trackindex", 1), xml("clipindex", index + 1)]),
    ...Array.from({ length: channels }, (_, channel) =>
      xml("link", [xml("linkclipref", audioId(channel, index)), xml("mediatype", "audio"), xml("trackindex", channel + 1), xml("clipindex", index + 1), xml("groupindex", 1)])),
  ];
  const clipitem = (id: string, cut: FrameCut, index: number, mediaType: "video" | "audio", trackIndex: number) => xml("clipitem", [
    xml("name", input.sourceFileName), xml("enabled", "TRUE"), xml("duration", plan.sourceFrames), xmemlRate(),
    xml("start", cut.startFrame), xml("end", cut.endFrame), xml("in", cut.inFrame), xml("out", cut.outFrame),
    file(mediaType === "video" && index === 0),
    xml("sourcetrack", [xml("mediatype", mediaType), xml("trackindex", trackIndex)]),
    ...links(index),
  ], { id });

  const videoTrack = xml("track", plan.cuts.map((cut, index) => clipitem(videoId(index), cut, index, "video", 1)));
  const audioTracks = Array.from({ length: channels }, (_, channel) =>
    xml("track", plan.cuts.map((cut, index) => clipitem(audioId(channel, index), cut, index, "audio", channel + 1))));

  return xmlDocument("xmeml", xml("xmeml", [
    xml("sequence", [
      xml("name", input.title), xml("duration", plan.durationFrames), xmemlRate(), timecode(0),
      xml("media", [
        xml("video", [xml("format", [videoCharacteristics()]), videoTrack]),
        ...(audio ? [xml("audio", [xml("numOutputChannels", channels), xml("format", [audioCharacteristics()]), ...audioTracks])] : []),
      ]),
    ], { id: "sequence-1" }),
  ], { version: 5 }));
}

// ------------------------------------------------------------ FCPXML 1.11

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** FCPXML times are exact fractions of a second: 30 frames of 30000/1001 is
 * 1001/1000s. */
function rationalTime(frames: number, rate: FrameRate): string {
  if (frames === 0) return "0s";
  const numerator = frames * rate.denominator;
  const divisor = gcd(numerator, rate.numerator);
  const reduced = rate.numerator / divisor;
  return reduced === 1 ? `${numerator / divisor}s` : `${numerator / divisor}/${reduced}s`;
}

/** Sequence sample rates FCPXML names; any other rate leaves the attribute out. */
const FCPXML_AUDIO_RATES: Record<number, string> = {
  32000: "32k", 44100: "44.1k", 48000: "48k", 88200: "88.2k", 96000: "96k", 176400: "176.4k", 192000: "192k",
};

function renderFcpxml(input: TimelineInput, plan: TimelinePlan): string {
  const { rate, video } = plan;
  const audio = input.source.audio;
  const time = (frames: number) => rationalTime(frames, rate);
  const sequenceAudioRate = audio ? FCPXML_AUDIO_RATES[audio.sampleRate] : undefined;
  const tcFormat = plan.dropFrame ? "DF" : "NDF";
  const assetAttributes: XmlAttributes = {
    id: "r2", name: input.sourceFileName, start: time(plan.sourceStartFrames), duration: time(plan.sourceFrames),
    hasVideo: 1, format: "r1", videoSources: 1,
    ...(audio ? { hasAudio: 1, audioSources: 1, audioChannels: audio.channels, audioRate: audio.sampleRate } : {}),
  };
  const sequenceAttributes: XmlAttributes = {
    format: "r1", duration: time(plan.durationFrames), tcStart: "0s", tcFormat,
    ...(audio ? { audioLayout: audio.channels === 1 ? "mono" : audio.channels === 2 ? "stereo" : "surround" } : {}),
    ...(sequenceAudioRate ? { audioRate: sequenceAudioRate } : {}),
  };
  return xmlDocument("fcpxml", xml("fcpxml", [
    xml("resources", [
      xml("format", undefined, { id: "r1", frameDuration: time(1), width: video.width, height: video.height }),
      xml("asset", [xml("media-rep", undefined, { kind: "original-media", src: mediaReference(input.sourceFileName) })], assetAttributes),
    ]),
    xml("library", [
      xml("event", [
        xml("project", [
          xml("sequence", [
            xml("spine", plan.cuts.map((cut) => xml("asset-clip", undefined, {
              ref: "r2", offset: time(cut.startFrame), name: input.sourceFileName,
              start: time(plan.sourceStartFrames + cut.inFrame), duration: time(cut.endFrame - cut.startFrame), format: "r1", tcFormat,
            }))),
          ], sequenceAttributes),
        ], { name: input.title }),
      ], { name: "Narriflow" }),
    ]),
  ], { version: "1.11" }));
}

// ------------------------------------------------------------ CMX3600 EDL

/** Record timecode starts at the hour, as broadcast edit lists do. */
const EDL_RECORD_START = "01:00:00";

function edlText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 70);
}

function renderEdl(input: TimelineInput, plan: TimelinePlan): string {
  const { rate, dropFrame } = plan;
  const track = input.source.audio ? "AA/V" : "V";
  const timecode = (frames: number) => framesToTimecode(frames, rate, dropFrame);
  const recordStart = timecodeToFrames(`${EDL_RECORD_START}${dropFrame ? ";" : ":"}00`, rate).frames;
  const events = plan.cuts.flatMap((cut, index) => [
    `${String(index + 1).padStart(3, "0")}  AX       ${track.padEnd(5)} C        ${[
      timecode(plan.sourceStartFrames + cut.inFrame), timecode(plan.sourceStartFrames + cut.outFrame),
      timecode(recordStart + cut.startFrame), timecode(recordStart + cut.endFrame),
    ].join(" ")}`,
    `* FROM CLIP NAME: ${edlText(input.sourceFileName)}`,
  ]);
  return `TITLE: ${edlText(input.title)}\nFCM: ${dropFrame ? "DROP FRAME" : "NON-DROP FRAME"}\n\n${events.join("\n")}\n`;
}
