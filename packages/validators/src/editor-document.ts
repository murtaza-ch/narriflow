import { z } from "zod";

import { captionPresetsEqual, captionPresetSchema } from "./caption-preset";
import { activeManualBrollMotionWindow } from "./broll";
import {
  buildEditedTimeMap,
  deletedRangesSchema,
  editedToSource,
  isSourceTimeDeleted,
  normalizeDeletedRanges,
  sourceRangeSchema,
  sourceRangeToEdited,
  sourceToEdited,
  subtractDeletedRange,
  type ClipWindow,
  type EditedTimeMap,
  type SourceRange,
} from "./edit-ranges";
import {
  studioEditsEqual,
  studioEditsSchema,
  type StudioSfxPlacement,
  type StudioTextLayer,
  type StudioSpeakerLayoutOverride,
} from "./studio-edits";
import {
  transcriptSlicesEqual,
  transcriptUtteranceSchema,
} from "./transcript";
import {
  censorSegmentSchema,
  mediaMotionSchema,
  sceneBlockSchema,
  sceneBlocksEqual,
  sceneContentSchema,
  sceneDurationIssue,
  sceneMotionSchema,
  sortSceneBlocks,
  timedEditsEqual,
  TIMED_EDIT_LIMITS,
  visualAssetReferenceSchema,
  type SceneBlock,
  type SceneMotion,
  type CensorSegment,
  type MediaMotion,
} from "./timed-edits";

// The single editor document (vizard-parity.md Phase A step 2): everything the
// studio can mutate lives in one value so undo/redo, reset, and the atomic
// save contract all operate on one shape instead of four independently-PATCHed
// fragments. Clip boundaries are part of the document so in-studio trim
// (Phase B step 13) becomes just another undoable mutation.

export const EDITOR_DOCUMENT_VERSION = 2 as const;

export const EDITOR_BROLL_PLACEMENT_LIMIT = 64;

export const brollPlacementSchema = z
  .strictObject({
    id: z.string().uuid(),
    asset: visualAssetReferenceSchema,
    provenance: z.enum(["uploaded", "generated", "extracted"]),
    mediaKind: z.enum(["image", "video"]),
    startSec: z.number().finite().nonnegative(),
    endSec: z.number().finite().positive(),
    sourceStartSec: z.number().finite().nonnegative().nullable(),
    sourceEndSec: z.number().finite().positive().nullable(),
  })
  .superRefine((placement, context) => {
    if (placement.endSec <= placement.startSec) {
      context.addIssue({
        code: "custom",
        path: ["endSec"],
        message: "endSec must be greater than startSec",
      });
    }
    if (
      placement.mediaKind === "image" &&
      (placement.sourceStartSec !== null || placement.sourceEndSec !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["sourceStartSec"],
        message: "image B-roll cannot have a source range",
      });
    }
    if (placement.mediaKind === "video") {
      if (
        placement.sourceStartSec === null ||
        placement.sourceEndSec === null ||
        placement.sourceEndSec <= placement.sourceStartSec
      ) {
        context.addIssue({
          code: "custom",
          path: ["sourceEndSec"],
          message: "video B-roll requires a valid source range",
        });
      } else if (
        placement.endSec - placement.startSec >
        placement.sourceEndSec - placement.sourceStartSec + 0.001
      ) {
        context.addIssue({
          code: "custom",
          path: ["sourceEndSec"],
          message: "video B-roll cannot exceed its source range",
        });
      }
    }
  });

export type BrollPlacement = z.infer<typeof brollPlacementSchema>;

const editorDocumentV2Schema = z
  .strictObject({
    version: z.literal(EDITOR_DOCUMENT_VERSION),
    clipStartSec: z.number().nonnegative(),
    clipEndSec: z.number().nonnegative(),
    captionPreset: captionPresetSchema,
    transcriptSlice: z.array(transcriptUtteranceSchema),
    studioEdits: studioEditsSchema,
    brollUrl: z.string().url().nullable().default(null),
    brollPlacements: z
      .array(brollPlacementSchema)
      .max(EDITOR_BROLL_PLACEMENT_LIMIT)
      .default([]),
    deletedRanges: deletedRangesSchema,
		sceneBlocks: z.array(sceneBlockSchema).max(TIMED_EDIT_LIMITS.sceneBlocks).default([]),
		censorSegments: z.array(censorSegmentSchema).max(TIMED_EDIT_LIMITS.censorSegments).default([]),
		mediaMotions: z.array(mediaMotionSchema).max(TIMED_EDIT_LIMITS.mediaMotions).default([]),
  })
  .refine((doc) => doc.clipEndSec > doc.clipStartSec, {
    message: "clipEndSec must be greater than clipStartSec",
  })
  .superRefine((doc, context) => {
    const unique = (values: readonly { id: string }[], path: string) => {
      if (new Set(values.map((value) => value.id)).size !== values.length) {
        context.addIssue({ code: "custom", path: [path], message: "ids must be unique" });
      }
    };
    unique(doc.sceneBlocks, "sceneBlocks");
    unique(doc.censorSegments, "censorSegments");
    unique(doc.mediaMotions, "mediaMotions");
    unique(doc.brollPlacements, "brollPlacements");

    const blocks = sortSceneBlocks(doc.sceneBlocks);
    let insertedBeforeSec = 0;
    const editedTimeMap = buildEditedTimeMap(doc.deletedRanges, {
      startSec: doc.clipStartSec,
      endSec: doc.clipEndSec,
    });
    const sourceDurationSec = editedTimeMap.editedDurationSec;
		const manualBrollWindow = activeManualBrollMotionWindow({
			brollUrl: doc.brollUrl,
			assetBackedPlacementCount: doc.brollPlacements.length,
			editedDurationSec: sourceDurationSec,
		});
    const orderedBroll = [...doc.brollPlacements].sort(
      (left, right) => left.startSec - right.startSec || left.id.localeCompare(right.id),
    );
    orderedBroll.forEach((placement, index) => {
      const previous = orderedBroll[index - 1];
      if (placement.endSec > sourceDurationSec + 0.001) {
        context.addIssue({
          code: "custom",
          path: ["brollPlacements", index, "endSec"],
          message: "B-roll placement is outside the edited source timeline",
        });
      }
      if (previous && placement.startSec < previous.endSec) {
        context.addIssue({
          code: "custom",
          path: ["brollPlacements", index, "startSec"],
          message: "B-roll placements cannot overlap",
        });
      }
    });
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index]!;
      const previous = blocks[index - 1];
      if (previous && block.anchorSec < previous.anchorSec + previous.durationSec) {
        context.addIssue({ code: "custom", path: ["sceneBlocks", index, "anchorSec"], message: "scene blocks cannot overlap" });
      }
      if (block.anchorSec < insertedBeforeSec || block.anchorSec > sourceDurationSec + insertedBeforeSec) {
        context.addIssue({ code: "custom", path: ["sceneBlocks", index, "anchorSec"], message: "scene anchor is outside the edited timeline" });
      }
      insertedBeforeSec += block.durationSec;
    }

    const sceneIds = new Set(doc.sceneBlocks.map((scene) => scene.id));
    const sceneById = new Map(doc.sceneBlocks.map((scene) => [scene.id, scene]));
		const brollById = new Map(
			doc.brollPlacements.map((placement) => [placement.id, placement]),
		);
    doc.censorSegments.forEach((segment, index) => {
      if (segment.sourceStartSec < doc.clipStartSec || segment.sourceEndSec > doc.clipEndSec) {
        context.addIssue({ code: "custom", path: ["censorSegments", index], message: "censor segment is outside the clip source window" });
      } else if (!sourceRangeToEdited(editedTimeMap, { startSec: segment.sourceStartSec, endSec: segment.sourceEndSec })) {
        context.addIssue({ code: "custom", path: ["censorSegments", index], message: "censor segment is fully removed by deleted ranges" });
      }
    });
    const totalEditedDurationSec = sourceDurationSec + doc.sceneBlocks.reduce((sum, scene) => sum + scene.durationSec, 0);
    const maximumEditedDurationSec = Math.max(sourceDurationSec, TIMED_EDIT_LIMITS.totalEditedDurationSec);
    if (totalEditedDurationSec > maximumEditedDurationSec + 0.001) {
      context.addIssue({ code: "custom", path: ["sceneBlocks"], message: `total edited duration cannot exceed ${maximumEditedDurationSec} seconds` });
    }
    doc.mediaMotions.forEach((motion, index) => {
      if (motion.target.kind === "scene_block" && !sceneIds.has(motion.target.sceneBlockId)) {
        context.addIssue({ code: "custom", path: ["mediaMotions", index, "target"], message: "scene block target does not exist" });
      }
      if (motion.target.kind === "scene_block") {
        const scene = sceneById.get(motion.target.sceneBlockId);
        if (
          scene &&
          (motion.startSec < scene.anchorSec ||
            motion.endSec > scene.anchorSec + scene.durationSec)
        ) {
          context.addIssue({
            code: "custom",
            path: ["mediaMotions", index],
            message: "scene media motion must stay inside its Scene Block",
          });
        }
      }
			if (motion.target.kind === "broll") {
				const placement = brollById.get(motion.target.placementId);
				if (!placement) {
					context.addIssue({
						code: "custom",
						path: ["mediaMotions", index, "target"],
						message: "B-roll placement target does not exist",
					});
				} else if (
					motion.startSec < placement.startSec ||
					motion.endSec > placement.endSec
				) {
					context.addIssue({
						code: "custom",
						path: ["mediaMotions", index],
						message: "B-roll media motion must stay inside its placement",
					});
				}
			}
			if (motion.target.kind === "broll_url") {
				if (!manualBrollWindow) {
					context.addIssue({
						code: "custom",
						path: ["mediaMotions", index, "target"],
						message: "manual B-roll URL target is not active",
					});
				} else if (
					Math.abs(motion.startSec - manualBrollWindow.startSec) > 0.001 ||
					Math.abs(motion.endSec - manualBrollWindow.endSec) > 0.001
				) {
					context.addIssue({
						code: "custom",
						path: ["mediaMotions", index],
						message: "manual B-roll URL motion must use its canonical window",
					});
				}
			}
      if (motion.endSec > totalEditedDurationSec) {
        context.addIssue({ code: "custom", path: ["mediaMotions", index], message: "media motion is outside the edited timeline" });
      }
    });
    const motionIsAnimated = (motion: {
      entrance: SceneMotion["entrance"];
      exit: SceneMotion["exit"];
    }) => motion.entrance !== "none" || motion.exit !== "none";
    const enabledByTarget = new Map<string, typeof doc.mediaMotions>();
    doc.mediaMotions.forEach((motion) => {
      if (!motion.enabled) return;
			const key = motion.target.kind === "broll"
				? `broll:${motion.target.placementId}`
				: motion.target.kind === "broll_url"
					? "broll-url"
					: `scene:${motion.target.sceneBlockId}`;
      enabledByTarget.set(key, [...(enabledByTarget.get(key) ?? []), motion]);
    });
    for (const [target, motions] of enabledByTarget) {
      const ordered = [...motions].sort((left, right) =>
        left.startSec - right.startSec || left.id.localeCompare(right.id));
      ordered.forEach((motion, index) => {
        const previous = ordered[index - 1];
				if (previous && target.startsWith("broll:")) {
          context.addIssue({
            code: "custom",
            path: ["mediaMotions"],
            message: "only one enabled media motion is allowed per B-roll placement",
          });
          return;
        }
        if (
          previous &&
          (target.startsWith("scene:") || motion.startSec < previous.endSec)
        ) {
          context.addIssue({
            code: "custom",
            path: ["mediaMotions"],
            message: "enabled media motions cannot overlap on one target",
          });
        }
      });
    }
    const explicitSceneTargets = new Set(
      doc.mediaMotions.flatMap((motion) =>
        motion.enabled && motion.target.kind === "scene_block"
          ? [motion.target.sceneBlockId]
          : []),
    );
    const animatedIntervals = [
      ...doc.mediaMotions.flatMap((motion) =>
        motion.enabled && motionIsAnimated(motion)
          ? [{ startSec: motion.startSec, endSec: motion.endSec }]
          : []),
      ...doc.sceneBlocks.flatMap((scene) =>
        !explicitSceneTargets.has(scene.id) && motionIsAnimated(scene.motion)
          ? [{
              startSec: scene.anchorSec,
              endSec: scene.anchorSec + scene.durationSec,
            }]
          : []),
    ];
    if (animatedIntervals.length > TIMED_EDIT_LIMITS.animatedMedia) {
      context.addIssue({
        code: "custom",
        path: ["mediaMotions"],
        message: `animated media cannot exceed ${TIMED_EDIT_LIMITS.animatedMedia} placements`,
      });
    }
    const transitionDuration = doc.studioEdits.transition.type === "none"
      ? 0
      : Math.min(doc.studioEdits.transition.durationSec, totalEditedDurationSec / 2);
    const animationIntervals = [
      ...animatedIntervals,
      ...(transitionDuration > 0
        ? [
            { startSec: 0, endSec: transitionDuration },
            {
              startSec: totalEditedDurationSec - transitionDuration,
              endSec: totalEditedDurationSec,
            },
          ]
        : []),
    ];
    const events = animationIntervals.flatMap((range) => [
      { timeSec: range.startSec, delta: 1 },
      { timeSec: range.endSec, delta: -1 },
    ]).sort((left, right) => left.timeSec - right.timeSec || left.delta - right.delta);
    let simultaneous = 0;
    let maximumSimultaneous = 0;
    for (const event of events) {
      simultaneous += event.delta;
      maximumSimultaneous = Math.max(maximumSimultaneous, simultaneous);
    }
    if (maximumSimultaneous > TIMED_EDIT_LIMITS.simultaneousAnimatedLayers) {
      context.addIssue({
        code: "custom",
        path: ["mediaMotions"],
        message: `simultaneous animated layers cannot exceed ${TIMED_EDIT_LIMITS.simultaneousAnimatedLayers}`,
      });
    }
    if (new TextEncoder().encode(JSON.stringify(doc)).byteLength > TIMED_EDIT_LIMITS.documentBytes) {
      context.addIssue({ code: "custom", message: "editor document exceeds the maximum encoded size" });
    }
  });

function validatedTimedMutation(current: EditorDocument, candidate: EditorDocument): EditorDocument {
  const parsed = editorDocumentV2Schema.safeParse(candidate);
  return parsed.success ? parsed.data : current;
}

export const editorDocumentSchema = editorDocumentV2Schema;

export type EditorDocument = z.infer<typeof editorDocumentSchema>;

/**
 * Optimistic-concurrency save envelope: the client sends the revision it
 * loaded (`baseRevision`) with the full document; the server accepts only if
 * the stored revision still matches, then increments. Replaces the previous
 * unversioned three-PATCH autosave (studio-shell.tsx:529).
 */
export const saveEditorDocumentSchema = z.object({
  baseRevision: z.number().int().nonnegative(),
  document: editorDocumentSchema,
});

export type SaveEditorDocument = z.infer<typeof saveEditorDocumentSchema>;

/** Body for POST .../editor/reset (Reset-to-original, Phase A step 4). */
export const resetEditorDocumentSchema = z.object({
  baseRevision: z.number().int().nonnegative(),
});

export type ResetEditorDocument = z.infer<typeof resetEditorDocumentSchema>;

export const editorActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("setCaptionPreset"), captionPreset: captionPresetSchema }),
  z.object({
    type: z.literal("setTranscriptSlice"),
    transcriptSlice: z.array(transcriptUtteranceSchema),
  }),
  z.object({
    type: z.literal("updateWordText"),
    utteranceIndex: z.number().int().nonnegative(),
    wordIndex: z.number().int().nonnegative(),
    text: z.string().trim().min(1),
  }),
  z.object({ type: z.literal("setStudioEdits"), studioEdits: studioEditsSchema }),
  z.object({ type: z.literal("setBrollUrl"), brollUrl: z.string().url().nullable() }),
  z.strictObject({
    type: z.literal("insertBrollPlacement"),
    placement: brollPlacementSchema,
  }),
  z.strictObject({
    type: z.literal("replaceBrollPlacement"),
    id: z.string().uuid(),
    asset: visualAssetReferenceSchema,
    provenance: z.enum(["uploaded", "generated", "extracted"]),
    mediaKind: z.enum(["image", "video"]),
    sourceStartSec: z.number().finite().nonnegative().nullable(),
    sourceEndSec: z.number().finite().positive().nullable(),
  }),
  z.strictObject({
    type: z.literal("deleteBrollPlacement"),
    id: z.string().uuid(),
  }),
  z.object({ type: z.literal("deleteRange"), range: sourceRangeSchema }),
  z.object({ type: z.literal("revertRange"), range: sourceRangeSchema }),
  z.object({ type: z.literal("setDeletedRanges"), ranges: deletedRangesSchema }),
  z.object({ type: z.literal("setClipBoundaries"), startSec: z.number().nonnegative(), endSec: z.number().nonnegative() }),
  z.object({
    type: z.literal("trimClip"),
    startSec: z.number().nonnegative(),
    endSec: z.number().nonnegative(),
    transcriptSlice: z.array(transcriptUtteranceSchema),
  }),
  z.object({ type: z.literal("reset"), original: editorDocumentSchema }),
  z.strictObject({ type: z.literal("insertSceneBlock"), scene: sceneBlockSchema }),
  z.strictObject({ type: z.literal("moveSceneBlock"), id: z.string().uuid(), anchorSec: z.number().finite().nonnegative() }),
  z.strictObject({ type: z.literal("trimSceneBlock"), id: z.string().uuid(), durationSec: z.number().finite().min(0.1).max(120) }),
  z.strictObject({ type: z.literal("duplicateSceneBlock"), id: z.string().uuid(), duplicateId: z.string().uuid() }),
	z.strictObject({ type: z.literal("replaceSceneBlock"), id: z.string().uuid(), content: sceneContentSchema, durationSec: z.number().finite().min(0.1).max(120).optional() }),
	z.strictObject({ type: z.literal("updateSceneMotion"), id: z.string().uuid(), motion: sceneMotionSchema }),
  z.strictObject({ type: z.literal("deleteSceneBlock"), id: z.string().uuid() }),
  z.strictObject({ type: z.literal("insertCensorSegment"), segment: censorSegmentSchema }),
  z.strictObject({
    type: z.literal("applyCensorSegments"),
    segments: z
      .array(censorSegmentSchema)
      .min(1)
      .max(TIMED_EDIT_LIMITS.censorSegments),
  }),
  z.strictObject({ type: z.literal("updateCensorSegment"), id: z.string().uuid(), segment: censorSegmentSchema }),
  z.strictObject({ type: z.literal("removeCensorSegment"), id: z.string().uuid() }),
  z.strictObject({ type: z.literal("setCensorSegmentEnabled"), id: z.string().uuid(), enabled: z.boolean() }),
  z.strictObject({ type: z.literal("insertMediaMotion"), motion: mediaMotionSchema }),
  z.strictObject({ type: z.literal("updateMediaMotion"), id: z.string().uuid(), motion: mediaMotionSchema }),
  z.strictObject({ type: z.literal("removeMediaMotion"), id: z.string().uuid() }),
  z.strictObject({ type: z.literal("setMediaMotionEnabled"), id: z.string().uuid(), enabled: z.boolean() }),
]);

export type EditorAction = z.infer<typeof editorActionSchema>;

function documentWindow(doc: EditorDocument) {
  return { startSec: doc.clipStartSec, endSec: doc.clipEndSec };
}

function arraysEqual<T>(
  left: readonly T[],
  right: readonly T[],
  itemEqual: (left: T, right: T) => boolean,
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((item, index) => itemEqual(item, right[index]!));
}

export function brollPlacementsEqual(
  left: readonly BrollPlacement[],
  right: readonly BrollPlacement[],
): boolean {
  return arraysEqual(
    left,
    right,
    (a, b) =>
      a.id === b.id &&
      a.asset.id === b.asset.id &&
      a.asset.fingerprint === b.asset.fingerprint &&
      a.provenance === b.provenance &&
      a.mediaKind === b.mediaKind &&
      a.startSec === b.startSec &&
      a.endSec === b.endSec &&
      a.sourceStartSec === b.sourceStartSec &&
      a.sourceEndSec === b.sourceEndSec,
  );
}

/** Compares deleted footage by its normalized domain meaning. */
export function deletedRangesEqual(
  left: readonly SourceRange[],
  right: readonly SourceRange[],
  window: ClipWindow,
): boolean {
  if (left === right) return true;
  const normalizedLeft = normalizeDeletedRanges([...left], window);
  const normalizedRight = normalizeDeletedRanges([...right], window);
  return arraysEqual(
    normalizedLeft,
    normalizedRight,
    (a, b) => a.startSec === b.startSec && a.endSec === b.endSec,
  );
}

/**
 * The shared typed equality policy for canonical Clip Editor Documents.
 * Callers must validate and canonicalize untrusted or stored values first.
 */
export function editorDocumentsEqual(
  left: EditorDocument,
  right: EditorDocument,
): boolean {
  if (left === right) return true;
  if (
    left.clipStartSec !== right.clipStartSec ||
    left.clipEndSec !== right.clipEndSec ||
    left.brollUrl !== right.brollUrl ||
    !brollPlacementsEqual(left.brollPlacements, right.brollPlacements)
  ) {
    return false;
  }
  const window = documentWindow(left);
  return (
    captionPresetsEqual(left.captionPreset, right.captionPreset) &&
    studioEditsEqual(left.studioEdits, right.studioEdits) &&
    deletedRangesEqual(left.deletedRanges, right.deletedRanges, window) &&
    transcriptSlicesEqual(left.transcriptSlice, right.transcriptSlice)
    && sceneBlocksEqual(left.sceneBlocks, right.sceneBlocks)
    && timedEditsEqual(left.censorSegments, right.censorSegments)
    && timedEditsEqual(left.mediaMotions, right.mediaMotions)
  );
}

function removeSceneBlock(blocks: readonly SceneBlock[], id: string) {
  const removed = blocks.find((block) => block.id === id);
  if (!removed) return null;
  return {
    removed,
    blocks: sortSceneBlocks(blocks
      .filter((block) => block.id !== id)
      .map((block) => block.anchorSec > removed.anchorSec
        ? { ...block, anchorSec: block.anchorSec - removed.durationSec }
        : block)),
  };
}

function insertSceneBlock(blocks: readonly SceneBlock[], scene: SceneBlock) {
  if (blocks.some((block) => block.id === scene.id)) return null;
  if (blocks.some((block) => scene.anchorSec > block.anchorSec && scene.anchorSec < block.anchorSec + block.durationSec)) return null;
  return sortSceneBlocks([
    ...blocks.map((block) => block.anchorSec >= scene.anchorSec
      ? { ...block, anchorSec: block.anchorSec + scene.durationSec }
      : block),
    scene,
  ]);
}

function rebaseSceneMediaMotions(
  motions: readonly MediaMotion[],
  previousScenes: readonly SceneBlock[],
  nextScenes: readonly SceneBlock[],
): MediaMotion[] {
  const previousById = new Map(previousScenes.map((scene) => [scene.id, scene]));
  const nextById = new Map(nextScenes.map((scene) => [scene.id, scene]));
  return motions.flatMap((motion) => {
    if (motion.target.kind !== "scene_block") return [motion];
    const previous = previousById.get(motion.target.sceneBlockId);
    const next = nextById.get(motion.target.sceneBlockId);
    if (!previous || !next) return [];
    const startsAtSceneStart = Math.abs(motion.startSec - previous.anchorSec) < 0.001;
    const endsAtSceneEnd = Math.abs(
      motion.endSec - (previous.anchorSec + previous.durationSec),
    ) < 0.001;
    if (startsAtSceneStart && endsAtSceneEnd) {
      return [{
        ...motion,
        startSec: next.anchorSec,
        endSec: next.anchorSec + next.durationSec,
      }];
    }
    const durationSec = Math.min(
      motion.endSec - motion.startSec,
      next.durationSec,
    );
    const preferredOffset = endsAtSceneEnd
      ? next.durationSec - durationSec
      : motion.startSec - previous.anchorSec;
    const startOffset = Math.max(
      0,
      Math.min(preferredOffset, next.durationSec - durationSec),
    );
    return [{
      ...motion,
      startSec: next.anchorSec + startOffset,
      endSec: next.anchorSec + startOffset + durationSec,
    }];
  });
}

// ─── Text-layer ripple (Phase B hardening, fix 2) ──────────────────────────
//
// `studioEdits.textLayers[i].startSec`/`endSec` are captured in EDITED-
// timeline seconds at creation time (see video-preview.tsx, which compares
// them directly against the playback clock's own edited time). A delete or
// revert BEFORE a layer shifts every kept frame after it — the layer's
// underlying footage moves, but nothing previously rebased the layer's own
// timing to follow, so the preview compared stale edited seconds against a
// timeline that had already shifted under it (and the worker's own burn-in
// clamp masked the symptom at render time instead of fixing it at the
// source). Doing this in the REDUCER — not a component effect — is what
// makes it undoable: every `EditorDocument` in history already carries its
// own consistent (window, deletedRanges, textLayers) triple, so undo/redo
// simply swap back to a snapshot where the rebase was already correct for
// that state, no separate replay needed.
//
// A layer whose entire window collapses inside a brand-new cut has nowhere
// non-destructive to go: dropping it would silently delete user content as
// a side effect of an unrelated edit, so instead it CLAMPS to a minimum
// visible duration at the nearest kept instant (Vizard's own editor keeps a
// repositioned overlay on screen rather than deleting it out from under the
// user). 0.5s is long enough to read as an intentional cue, short enough
// that a clamped sliver can't meaningfully crowd out a neighboring one.
const REBASED_TEXT_LAYER_MIN_DURATION_SEC = 0.5;

/**
 * Rebases every text layer's `startSec`/`endSec` from `oldMap`'s edited
 * timeline to `newMap`'s, via the one legitimate path (edited → absolute
 * source → edited): each timestamp is resolved to the absolute source
 * second it always meant, then re-projected onto the NEW edited timeline —
 * so a layer keeps pointing at the same underlying footage regardless of
 * what shifted around it. Returns the input array unchanged (same
 * reference) when nothing actually moves, so the no-op guards in
 * `applyEditorAction`'s callers keep working.
 */
function rebaseTextLayers(
  layers: StudioTextLayer[],
  oldMap: EditedTimeMap,
  newMap: EditedTimeMap,
): StudioTextLayer[] {
  if (layers.length === 0) return layers;
  const newDurationSec = newMap.editedDurationSec;

  let changed = false;
  const rebased = layers.map((layer) => {
    const sourceStartSec = editedToSource(oldMap, layer.startSec);
    let nextStart = Math.min(newDurationSec, sourceToEdited(newMap, sourceStartSec));

    let nextEnd = layer.endSec;
    if (layer.endSec != null) {
      const sourceEndSec = editedToSource(oldMap, layer.endSec);
      nextEnd = Math.min(newDurationSec, sourceToEdited(newMap, sourceEndSec));

      // Collapsed entirely inside a new cut (or just squeezed too thin by
      // one) — clamp to the minimum floor, pulling the start back first if
      // there isn't enough room ahead of it.
      if (nextEnd - nextStart < REBASED_TEXT_LAYER_MIN_DURATION_SEC) {
        nextEnd = Math.min(newDurationSec, nextStart + REBASED_TEXT_LAYER_MIN_DURATION_SEC);
        nextStart = Math.max(0, nextEnd - REBASED_TEXT_LAYER_MIN_DURATION_SEC);
      }
    }

    if (nextStart === layer.startSec && nextEnd === layer.endSec) return layer;
    changed = true;
    return { ...layer, startSec: nextStart, endSec: nextEnd };
  });

  return changed ? rebased : layers;
}

/**
 * Rebases every SFX placement's `startSec` (vizard-parity.md "Music/SFX
 * library" — H2 fix: `studioEdits.sfx[]` is edited-timeline seconds exactly
 * like `textLayers[].startSec`, but `rebaseStudioEdits` used to only rebase
 * text layers, leaving every SFX placement pointing at the wrong instant
 * after a delete/revert/boundary change shifted the edited timeline under
 * it). Same edited -> absolute source -> edited path as `rebaseTextLayers`
 * (via the same `oldMap`/`newMap`), but a one-shot SFX placement has no
 * `[startSec, endSec]` window to clamp into like a text layer does — it's a
 * single instant — so a placement whose source instant now falls inside a
 * deleted range (or otherwise outside the clip window) is DROPPED rather
 * than pulled forward onto the nearest kept frame: relocating a sound
 * effect to play at some other point in the clip is more surprising to the
 * user than the placement simply disappearing, matching what deleting the
 * underlying footage does to any other timed overlay. Returns the input
 * array unchanged (same reference) when nothing moves and nothing drops, so
 * the no-op guards in `applyEditorAction`'s callers keep working.
 */
function rebaseSfxPlacements(
  placements: StudioSfxPlacement[],
  oldMap: EditedTimeMap,
  newMap: EditedTimeMap,
): StudioSfxPlacement[] {
  if (placements.length === 0) return placements;
  const newDurationSec = newMap.editedDurationSec;

  let changed = false;
  const rebased: StudioSfxPlacement[] = [];
  for (const placement of placements) {
    const sourceStartSec = editedToSource(oldMap, placement.startSec);

    if (isSourceTimeDeleted(newMap, sourceStartSec)) {
      changed = true;
      continue;
    }

    const nextStart = Math.min(newDurationSec, sourceToEdited(newMap, sourceStartSec));
    if (nextStart === placement.startSec) {
      rebased.push(placement);
      continue;
    }
    changed = true;
    rebased.push({ ...placement, startSec: nextStart });
  }

  return changed ? rebased : placements;
}

/** Keep manual speaker-scene edits attached to the same source footage when
 * cuts or clip boundaries move the edited timeline. Overrides whose source
 * scene is fully removed are dropped; partially retained scenes clamp to the
 * remaining kept interval and will be matched back to the regenerated AI
 * scene by overlap in resolveSpeakerLayoutScene. */
function rebaseSpeakerLayoutOverrides(
  overrides: StudioSpeakerLayoutOverride[],
  oldMap: EditedTimeMap,
  newMap: EditedTimeMap,
): StudioSpeakerLayoutOverride[] {
  if (overrides.length === 0) return overrides;
  let changed = false;
  const rebased: StudioSpeakerLayoutOverride[] = [];

  for (const override of overrides) {
    const sourceStartSec = editedToSource(oldMap, override.startSec);
    const sourceEndSec = editedToSource(oldMap, override.endSec);
    const clampedSource = {
      startSec: Math.max(newMap.clipStartSec, sourceStartSec),
      endSec: Math.min(newMap.clipEndSec, sourceEndSec),
    };
    const edited = sourceRangeToEdited(newMap, clampedSource);
    if (!edited || edited.endSec - edited.startSec < 0.075) {
      changed = true;
      continue;
    }
    if (
      edited.startSec === override.startSec &&
      edited.endSec === override.endSec
    ) {
      rebased.push(override);
      continue;
    }
    changed = true;
    rebased.push({
      ...override,
      startSec: edited.startSec,
      endSec: edited.endSec,
    });
  }
  return changed ? rebased : overrides;
}

/** Asset-backed B-roll is anchored to the base edited source timeline. Keep
 * placements attached to the same source footage when cuts or boundaries
 * move that timeline; fully removed placements disappear with their source. */
function rebaseBrollPlacements(
  placements: readonly BrollPlacement[],
  oldMap: EditedTimeMap,
  newMap: EditedTimeMap,
): BrollPlacement[] {
  if (placements.length === 0) return placements as BrollPlacement[];
  let changed = false;
  const rebased: BrollPlacement[] = [];
  for (const placement of placements) {
    const originalSourceStart = editedToSource(oldMap, placement.startSec);
    const originalSourceEnd = editedToSource(oldMap, placement.endSec);
    const clampedSource = {
      startSec: Math.max(newMap.clipStartSec, originalSourceStart),
      endSec: Math.min(newMap.clipEndSec, originalSourceEnd),
    };
    const edited = sourceRangeToEdited(newMap, clampedSource);
    if (!edited || edited.endSec - edited.startSec < 0.1) {
      changed = true;
      continue;
    }
    const durationSec = edited.endSec - edited.startSec;
    let sourceStartSec = placement.sourceStartSec;
    let sourceEndSec = placement.sourceEndSec;
    if (
      placement.mediaKind === "video" &&
      sourceStartSec !== null &&
      sourceEndSec !== null
    ) {
      const removedFromStartSec = Math.max(
        0,
        sourceToEdited(oldMap, clampedSource.startSec) - placement.startSec,
      );
      sourceStartSec = Math.min(sourceEndSec, sourceStartSec + removedFromStartSec);
      sourceEndSec = Math.min(sourceEndSec, sourceStartSec + durationSec);
      if (sourceEndSec - sourceStartSec < durationSec - 0.001) {
        changed = true;
        continue;
      }
    }
    const next: BrollPlacement = {
      ...placement,
      startSec: edited.startSec,
      endSec: edited.endSec,
      sourceStartSec,
      sourceEndSec,
    };
    if (!brollPlacementsEqual([placement], [next])) changed = true;
    rebased.push(next);
  }
  return changed ? rebased : (placements as BrollPlacement[]);
}

function rebaseBrollMediaMotions(
	motions: readonly MediaMotion[],
	previousPlacements: readonly BrollPlacement[],
	nextPlacements: readonly BrollPlacement[],
	oldMap: EditedTimeMap,
	newMap: EditedTimeMap,
	brollUrl: string | null,
): MediaMotion[] {
	if (motions.every((motion) =>
		motion.target.kind !== "broll" && motion.target.kind !== "broll_url")) {
		return motions as MediaMotion[];
	}
	const previousById = new Map(
		previousPlacements.map((placement) => [placement.id, placement]),
	);
	const nextById = new Map(
		nextPlacements.map((placement) => [placement.id, placement]),
	);
	let changed = false;
	const rebased: MediaMotion[] = [];
	for (const motion of motions) {
		if (motion.target.kind === "broll_url") {
			const window = activeManualBrollMotionWindow({
				brollUrl,
				assetBackedPlacementCount: nextPlacements.length,
				editedDurationSec: newMap.editedDurationSec,
			});
			if (!window) {
				changed = true;
				continue;
			}
			if (
				motion.startSec === window.startSec &&
				motion.endSec === window.endSec
			) {
				rebased.push(motion);
			} else {
				changed = true;
				rebased.push({ ...motion, ...window });
			}
			continue;
		}
		if (motion.target.kind !== "broll") {
			rebased.push(motion);
			continue;
		}
		const previousPlacement = previousById.get(motion.target.placementId);
		const nextPlacement = nextById.get(motion.target.placementId);
		if (!previousPlacement || !nextPlacement) {
			changed = true;
			continue;
		}
		const projected = sourceRangeToEdited(newMap, {
			startSec: Math.max(
				newMap.clipStartSec,
				editedToSource(oldMap, motion.startSec),
			),
			endSec: Math.min(
				newMap.clipEndSec,
				editedToSource(oldMap, motion.endSec),
			),
		});
		if (!projected) {
			changed = true;
			continue;
		}
		const startSec = Math.max(nextPlacement.startSec, projected.startSec);
		const endSec = Math.min(nextPlacement.endSec, projected.endSec);
		if (endSec - startSec < 0.001) {
			changed = true;
			continue;
		}
		if (startSec === motion.startSec && endSec === motion.endSec) {
			rebased.push(motion);
			continue;
		}
		changed = true;
		rebased.push({ ...motion, startSec, endSec });
	}
	return changed ? rebased : (motions as MediaMotion[]);
}

function rebaseDocumentTimelineEdits(
  doc: EditorDocument,
  oldWindow: ClipWindow,
  oldDeletedRanges: SourceRange[],
  newWindow: ClipWindow,
  newDeletedRanges: SourceRange[],
) {
  const oldMap = buildEditedTimeMap(oldDeletedRanges, oldWindow);
  const newMap = buildEditedTimeMap(newDeletedRanges, newWindow);
	const brollPlacements = rebaseBrollPlacements(
		doc.brollPlacements,
		oldMap,
		newMap,
	);
  return {
    studioEdits: rebaseStudioEdits(
      doc,
      oldWindow,
      oldDeletedRanges,
      newWindow,
      newDeletedRanges,
    ),
		brollPlacements,
		mediaMotions: rebaseBrollMediaMotions(
			doc.mediaMotions,
			doc.brollPlacements,
			brollPlacements,
			oldMap,
			newMap,
			doc.brollUrl,
		),
  };
}

/** Applies `rebaseTextLayers`/`rebaseSfxPlacements` to `doc.studioEdits` and
 *  folds the result back into a (possibly-unchanged-reference)
 *  `studioEdits`, so callers can spread it into the next document without an
 *  extra branch. */
function rebaseStudioEdits(
  doc: EditorDocument,
  oldWindow: ClipWindow,
  oldDeletedRanges: SourceRange[],
  newWindow: ClipWindow,
  newDeletedRanges: SourceRange[],
) {
  const oldMap = buildEditedTimeMap(oldDeletedRanges, oldWindow);
  const newMap = buildEditedTimeMap(newDeletedRanges, newWindow);
  const textLayers = rebaseTextLayers(doc.studioEdits.textLayers, oldMap, newMap);
  const sfx = rebaseSfxPlacements(doc.studioEdits.sfx, oldMap, newMap);
  const speakerLayoutOverrides = rebaseSpeakerLayoutOverrides(
    doc.studioEdits.speakerLayoutOverrides,
    oldMap,
    newMap,
  );
  if (
    textLayers === doc.studioEdits.textLayers &&
    sfx === doc.studioEdits.sfx &&
    speakerLayoutOverrides === doc.studioEdits.speakerLayoutOverrides
  ) {
    return doc.studioEdits;
  }
  return { ...doc.studioEdits, textLayers, sfx, speakerLayoutOverrides };
}

/** Pure reducer: every studio mutation flows through here. */
export function applyEditorAction(
  doc: EditorDocument,
  action: EditorAction,
): EditorDocument {
  switch (action.type) {
    case "setCaptionPreset":
      return captionPresetsEqual(action.captionPreset, doc.captionPreset)
        ? doc
        : { ...doc, captionPreset: action.captionPreset };
    case "setTranscriptSlice":
      return transcriptSlicesEqual(action.transcriptSlice, doc.transcriptSlice)
        ? doc
        : { ...doc, transcriptSlice: action.transcriptSlice };
    case "updateWordText": {
      const utterance = doc.transcriptSlice[action.utteranceIndex];
      const word = utterance?.words[action.wordIndex];
      if (!utterance || !word) return doc;
      // Phase B step 10: change ONLY this word's text and rebuild the
      // utterance text — never redistribute the other words' timings.
      const words = utterance.words.map((w, i) =>
        i === action.wordIndex ? { ...w, word: action.text } : w,
      );
      const updated = {
        ...utterance,
        words,
        text: words.map((w) => w.word.trim()).filter(Boolean).join(" "),
      };
      return {
        ...doc,
        transcriptSlice: doc.transcriptSlice.map((u, i) =>
          i === action.utteranceIndex ? updated : u,
        ),
      };
    }
    case "setStudioEdits":
      return studioEditsEqual(action.studioEdits, doc.studioEdits)
        ? doc
        : { ...doc, studioEdits: action.studioEdits };
    case "setBrollUrl":
      return action.brollUrl === doc.brollUrl
        ? doc
				: {
						...doc,
						brollUrl: action.brollUrl,
						mediaMotions: action.brollUrl
							? doc.mediaMotions
							: doc.mediaMotions.filter(
								(motion) => motion.target.kind !== "broll_url",
							),
					};
    case "insertBrollPlacement":
      return doc.brollPlacements.some((placement) => placement.id === action.placement.id) ||
        !brollPlacementSchema.safeParse(action.placement).success
        ? doc
        : validatedTimedMutation(doc, {
            ...doc,
            brollPlacements: [...doc.brollPlacements, action.placement].sort(
              (left, right) =>
                left.startSec - right.startSec || left.id.localeCompare(right.id),
            ),
						mediaMotions: doc.mediaMotions.filter(
							(motion) => motion.target.kind !== "broll_url",
						),
          });
    case "replaceBrollPlacement": {
      const current = doc.brollPlacements.find(
        (placement) => placement.id === action.id,
      );
      if (!current) return doc;
      const replacement: BrollPlacement = {
        ...current,
        asset: action.asset,
        provenance: action.provenance,
        mediaKind: action.mediaKind,
        sourceStartSec: action.sourceStartSec,
        sourceEndSec: action.sourceEndSec,
      };
      if (!brollPlacementSchema.safeParse(replacement).success) return doc;
      if (brollPlacementsEqual([current], [replacement])) return doc;
      return validatedTimedMutation(doc, {
        ...doc,
        brollPlacements: doc.brollPlacements.map((placement) =>
          placement.id === action.id ? replacement : placement,
        ),
      });
    }
    case "deleteBrollPlacement":
      return doc.brollPlacements.some((placement) => placement.id === action.id)
        ? validatedTimedMutation(doc, {
            ...doc,
            brollPlacements: doc.brollPlacements.filter(
              (placement) => placement.id !== action.id,
            ),
						mediaMotions: doc.mediaMotions.filter(
							(motion) =>
								motion.target.kind !== "broll" ||
								motion.target.placementId !== action.id,
						),
          })
        : doc;
    case "deleteRange": {
      const window = documentWindow(doc);
      const deletedRanges = normalizeDeletedRanges(
        [...doc.deletedRanges, action.range],
        window,
      );
      if (deletedRangesEqual(deletedRanges, doc.deletedRanges, window)) return doc;
      // Fix 2: a delete can shift every kept frame after it — rebase any
      // text layers so their edited-timeline timing keeps pointing at the
      // same underlying footage (see rebaseTextLayers's doc comment).
      const timelineEdits = rebaseDocumentTimelineEdits(
        doc,
        window,
        doc.deletedRanges,
        window,
        deletedRanges,
      );
      return { ...doc, deletedRanges, ...timelineEdits };
    }
    case "revertRange": {
      const window = documentWindow(doc);
      const deletedRanges = subtractDeletedRange(doc.deletedRanges, action.range, window);
      if (deletedRangesEqual(deletedRanges, doc.deletedRanges, window)) return doc;
      const timelineEdits = rebaseDocumentTimelineEdits(
        doc,
        window,
        doc.deletedRanges,
        window,
        deletedRanges,
      );
      return { ...doc, deletedRanges, ...timelineEdits };
    }
    case "setDeletedRanges": {
      const window = documentWindow(doc);
      const deletedRanges = normalizeDeletedRanges(action.ranges, window);
      if (deletedRangesEqual(deletedRanges, doc.deletedRanges, window)) return doc;
      const timelineEdits = rebaseDocumentTimelineEdits(
        doc,
        window,
        doc.deletedRanges,
        window,
        deletedRanges,
      );
      return { ...doc, deletedRanges, ...timelineEdits };
    }
    case "setClipBoundaries": {
      if (action.startSec === doc.clipStartSec && action.endSec === doc.clipEndSec) {
        return doc;
      }
      const oldWindow = documentWindow(doc);
      const newWindow = { startSec: action.startSec, endSec: action.endSec };
      // Rebase deletions into the new window so trim can never leave cuts
      // dangling outside the clip.
      const deletedRanges = normalizeDeletedRanges(doc.deletedRanges, newWindow);
      // Fix 2: the window itself moving (not just deletedRanges) can shift
      // every text layer's rebased edited position too — same rebase used
      // by the delete/revert branches, just against the new window as well
      // as any deletedRanges renormalization it forced.
      const timelineEdits = rebaseDocumentTimelineEdits(
        doc,
        oldWindow,
        doc.deletedRanges,
        newWindow,
        deletedRanges,
      );
      return {
        ...doc,
        clipStartSec: action.startSec,
        clipEndSec: action.endSec,
        deletedRanges,
        ...timelineEdits,
      };
    }
    case "trimClip": {
      // Vizard-parity Phase B step 13 (in-studio trim): the composite action
      // a boundary-changing trim commit dispatches — ONE history frame for
      // what is really two related mutations (the window AND the
      // transcriptSlice that has to describe it), so undo restores both
      // together instead of leaving a half-trimmed document reachable
      // mid-stack. Internally this is exactly `setClipBoundaries` plus
      // `setTranscriptSlice`'s own logic (deletedRanges renormalized into
      // the new window, text layers rebased through it) — no new rebase
      // rules, just applied atomically.
      const boundariesChanged =
        action.startSec !== doc.clipStartSec || action.endSec !== doc.clipEndSec;
      const transcriptChanged = !transcriptSlicesEqual(
        action.transcriptSlice,
        doc.transcriptSlice,
      );
      if (!boundariesChanged && !transcriptChanged) return doc;

      const oldWindow = documentWindow(doc);
      const newWindow = { startSec: action.startSec, endSec: action.endSec };
      const deletedRanges = normalizeDeletedRanges(doc.deletedRanges, newWindow);
      const timelineEdits = rebaseDocumentTimelineEdits(
        doc,
        oldWindow,
        doc.deletedRanges,
        newWindow,
        deletedRanges,
      );
      return {
        ...doc,
        clipStartSec: action.startSec,
        clipEndSec: action.endSec,
        transcriptSlice: action.transcriptSlice,
        deletedRanges,
        ...timelineEdits,
      };
    }
    case "insertSceneBlock": {
      if (!sceneBlockSchema.safeParse(action.scene).success) return doc;
      if (action.scene.templateSnapshot && doc.sceneBlocks.some((scene) =>
        scene.anchorSec === action.scene.anchorSec &&
        scene.templateSnapshot?.fingerprint === action.scene.templateSnapshot?.fingerprint)) {
        return doc;
      }
      const sceneBlocks = insertSceneBlock(doc.sceneBlocks, action.scene);
      return sceneBlocks
        ? validatedTimedMutation(doc, {
            ...doc,
            sceneBlocks,
            mediaMotions: rebaseSceneMediaMotions(
              doc.mediaMotions,
              doc.sceneBlocks,
              sceneBlocks,
            ),
          })
        : doc;
    }
    case "moveSceneBlock": {
      const removed = removeSceneBlock(doc.sceneBlocks, action.id);
      if (!removed) return doc;
      const moved = { ...removed.removed, anchorSec: action.anchorSec };
      if (!sceneBlockSchema.safeParse(moved).success) return doc;
      const sceneBlocks = insertSceneBlock(removed.blocks, moved);
      return sceneBlocks
        ? validatedTimedMutation(doc, {
            ...doc,
            sceneBlocks,
            mediaMotions: rebaseSceneMediaMotions(
              doc.mediaMotions,
              doc.sceneBlocks,
              sceneBlocks,
            ),
          })
        : doc;
    }
    case "trimSceneBlock": {
      const scene = doc.sceneBlocks.find((block) => block.id === action.id);
      if (!scene || scene.durationSec === action.durationSec || sceneDurationIssue(scene.content, action.durationSec)) return doc;
      const delta = action.durationSec - scene.durationSec;
      const sceneBlocks = sortSceneBlocks(doc.sceneBlocks.map((block) => {
        if (block.id === action.id) return { ...block, durationSec: action.durationSec };
        return block.anchorSec > scene.anchorSec
          ? { ...block, anchorSec: block.anchorSec + delta }
          : block;
      }));
      return validatedTimedMutation(doc, {
        ...doc,
        sceneBlocks,
        mediaMotions: rebaseSceneMediaMotions(
          doc.mediaMotions,
          doc.sceneBlocks,
          sceneBlocks,
        ),
      });
    }
    case "duplicateSceneBlock": {
      const scene = doc.sceneBlocks.find((block) => block.id === action.id);
      if (!scene) return doc;
      const copy = { ...structuredClone(scene), id: action.duplicateId, anchorSec: scene.anchorSec + scene.durationSec };
      const sceneBlocks = insertSceneBlock(doc.sceneBlocks, copy);
      return sceneBlocks
        ? validatedTimedMutation(doc, {
            ...doc,
            sceneBlocks,
            mediaMotions: rebaseSceneMediaMotions(
              doc.mediaMotions,
              doc.sceneBlocks,
              sceneBlocks,
            ),
          })
        : doc;
    }
    case "replaceSceneBlock": {
      const scene = doc.sceneBlocks.find((block) => block.id === action.id);
			if (!scene) return doc;
			const maximumDuration = action.content.kind === "video"
				? action.content.sourceEndSec - action.content.sourceStartSec
				: 30;
			const minimumDuration = action.content.kind === "video" ? 0.1 : 1;
			const durationSec = Math.min(maximumDuration, Math.max(minimumDuration, action.durationSec ?? scene.durationSec));
			if (JSON.stringify(scene.content) === JSON.stringify(action.content) && scene.durationSec === durationSec) return doc;
			const delta = durationSec - scene.durationSec;
			const sceneBlocks = sortSceneBlocks(doc.sceneBlocks.map((block) => {
				if (block.id === action.id) return { ...block, content: action.content, durationSec, templateSnapshot: null };
				return block.anchorSec > scene.anchorSec ? { ...block, anchorSec: block.anchorSec + delta } : block;
			}));
			return validatedTimedMutation(doc, {
				...doc,
				sceneBlocks,
				mediaMotions: rebaseSceneMediaMotions(doc.mediaMotions, doc.sceneBlocks, sceneBlocks),
			});
		}
		case "updateSceneMotion": {
			const scene = doc.sceneBlocks.find((block) => block.id === action.id);
			if (!scene || JSON.stringify(scene.motion) === JSON.stringify(action.motion)) return doc;
			return validatedTimedMutation(doc, {
				...doc,
				sceneBlocks: doc.sceneBlocks.map((block) => block.id === action.id
					? { ...block, motion: action.motion, templateSnapshot: null }
					: block),
			});
    }
    case "deleteSceneBlock": {
      const removed = removeSceneBlock(doc.sceneBlocks, action.id);
      if (!removed) return doc;
      const mediaMotions = doc.mediaMotions.filter((motion) =>
        motion.target.kind !== "scene_block" || motion.target.sceneBlockId !== action.id);
      return validatedTimedMutation(doc, {
        ...doc,
        sceneBlocks: removed.blocks,
        mediaMotions: rebaseSceneMediaMotions(
          mediaMotions,
          doc.sceneBlocks,
          removed.blocks,
        ),
      });
    }
    case "insertCensorSegment":
      return doc.censorSegments.some((segment) => segment.id === action.segment.id)
        ? doc
        : validatedTimedMutation(doc, { ...doc, censorSegments: [...doc.censorSegments, action.segment] });
    case "applyCensorSegments": {
      const existingIds = new Set(doc.censorSegments.map((segment) => segment.id));
      const existingFingerprints = new Set(
        doc.censorSegments.flatMap((segment) =>
          segment.suggestionFingerprint ? [segment.suggestionFingerprint] : []),
      );
      const additions = action.segments.filter(
        (segment, index) =>
          !existingIds.has(segment.id) &&
          (!segment.suggestionFingerprint ||
            !existingFingerprints.has(segment.suggestionFingerprint)) &&
          action.segments.findIndex((candidate) => candidate.id === segment.id) === index &&
          (!segment.suggestionFingerprint ||
            action.segments.findIndex(
              (candidate) =>
                candidate.suggestionFingerprint === segment.suggestionFingerprint,
            ) === index),
      );
      return additions.length === 0
        ? doc
        : validatedTimedMutation(doc, {
            ...doc,
            censorSegments: [...doc.censorSegments, ...additions],
          });
    }
    case "updateCensorSegment": {
      const current = doc.censorSegments.find((segment) => segment.id === action.id);
      if (!current) return doc;
      const next: CensorSegment = { ...action.segment, id: action.id };
      return JSON.stringify(current) === JSON.stringify(next)
        ? doc
        : validatedTimedMutation(doc, { ...doc, censorSegments: doc.censorSegments.map((segment) => segment.id === action.id ? next : segment) });
    }
    case "removeCensorSegment":
      return doc.censorSegments.some((segment) => segment.id === action.id)
        ? validatedTimedMutation(doc, { ...doc, censorSegments: doc.censorSegments.filter((segment) => segment.id !== action.id) })
        : doc;
    case "setCensorSegmentEnabled":
      return doc.censorSegments.some((segment) => segment.id === action.id && segment.enabled !== action.enabled)
        ? validatedTimedMutation(doc, { ...doc, censorSegments: doc.censorSegments.map((segment) => segment.id === action.id ? { ...segment, enabled: action.enabled } : segment) })
        : doc;
    case "insertMediaMotion": {
      const targetSceneId = action.motion.target.kind === "scene_block"
        ? action.motion.target.sceneBlockId
        : null;
      return doc.mediaMotions.some((motion) => motion.id === action.motion.id) ||
        (targetSceneId !== null && !doc.sceneBlocks.some((scene) => scene.id === targetSceneId))
        ? doc
        : validatedTimedMutation(doc, { ...doc, mediaMotions: [...doc.mediaMotions, action.motion] });
    }
    case "updateMediaMotion": {
      const current = doc.mediaMotions.find((motion) => motion.id === action.id);
      const targetSceneId = action.motion.target.kind === "scene_block"
        ? action.motion.target.sceneBlockId
        : null;
      if (!current || (targetSceneId !== null && !doc.sceneBlocks.some((scene) => scene.id === targetSceneId))) return doc;
      const next: MediaMotion = { ...action.motion, id: action.id };
      return JSON.stringify(current) === JSON.stringify(next)
        ? doc
        : validatedTimedMutation(doc, { ...doc, mediaMotions: doc.mediaMotions.map((motion) => motion.id === action.id ? next : motion) });
    }
    case "removeMediaMotion":
      return doc.mediaMotions.some((motion) => motion.id === action.id)
        ? validatedTimedMutation(doc, { ...doc, mediaMotions: doc.mediaMotions.filter((motion) => motion.id !== action.id) })
        : doc;
    case "setMediaMotionEnabled":
      return doc.mediaMotions.some((motion) => motion.id === action.id && motion.enabled !== action.enabled)
        ? validatedTimedMutation(doc, { ...doc, mediaMotions: doc.mediaMotions.map((motion) => motion.id === action.id ? { ...motion, enabled: action.enabled } : motion) })
        : doc;
    case "reset":
      return action.original;
  }
}

export interface EditorHistory {
  past: EditorDocument[];
  present: EditorDocument;
  future: EditorDocument[];
  /** Coalescing key of the entry on top of `past` (slider drags, canvas drags). */
  lastCoalesceKey: string | null;
}

export const EDITOR_HISTORY_LIMIT = 100;

export function createEditorHistory(doc: EditorDocument): EditorHistory {
  return { past: [], present: doc, future: [], lastCoalesceKey: null };
}

/**
 * Apply an action, recording history. Passing the same `coalesceKey` as the
 * previous apply collapses the two into one undo step (continuous gestures);
 * any other key — or none — starts a new step.
 */
export function applyWithHistory(
  history: EditorHistory,
  action: EditorAction,
  options?: { coalesceKey?: string },
): EditorHistory {
  const next = applyEditorAction(history.present, action);
  if (next === history.present) return history;

  const coalesceKey = options?.coalesceKey ?? null;
  const coalesce =
    coalesceKey !== null && coalesceKey === history.lastCoalesceKey;

  const past = coalesce
    ? history.past
    : [...history.past, history.present].slice(-EDITOR_HISTORY_LIMIT);

  return { past, present: next, future: [], lastCoalesceKey: coalesceKey };
}

export function canUndo(history: EditorHistory): boolean {
  return history.past.length > 0;
}

export function canRedo(history: EditorHistory): boolean {
  return history.future.length > 0;
}

export function undoEditor(history: EditorHistory): EditorHistory {
  const previous = history.past[history.past.length - 1];
  if (!previous) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
    lastCoalesceKey: null,
  };
}

export function redoEditor(history: EditorHistory): EditorHistory {
  const next = history.future[0];
  if (!next) return history;
  return {
    past: [...history.past, history.present].slice(-EDITOR_HISTORY_LIMIT),
    present: next,
    future: history.future.slice(1),
    lastCoalesceKey: null,
  };
}
