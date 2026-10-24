import { z } from "zod";
import type { SourceProbe } from "./source-probe";
import {
  parseSuppliedCaptions,
  SUPPLIED_CAPTIONS_MAX_BYTES,
  SUPPLIED_CAPTIONS_MAX_CUES,
} from "./supplied-captions";
import { transcriptUtteranceSchema, type TranscriptUtterance } from "./transcript";

/** Captioned videos: a finished short, such as an AI-generated one, captioned
 * from speech or from supplied captions, framed Fit or Center, and exported.
 * The settings are frozen into the generation's Content Pack at acceptance
 * (`captionedVideo`, with `mode: "caption_only"`), so every stage reads one
 * record. This file imports nothing from clip.ts or content-pack.ts, which
 * import it. */

// Mirrors clipAspectRatioSchema and clipRenderResolutionSchema (clip.ts imports
// the Content Pack, so they can't be imported here); a test keeps them equal.
const aspectRatioSchema = z.enum(["9:16", "1:1", "16:9", "4:5"]);
const resolutionSchema = z.enum(["720p", "1080p"]);
export type CaptionedVideoAspectRatio = z.infer<typeof aspectRatioSchema>;

/** Fit keeps the whole frame and pads the rest. Center fills the frame with a
 * centered cover crop. */
export const captionedVideoFramingSchema = z.enum(["fit", "center"]);

/** What to export. The Finishing settings use the same two field names. */
export const captionedVideoExportOptionsSchema = z.strictObject({
  aspectRatios: z.array(aspectRatioSchema).min(1).max(4)
    .refine((values) => new Set(values).size === values.length, "Choose each format once")
    .default(["9:16"]),
  resolution: resolutionSchema.default("1080p")
    .describe("The plan's resolution rule applies; the response reports what was granted"),
});

/** Caption sources as callers state them. */
export const captionedVideoCaptionsRequestSchema = z.discriminatedUnion("source", [
  z.strictObject({ source: z.literal("auto") }).describe("Transcribe the speech. A video without audio gets no captions."),
  z.strictObject({ source: z.literal("none") }).describe("Export without captions"),
  z.strictObject({
    source: z.literal("supplied"),
    // Transport bound only; the parser enforces the exact byte limit with a typed error.
    text: z.string().min(1).max(SUPPLIED_CAPTIONS_MAX_BYTES * 4).describe(`SRT or WebVTT text, up to ${SUPPLIED_CAPTIONS_MAX_BYTES / 1024} KiB and ${SUPPLIED_CAPTIONS_MAX_CUES} cues`),
  }),
]);

export const captionedVideoOptionsSchema = captionedVideoExportOptionsSchema.extend({
  framing: captionedVideoFramingSchema.default("fit"),
  captions: captionedVideoCaptionsRequestSchema.default({ source: "auto" }),
});
export type CaptionedVideoOptions = z.input<typeof captionedVideoOptionsSchema>;

/** The frozen settings. Supplied captions are already normalized into
 * utterances and timed words. */
export const captionedVideoSettingsSchema = z.strictObject({
  framing: captionedVideoFramingSchema,
  aspectRatios: captionedVideoExportOptionsSchema.shape.aspectRatios.unwrap(),
  resolution: resolutionSchema,
  captions: z.discriminatedUnion("source", [
    z.strictObject({ source: z.literal("auto") }),
    z.strictObject({ source: z.literal("none") }),
    z.strictObject({ source: z.literal("supplied"), utterances: z.array(transcriptUtteranceSchema).min(1).max(SUPPLIED_CAPTIONS_MAX_CUES) }),
  ]),
});
export type CaptionedVideoSettings = z.infer<typeof captionedVideoSettingsSchema>;

/** Validates options and normalizes supplied captions. Throws a
 * SuppliedCaptionsError for malformed, empty, or oversized captions. */
export function buildCaptionedVideoSettings(input: CaptionedVideoOptions): CaptionedVideoSettings {
  const options = captionedVideoOptionsSchema.parse(input);
  return {
    framing: options.framing,
    aspectRatios: options.aspectRatios,
    resolution: options.resolution,
    captions: options.captions.source === "supplied"
      ? { source: "supplied", utterances: parseSuppliedCaptions(options.captions.text) }
      : { source: options.captions.source },
  };
}

/** The Studio edits that express a framing. Fit is a background (the source
 * letterboxes onto black), Center is the explicit centered cover crop; either
 * way the shared composition plan renders it, so Studio and export agree. */
export function captionedVideoFramingEdits(framing: CaptionedVideoSettings["framing"]) {
  return framing === "fit"
    ? { background: { mode: "color" as const, color: null, imageUrl: null } }
    : { framing: { mode: "center" as const } };
}

export type TranscriptPlan =
  | { kind: "speech_to_text" }
  | { kind: "supplied"; utterances: TranscriptUtterance[] }
  | { kind: "empty"; reason: "captions_none" | "no_audio_stream" };

/** The one place speech-to-text is decided. It is skipped when the caller
 * supplied or declined captions, and whenever the probed source has no audio
 * stream; an unprobed source is assumed to have speech. */
export function planTranscript(input: { captionedVideo?: CaptionedVideoSettings; sourceProbe: SourceProbe | null }): TranscriptPlan {
  const captions = input.captionedVideo?.captions;
  if (captions?.source === "none") return { kind: "empty", reason: "captions_none" };
  if (captions?.source === "supplied") return { kind: "supplied", utterances: captions.utterances };
  if (input.sourceProbe && input.sourceProbe.audio === null) return { kind: "empty", reason: "no_audio_stream" };
  return { kind: "speech_to_text" };
}

/** Operation Status carries this when Center crops away part of the frame. */
export const framingNoticeSchema = z.strictObject({
  code: z.literal("framing_degraded"),
  aspectRatio: aspectRatioSchema,
  croppedPercent: z.number().int().min(1).max(99).describe("How much of the source frame the centered cover crop discards"),
});
export type FramingNotice = z.infer<typeof framingNoticeSchema>;

function ratioValue(aspectRatio: CaptionedVideoAspectRatio) {
  const [width, height] = aspectRatio.split(":").map(Number);
  return width! / height!;
}

/** Center is a fixed cover crop with no subject detection, so whatever it
 * discards, including a subject, is lost. This reports each requested format
 * where the crop discards part of the frame. Fit never does. */
export function captionedVideoFramingNotices(settings: Pick<CaptionedVideoSettings, "framing" | "aspectRatios">, sourceProbe: SourceProbe | null): FramingNotice[] {
  if (settings.framing !== "center" || !sourceProbe?.video) return [];
  const source = sourceProbe.video.width / sourceProbe.video.height;
  return settings.aspectRatios.flatMap((aspectRatio) => {
    const target = ratioValue(aspectRatio);
    const croppedPercent = Math.min(99, Math.round((1 - Math.min(target / source, source / target)) * 100));
    return croppedPercent >= 1 ? [{ code: "framing_degraded" as const, aspectRatio, croppedPercent }] : [];
  });
}
