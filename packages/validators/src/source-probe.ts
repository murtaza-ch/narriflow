import { z } from "zod";

/** A frame rate as the exact fraction editors count with: 30000/1001 is
 * 29.97 fps, never 29.97. */
export const frameRateSchema = z.strictObject({
  numerator: z.number().int().positive(),
  denominator: z.number().int().positive(),
});
export type FrameRate = z.infer<typeof frameRateSchema>;

/** A timecode label as ffprobe reports an embedded start timecode: a `;`
 * before the frames marks drop-frame. */
export const SOURCE_TIMECODE_PATTERN = /^\d{2}:\d{2}:\d{2}[:;]\d{2,3}$/;

/** Complete header facts from the worker's sole ffprobe parser. Null means the
 * container/codec did not report the fact. Sample evidence is bounded and is
 * deliberately not persisted as proof of a full decode. */
const nullableNumber = z.number().finite().nullable();
const nullableInteger = z.number().int().safe().nullable();
const nullableText = z.string().max(256).nullable();
const streamFacts = {
  index: z.number().int().nonnegative(),
  codec: nullableText,
  profile: nullableText,
  timeBase: frameRateSchema.nullable(),
  startPts: nullableInteger,
  startTimeSec: nullableNumber,
  durationTs: nullableInteger,
  durationSec: z.number().nonnegative().nullable(),
  endTimeSec: nullableNumber,
  frameCount: z.number().int().nonnegative().safe().nullable(),
  bitRate: z.number().nonnegative().nullable(),
};

export const mediaFactsSchema = z.strictObject({
  format: z.strictObject({
    name: nullableText,
    startTimeSec: nullableNumber,
    durationSec: z.number().nonnegative().nullable(),
    sizeBytes: z.number().int().nonnegative().safe().nullable(),
    bitRate: z.number().nonnegative().nullable(),
  }),
  attachedPictureCount: z.number().int().nonnegative(),
  videos: z.array(z.strictObject({
    ...streamFacts,
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    codedWidth: z.number().int().positive().nullable(),
    codedHeight: z.number().int().positive().nullable(),
    displayWidth: z.number().positive().nullable(),
    displayHeight: z.number().positive().nullable(),
    sampleAspectRatio: frameRateSchema.nullable(),
    displayMatrix: z.array(z.number().int().min(-2147483648).max(2147483647)).length(9).nullable(),
    // Matches ffprobe/libavutil: counterclockwise degrees. A reflection's
    // orientation must be read from the full matrix, not from this angle alone.
    rotationDeg: nullableNumber,
    reflected: z.boolean().nullable(),
    avgFrameRate: frameRateSchema.nullable(),
    rFrameRate: frameRateSchema.nullable(),
    pixelFormat: nullableText,
    colorRange: nullableText,
    colorSpace: nullableText,
    colorTransfer: nullableText,
    colorPrimaries: nullableText,
    chromaLocation: nullableText,
    fieldOrder: nullableText,
    masteringDisplay: z.strictObject({
      redX: nullableNumber, redY: nullableNumber,
      greenX: nullableNumber, greenY: nullableNumber,
      blueX: nullableNumber, blueY: nullableNumber,
      whitePointX: nullableNumber, whitePointY: nullableNumber,
      minLuminance: nullableNumber, maxLuminance: nullableNumber,
    }).nullable(),
    contentLight: z.strictObject({ maxContent: nullableNumber, maxAverage: nullableNumber }).nullable(),
    dolbyVision: z.strictObject({
      profile: nullableInteger, level: nullableInteger,
      rpuPresent: z.boolean(), enhancementLayerPresent: z.boolean(), baseLayerPresent: z.boolean(),
      baseLayerSignalCompatibilityId: nullableInteger,
    }).nullable(),
  })),
  audios: z.array(z.strictObject({
    ...streamFacts,
    sampleRate: z.number().int().positive().nullable(),
    channels: z.number().int().positive().nullable(),
    channelLayout: nullableText,
    sampleFormat: nullableText,
    initialPadding: z.number().int().nonnegative().nullable(),
    trailingPadding: z.number().int().nonnegative().nullable(),
  })),
});
export type MediaFacts = z.infer<typeof mediaFactsSchema>;

/** What a Project's source file is, measured once at ingest: the facts a
 * timeline for an editor must repeat exactly. `video` is null for audio-only
 * sources, and `startTimecode` is null when the file carries none (it then
 * starts at 00:00:00:00). */
export const sourceProbeSchema = z.strictObject({
  durationSec: z.number().positive(),
  // Timeline-only callers can supply the minimal probe. Cache reuse requires
  // these complete facts; absence is never evidence of an identity transform.
  facts: mediaFactsSchema.optional(),
  video: z.strictObject({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    frameRate: frameRateSchema,
    startTimecode: z.string().regex(SOURCE_TIMECODE_PATTERN).nullable(),
  }).nullable(),
  audio: z.strictObject({
    sampleRate: z.number().int().positive(),
    channels: z.number().int().positive(),
  }).nullable(),
});
export type SourceProbe = z.infer<typeof sourceProbeSchema>;

/** The rates timelines are cut at: the film, PAL, NTSC, and high-frame-rate
 * standards editors share. */
const STANDARD_FRAME_RATES: readonly FrameRate[] = [
  { numerator: 24000, denominator: 1001 },
  { numerator: 24, denominator: 1 },
  { numerator: 25, denominator: 1 },
  { numerator: 30000, denominator: 1001 },
  { numerator: 30, denominator: 1 },
  { numerator: 48000, denominator: 1001 },
  { numerator: 48, denominator: 1 },
  { numerator: 50, denominator: 1 },
  { numerator: 60000, denominator: 1001 },
  { numerator: 60, denominator: 1 },
];

// 23.976 and 24 differ by 0.1%; a measured rate within a fifth of that is the
// standard one, however it was rounded (23.98, 29.97003, 30000/1001).
const STANDARD_RATE_TOLERANCE = 0.0002;

/** The standard fraction a measured rate was meant to be, or null when it
 * matches none (variable-rate video, odd rates like 12.5 or 90000). */
export function standardFrameRate(fps: number): FrameRate | null {
  if (!Number.isFinite(fps) || fps <= 0) return null;
  const nearest = STANDARD_FRAME_RATES.reduce((best, rate) =>
    Math.abs(rate.numerator / rate.denominator - fps) < Math.abs(best.numerator / best.denominator - fps) ? rate : best);
  return Math.abs(nearest.numerator / nearest.denominator - fps) / fps <= STANDARD_RATE_TOLERANCE ? nearest : null;
}

/** Whether a stored rate is exactly one of the standard fractions. */
export function isStandardFrameRate(rate: FrameRate): boolean {
  return STANDARD_FRAME_RATES.some((standard) => standard.numerator * rate.denominator === standard.denominator * rate.numerator);
}
