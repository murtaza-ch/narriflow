import { z } from "zod";
import {
  assertSupportedClipCompositionEvidenceVersion,
} from "./clip-composition-evidence";
import { deletedRangesSchema } from "./edit-ranges";

/**
 * Persisted speaker-layout plan shared by the worker renderer and the studio
 * preview. Its engine discriminator keeps Automatic shot analysis separate
 * from explicit Split analysis even though both use the same scene envelope.
 * Coordinates are normalized against the source frame;
 * times are seconds on the edited clip timeline (after deleted ranges).
 *
 * This is deliberately separate from Clip.layoutAnalysis, which describes
 * identity-complete Screen/PiP evidence. Auto speaker framing has a different
 * lifecycle: it is produced for every video clip, invalidated by source-range
 * edits, and consumed on every aspect-ratio preview/render.
 */

const unitInterval = z.number().finite().min(0).max(1);
const positiveZoom = z.number().finite().min(1).max(4);

export const CLIP_AUTO_LAYOUT_VERSION = 2 as const;
export const CLIP_AUTO_LAYOUT_ENGINE = "shot-layout-v2" as const;

export const clipAutoLayoutSubjectSchema = z.object({
  id: z.string().min(1).max(100),
  cxNorm: unitInterval,
  cyNorm: unitInterval,
  zoom: positiveZoom,
});

const clipAutoLayoutSubjectsSchema = z
  .array(clipAutoLayoutSubjectSchema)
  .max(4)
  .superRefine((subjects, ctx) => {
    if (new Set(subjects.map((subject) => subject.id)).size !== subjects.length) {
      ctx.addIssue({
        code: "custom",
        message: "automatic layout subject ids must be unique within a segment",
      });
    }
  });

export const clipAutoLayoutSingleSegmentSchema = z.object({
  startSec: z.number().finite().min(0),
  endSec: z.number().finite().gt(0),
  layout: z.literal("single"),
  cxNorm: unitInterval,
  cyNorm: unitInterval.default(0.5),
  zoom: positiveZoom.default(1),
  subjects: clipAutoLayoutSubjectsSchema,
});

export const clipAutoLayoutTwoUpSegmentSchema = z.object({
  startSec: z.number().finite().min(0),
  endSec: z.number().finite().gt(0),
  layout: z.literal("two-up"),
  topCxNorm: unitInterval,
  bottomCxNorm: unitInterval,
  topCyNorm: unitInterval.default(0.5),
  bottomCyNorm: unitInterval.default(0.5),
  topZoom: positiveZoom.default(1),
  bottomZoom: positiveZoom.default(1),
  subjects: clipAutoLayoutSubjectsSchema,
});

const clipSplitLayoutSingleSegmentSchema = clipAutoLayoutSingleSegmentSchema.omit({
  subjects: true,
});
const clipSplitLayoutTwoUpSegmentSchema = clipAutoLayoutTwoUpSegmentSchema.omit({
  subjects: true,
});

export const clipAutoLayoutSegmentSchema = z.discriminatedUnion("layout", [
  clipAutoLayoutSingleSegmentSchema,
  clipAutoLayoutTwoUpSegmentSchema,
]);

export const clipSplitLayoutSegmentSchema = z.discriminatedUnion("layout", [
  clipSplitLayoutSingleSegmentSchema,
  clipSplitLayoutTwoUpSegmentSchema,
]);

export type ClipAutoLayoutSegment = z.infer<
  typeof clipAutoLayoutSegmentSchema
>;
export type ClipAutoLayoutSubject = z.infer<typeof clipAutoLayoutSubjectSchema>;
export type ClipSplitLayoutSegment = z.infer<
  typeof clipSplitLayoutSegmentSchema
>;

const autoSegmentListSchema = z.array(clipAutoLayoutSegmentSchema).max(64);
const splitSegmentListSchema = z.array(clipSplitLayoutSegmentSchema).max(64);

function speakerLayoutAnalysisSchema<
  TVersion extends 1 | 2,
  TEngine extends typeof CLIP_AUTO_LAYOUT_ENGINE | "explicit-split-v1",
  TSegmentList extends
    | typeof autoSegmentListSchema
    | typeof splitSegmentListSchema,
>(
  version: TVersion,
  engine: TEngine,
  segmentListSchema: TSegmentList,
) {
  return z
    .object({
    version: z.literal(version),
    engine: z.literal(engine),
    /** Stable logical identity of the source media analyzed. */
    sourceIdentity: z.string().min(1),
    analyzedAtISO: z.string().datetime(),
    /** Raw source window represented by this plan. */
    clipStartSec: z.number().finite().min(0),
    clipEndSec: z.number().finite().gt(0),
    /** Source ranges removed before plan times are interpreted. */
    deletedRanges: deletedRangesSchema,
    /** Edited duration all segment boundaries must cover. */
    editedDurationSec: z.number().finite().gt(0),
    sourceWidth: z.number().int().positive(),
    sourceHeight: z.number().int().positive(),
    /** Full portrait-capable plan, including stacked two-up segments. */
    segments: segmentListSchema,
    /** Same analysis with two-up demoted for outputs lacking tile separation. */
    noSplitSegments: segmentListSchema,
    shotCount: z.number().int().min(0),
    soloShotCount: z.number().int().min(0),
    multiShotCount: z.number().int().min(0),
    twoUpSegmentCount: z.number().int().min(0),
    speakerCount: z.number().int().min(0),
    mappedSpeakerCount: z.number().int().min(0),
    })
    .superRefine((analysis, ctx) => {
    if (analysis.clipEndSec <= analysis.clipStartSec) {
      ctx.addIssue({
        code: "custom",
        path: ["clipEndSec"],
        message: "clipEndSec must be greater than clipStartSec",
      });
    }

    for (const field of ["segments", "noSplitSegments"] as const) {
      const segments = (
        analysis as unknown as Record<
          typeof field,
          readonly { startSec: number; endSec: number }[]
        >
      )[field];
      let cursor = 0;
      for (let index = 0; index < segments.length; index++) {
        const segment = segments[index]!;
        if (segment.endSec <= segment.startSec) {
          ctx.addIssue({
            code: "custom",
            path: [field, index, "endSec"],
            message: "segment endSec must be greater than startSec",
          });
        }
        if (Math.abs(segment.startSec - cursor) > 0.075) {
          ctx.addIssue({
            code: "custom",
            path: [field, index, "startSec"],
            message: "segments must be contiguous and begin at zero",
          });
        }
        cursor = segment.endSec;
      }
      if (
        segments.length > 0 &&
        Math.abs(cursor - analysis.editedDurationSec) > 0.075
      ) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: "segments must cover editedDurationSec",
        });
      }
    }
    });
}

/** Automatic shot/speaker analysis. This schema cannot accept explicit Split
 * evidence, keeping the autoLayoutAnalysis write boundary engine-safe. */
export const clipAutoLayoutAnalysisSchema = speakerLayoutAnalysisSchema(
  CLIP_AUTO_LAYOUT_VERSION,
  CLIP_AUTO_LAYOUT_ENGINE,
  autoSegmentListSchema,
);

/** Explicit Split detector evidence. It shares geometry with Automatic
 * analysis but has a separate schema, storage column, and lifecycle. */
export const clipSplitLayoutAnalysisSchema = speakerLayoutAnalysisSchema(
  1,
  "explicit-split-v1",
  splitSegmentListSchema,
);

export const clipSplitLayoutFailureSchema = z.object({
  version: z.literal(1),
  engine: z.literal("explicit-split-v1"),
  state: z.literal("failed"),
  sourceIdentity: z.string().min(1),
  inputFingerprint: z.string().regex(/^[0-9a-f]{16}$/),
  analyzedAtISO: z.string().datetime(),
  reason: z.enum([
    "broll_conflict",
    "detection_unavailable",
    "insufficient_clusters",
    "empty_plan",
    "no_two_up_segments",
    "tiles_not_distinct",
  ]),
});

export type ClipAutoLayoutAnalysis = z.infer<
  typeof clipAutoLayoutAnalysisSchema
>;

export type ClipSplitLayoutAnalysis = z.infer<
  typeof clipSplitLayoutAnalysisSchema
>;
export type ClipSplitLayoutFailure = z.infer<
  typeof clipSplitLayoutFailureSchema
>;
export type ClipSplitLayoutOutcome =
  | ClipSplitLayoutAnalysis
  | ClipSplitLayoutFailure;

export function parseClipAutoLayoutAnalysis(
  value: unknown,
): ClipAutoLayoutAnalysis | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value === "object" &&
    !Array.isArray(value) &&
    value !== null &&
    (value as Record<string, unknown>).version === 1 &&
    (value as Record<string, unknown>).engine === "shot-layout-v1"
  ) {
    return null;
  }
  assertSupportedClipCompositionEvidenceVersion(
    value,
    { version: CLIP_AUTO_LAYOUT_VERSION, engine: CLIP_AUTO_LAYOUT_ENGINE },
    ["explicit-split-v1"],
  );
  const parsed = clipAutoLayoutAnalysisSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseClipSplitLayoutAnalysis(
  value: unknown,
): ClipSplitLayoutAnalysis | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value === "object" &&
    !Array.isArray(value) &&
    value !== null &&
    (value as Record<string, unknown>).engine === CLIP_AUTO_LAYOUT_ENGINE
  ) {
    return null;
  }
  assertSupportedClipCompositionEvidenceVersion(
    value,
    { version: 1, engine: "explicit-split-v1" },
    [CLIP_AUTO_LAYOUT_ENGINE],
  );
  const parsed = clipSplitLayoutAnalysisSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseClipSplitLayoutFailure(
  value: unknown,
): ClipSplitLayoutFailure | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value === "object" &&
    !Array.isArray(value) &&
    value !== null &&
    (value as Record<string, unknown>).engine === CLIP_AUTO_LAYOUT_ENGINE
  ) {
    return null;
  }
  assertSupportedClipCompositionEvidenceVersion(
    value,
    { version: 1, engine: "explicit-split-v1" },
    [CLIP_AUTO_LAYOUT_ENGINE],
  );
  const parsed = clipSplitLayoutFailureSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseClipSplitLayoutOutcome(
  value: unknown,
): ClipSplitLayoutOutcome | null {
  return (
    parseClipSplitLayoutAnalysis(value) ?? parseClipSplitLayoutFailure(value)
  );
}

const RANGE_EPSILON_SEC = 0.05;

/**
 * The plan's own source window and deleted ranges are its invalidation key.
 * Caption text, styling, music, and other editor changes do not force an
 * expensive re-analysis because none can move a detected face.
 */
export function clipAutoLayoutMatchesInputs(
  analysis: ClipAutoLayoutAnalysis | ClipSplitLayoutAnalysis,
  input: {
    clipStartSec: number;
    clipEndSec: number;
    deletedRanges: Array<{ startSec: number; endSec: number }>;
  },
): boolean {
  if (
    Math.abs(analysis.clipStartSec - input.clipStartSec) > RANGE_EPSILON_SEC ||
    Math.abs(analysis.clipEndSec - input.clipEndSec) > RANGE_EPSILON_SEC
  ) {
    return false;
  }
  if (analysis.deletedRanges.length !== input.deletedRanges.length) return false;
  return analysis.deletedRanges.every((range, index) => {
    const other = input.deletedRanges[index];
    return Boolean(
      other &&
        Math.abs(range.startSec - other.startSec) <= RANGE_EPSILON_SEC &&
        Math.abs(range.endSec - other.endSec) <= RANGE_EPSILON_SEC,
    );
  });
}
