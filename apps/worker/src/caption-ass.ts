import { brandFontKey, type RenderBrandFonts, type RenderBrandFont } from "./brand-font-resolution";
import {
	CAPTION_EMOJI_FONT_EM,
	CAPTION_EMOJI_HEIGHT_EM,
	CAPTION_EMOJI_WIDTH_EM,
	CaptionShapingError,
	captionGraphemes,
	fontFileCovers,
	layoutCaptionLine,
	resolveCaptionEmoji,
	type CaptionLineLayout,
	type CaptionLineWord,
} from "@narriflow/caption-fonts";
import {
	brandCaptionFace,
	type CaptionFace,
	type CaptionGlyphNotice,
	CaptionGlyphPlanner,
	catalogCaptionFace,
	monochromeEmojiFace,
	type OmittedGlyph,
	type PlannedCluster,
	type SkippedEmoji,
} from "./caption-glyphs";
import { captionWordSegmentEnd, type CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import {
	CAPTION_CUE_TILTS_DEG,
	CAPTION_EASE_ACCEL,
	CAPTION_EXTRUDE,
	CAPTION_FIT_WIDTH_FRACTION,
	CAPTION_GLITCH,
	CAPTION_GLOW_SIGMAS,
	CAPTION_HARD_SHADOW,
	CAPTION_MOTIONS,
	CAPTION_PILL,
	CAPTION_PLATE,
	CAPTION_SOFT_SHADOW,
	type CaptionFontFace,
	type CaptionKeyframe,
	type CaptionMotionSpec,
	type CaptionPreset,
	captionFontFace,
	captionKeyframeValue,
	captionTypewriterLetterDelays,
	hasSpaceBefore,
	languageDirection,
	textDirection,
} from "@narriflow/validators";

/**
 * Caption burn-in: serializes caption cues to an ASS script that libass
 * renders with the vendored caption fonts (`fontsdir`). Every motion and
 * decoration comes from packages/validators/src/caption-style.ts, the same
 * spec the studio preview renders, so preview and export match.
 *
 * Each cue becomes a stack of events, lowest layer first:
 *  - plate: rounded `\p1` drawing behind the whole cue
 *  - pill: rounded drawing behind the active word
 *  - base line: the whole cue laid out by libass, drawn as shadow, outer
 *    stroke, glow and text layers with per-word colour and visibility
 *  - overlay: the active word alone, at its measured centre, carrying the
 *    word motion (scale, rise, blur, flip, glitch) through the same layers
 * Word boxes come from shaping the font files with HarfBuzz, the shaper libass
 * uses, and placing the runs in bidi visual order (`layoutCaptionLine`), so an
 * RTL or mixed line puts its pill, plate and overlay on the right word. When a
 * cue contains a character the face lacks, caption-glyphs.ts picks the pinned
 * fallback face (by the cue's language first) and the text switches fonts with
 * `\fn` runs; those runs are measured like any other.
 *
 * Typed degradation (`CaptionTrack.geometryUnavailable`): when HarfBuzz cannot
 * shape one of the cue's faces (an uploaded WOFF2 brand font) the cue keeps its
 * timed base line (colours, reveal, karaoke, typewriter) without pills, plate,
 * active-word overlay or fit-to-width. The Studio applies the same rule.
 *
 * Cursive and complex scripts take no letter spacing and no mid-word override
 * tag, whichever face draws them: a fallback face marked `letterSpacing:
 * "disabled"`, or any face (an uploaded brand font included) drawing text of such
 * a script (`captionShapingSensitivity`, shared with the Studio): libass splits the shaping run at
 * every tag, which unjoins Arabic and breaks Indic conjuncts and Thai marks, so
 * their typewriter reveals word by word. Karaoke is one tag at the word's start
 * and sweeps right to left on RTL words (verified on libass 0.17.4).
 *
 * ASS cannot draw colour emoji, so the active word's emoji is not in the
 * script: it comes back as an overlay schedule the FFmpeg graph composites from
 * the shared atlas (see CaptionEmojiOverlay).
 */

// The pill sits above the shadows so they never darken it, and below the
// text that wears it: under the base line when the active word stays in the
// base line, under the overlay when the word has its own overlay.
const LAYER = {
	plate: 0,
	shadow: 1,
	pill: 2,
	outer: 3,
	glow: 4,
	text: 5,
	overlayShadow: 6,
	overlayPill: 7,
	ghost: 8,
	overlayOuter: 9,
	overlayGlow: 10,
	overlayText: 11,
	emoji: 12,
	/** The clipped highlight of a right-to-left karaoke word, above the base line. */
	sweep: 13,
} as const;

/** Room left below fallback-face ink that hangs under the baseline. */
const CAPTION_INK_MARGIN_EM = 0.06;

/** libass `\blur` strength per unit of Gaussian standard deviation. */
const ASS_BLUR_PER_SIGMA = 1 / 0.849;

interface AssEvent {
	readonly layer: number;
	readonly startSec: number;
	readonly endSec: number;
	readonly style: "Caption" | "Shape";
	readonly text: string;
}

interface Span {
	readonly text: string;
	/** 0 hidden, 1 fully visible. */
	readonly visibility: number;
	readonly fill: string;
	readonly glow: string | null;
	/** `\kf` fill sweep from `primary` to `fill` across this many ms. */
	readonly sweepMs?: number;
	/** Typewriter: ms at which each character appears. */
	readonly letterDelaysMs?: readonly number[];
}

type StackLayer = "shadow" | "outer" | "glow" | "text";

interface CueGeometry {
	/** Canvas px per em for this cue (font size after fit-to-width). */
	readonly px: number;
	readonly anchorX: number;
	readonly anchorY: number;
	readonly baselineY: number;
	/** Top of the line box: the highest ascent among the faces on the line. */
	readonly lineTopY: number;
	/** Visual word boxes in canvas px; `anchorY` is where an event holding only that word sits so its baseline matches the line's. Null when unmeasurable. */
	readonly words: readonly { readonly centerX: number; readonly width: number; readonly anchorY: number; readonly inkTopEm: number; readonly inkBottomEm: number; readonly eventX: number }[] | null;
	readonly lineWidth: number | null;
	/** Middle of the line's advance box on the canvas: `anchorX` unless libass's `\pos` bbox is skewed by offset marks (see `layoutCaptionLine`). */
	readonly lineCenterX: number;
	/** Ink of fallback faces (Nastaliq, Indic and Thai marks) above the baseline and below it over the whole line, in em; a pill uses its word's own. */
	readonly inkTopEm: number;
	readonly inkBottomEm: number;
	readonly tiltDeg: number;
}

/** A cue HarfBuzz could not measure: its base line burns without pills, plate, overlays or fit-to-width. */
export interface CaptionGeometryUnavailable {
	readonly code: "caption_geometry_unavailable";
	readonly cueIndex: number;
	/** Font file HarfBuzz could not shape. */
	readonly fontPath: string;
}

/** One emoji picture the export composites above the active word. Coordinates are canvas px after the cue's tilt. */
export interface CaptionEmojiOverlay {
	readonly key: string;
	readonly column: number;
	readonly row: number;
	readonly startSec: number;
	readonly endSec: number;
	readonly centerX: number;
	readonly centerY: number;
	readonly widthPx: number;
	readonly heightPx: number;
	/** Clockwise, like the cue tilt. */
	readonly rotationDeg: number;
}

export interface CaptionTrack {
	readonly ass: string;
	readonly emoji: readonly CaptionEmojiOverlay[];
	readonly notices: readonly CaptionGlyphNotice[];
	/** Code points no pinned face draws, left out of the text (`captionGlyphsOmitted`). */
	readonly omitted: readonly OmittedGlyph[];
	/** Plan emoji with no atlas cell and no monochrome glyph, whose overlay is skipped (`captionEmojiSkipped`). */
	readonly emojiSkipped: readonly SkippedEmoji[];
	/** Cues whose geometry could not be measured; the typed degradation Studio mirrors. */
	readonly geometryUnavailable: readonly CaptionGeometryUnavailable[];
}

interface TrackCollector {
	readonly emoji: CaptionEmojiOverlay[];
	readonly notices: Map<string, CaptionGlyphNotice>;
	readonly omitted: Map<string, OmittedGlyph>;
	readonly emojiSkipped: SkippedEmoji[];
	readonly geometryUnavailable: CaptionGeometryUnavailable[];
	readonly forcedOmissions: ReadonlySet<number>;
}

/**
 * Serializes the caption cues. A character no pinned face draws is left out of
 * the text and an emoji nothing draws is skipped, so the clip still renders;
 * both come back on the track for the caller to record.
 * `omitCodePoints` forces further code points out (libass reported them).
 */
export function renderCaptionTrack(input: {
	layers: readonly CompositionCaptionVisualLayer[];
	canvas: { width: number; height: number };
 fonts?: RenderBrandFonts;
	omitCodePoints?: ReadonlySet<number>;
}): CaptionTrack {
	const first = input.layers[0];
	if (!first) return { ass: "", emoji: [], notices: [], omitted: [], emojiSkipped: [], geometryUnavailable: [] };
	const face = (first.preset.fontAsset ? input.fonts?.get(brandFontKey(first.preset.fontAsset))?.face : null) ?? captionFontFace(first.preset.fontName);
	const collector: TrackCollector = { emoji: [], notices: new Map(), omitted: new Map(), emojiSkipped: [], geometryUnavailable: [], forcedOmissions: input.omitCodePoints ?? new Set() };
	const events = input.layers.flatMap((cue) => cueEvents(cue, input.canvas, cue.preset.fontAsset ? input.fonts?.get(brandFontKey(cue.preset.fontAsset)) : undefined, collector));
	const ass = [
		"[Script Info]",
		"ScriptType: v4.00+",
		`PlayResX: ${input.canvas.width}`,
		`PlayResY: ${input.canvas.height}`,
		"WrapStyle: 2",
		"ScaledBorderAndShadow: yes",
		"",
		"[V4+ Styles]",
		"Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
		`Style: Caption,${face.assName},${assFontSize(face, first.preset.fontSize)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,-1`,
		"Style: Shape,Arial,20,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1",
		"",
		"[Events]",
		"Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
		...events.map(
			(event) =>
				`Dialogue: ${event.layer},${assTime(event.startSec)},${assTime(event.endSec)},${event.style},,0,0,0,,${event.text}`,
		),
		"",
	].join("\n");
	return { ass, emoji: collector.emoji, notices: [...collector.notices.values()], omitted: [...collector.omitted.values()], emojiSkipped: collector.emojiSkipped, geometryUnavailable: collector.geometryUnavailable };
}

function cueEvents(
	cue: CompositionCaptionVisualLayer,
	canvas: { width: number; height: number },
 customFont: RenderBrandFont | undefined,
	collector: TrackCollector,
): AssEvent[] {
	const preset = cue.preset;
	const motion: CaptionMotionSpec = CAPTION_MOTIONS[preset.animation];
	const face = customFont?.face ?? captionFontFace(preset.fontName);
	const glyphs = new CaptionGlyphPlanner(
		customFont ? brandCaptionFace(face, customFont.path) : catalogCaptionFace(face, "requested"),
		customFont ? catalogCaptionFace(captionFontFace(preset.fontName), "saved") : null,
		collector,
		cue.cueIndex,
		collector.forcedOmissions,
		cue.language,
	);
	const plans = planWords(cue, glyphs);
	const geometry = cueGeometry(cue, canvas, glyphs, plans, collector);
	const measured = geometry.words !== null;
	const usesOverlay =
		measured && (motion.word.length > 0 || motion.effect === "glitch");
	const events: AssEvent[] = [];
	const cueStart = cue.activeRange.startSec;
	const cueEnd = cue.activeRange.endSec;
	const tilt = tiltTags(geometry);

	if (preset.backgroundColor && geometry.lineWidth !== null) {
		const plate = plateRect(face, geometry);
		events.push({
			layer: LAYER.plate,
			startSec: cueStart,
			endSec: cueEnd,
			style: "Shape",
			text:
				`{\\an5\\pos(${num(plate.centerX)},${num(plate.centerY)})${tilt}\\bord0\\shad0` +
				`\\1c${assColor(preset.backgroundColor)}\\1a${assAlpha(preset.backgroundOpacity ?? 1)}` +
				`${motion.cueFadeMs > 0 ? `\\fad(${motion.cueFadeMs},0)` : ""}\\p1}` +
				roundedRectPath(plate.width, plate.height, CAPTION_PLATE.radiusEm * geometry.px) +
				"{\\p0}",
		});
	}

	cue.words.forEach((activeWord, activeIndex) => {
		const segStart = activeWord.startSec;
		const segEnd = captionWordSegmentEnd(cue.words, activeIndex);
		if (segEnd <= segStart) return;
		const segMs = Math.round((segEnd - segStart) * 1000);
		const fade =
			activeIndex === 0 && motion.cueFadeMs > 0
				? `\\fad(${motion.cueFadeMs},0)`
				: "";

		// libass fills a karaoke syllable from its left edge whatever the text direction: an RTL
		// word would sweep the wrong way. Its fill comes from a clip that grows from the right edge instead.
		const rtlSweep = motion.effect === "karaoke" && textDirection(activeWord.text) === "rtl";
		const activeBox = geometry.words?.[activeIndex];
		const clipSweep = rtlSweep && activeBox !== undefined && geometry.tiltDeg === 0;
		const spans: Span[] = cue.words.map((word, index) => {
			const isActive = index === activeIndex;
			const upcoming = index > activeIndex;
			const sung = motion.effect === "karaoke" && index < activeIndex;
			const visibility =
				isActive && usesOverlay
					? 0
					: upcoming
						? motion.upcomingOpacity
						: 1;
			return {
				text: word.text,
				visibility,
				fill:
					(isActive && !clipSweep) || sung ? preset.highlightColor : preset.primaryColor,
				glow: isActive
					? (preset.highlightGlowColor ?? preset.glowColor ?? null)
					: (preset.glowColor ?? null),
				...(isActive && motion.effect === "karaoke" && !rtlSweep ? { sweepMs: segMs } : {}),
				...(isActive && motion.effect === "typewriter" && !plans[index]!.shapingSensitive
					? {
							letterDelaysMs: captionTypewriterLetterDelays(
								captionGraphemes(word.text).length,
								segMs,
							),
						}
					: {}),
			};
		});

		if (spans.some((span) => span.visibility > 0)) {
			events.push(
				...stackEvents({
					preset, face, glyphs,
					px: geometry.px,
					spans,
					separators: plans.map((plan) => gapText(plan, preset, geometry.px)),
					startSec: segStart,
					endSec: segEnd,
					position: { x: geometry.anchorX, y: geometry.anchorY },
					common: `${tilt}${fade}`,
					layers: {
						shadow: LAYER.shadow,
						outer: LAYER.outer,
						glow: LAYER.glow,
						text: LAYER.text,
					},
				}),
			);
		}

		if (clipSweep && activeBox) {
			const margin = (preset.outlineWidth + (preset.outerOutlineWidth ?? 0)) * (geometry.px / preset.fontSize) + 2;
			const left = activeBox.centerX - activeBox.width / 2 - margin;
			const right = activeBox.centerX + activeBox.width / 2 + margin;
			events.push(
				...stackEvents({
					preset, face, glyphs,
					px: geometry.px,
					spans: spans.map((span, index) => (index === activeIndex ? { ...span, fill: preset.highlightColor, visibility: 1 } : { ...span, visibility: 0 })),
					separators: plans.map((plan) => gapText(plan, preset, geometry.px)),
					startSec: segStart,
					endSec: segEnd,
					position: { x: geometry.anchorX, y: geometry.anchorY },
					common: `${fade}\\clip(${num(right)},0,${num(right)},${canvas.height})\\t(0,${segMs},\\clip(${num(left)},0,${num(right)},${canvas.height}))`,
					textOnly: true,
					layers: { shadow: LAYER.sweep, outer: LAYER.sweep, glow: LAYER.sweep, text: LAYER.sweep },
				}),
			);
		}

		const box = activeBox;
		if (preset.highlightBoxColor && box) {
			events.push(
				pillEvent({
					preset,
					face,
					geometry,
					box,
					motion,
					layer: usesOverlay ? LAYER.overlayPill : LAYER.pill,
					startSec: segStart,
					endSec: segEnd,
					common: `${tilt}${fade}`,
				}),
			);
		}

		if (activeWord.emoji) {
			const placed = placeEmoji({
				emoji: activeWord.emoji,
				geometry,
				centerX: box?.centerX ?? geometry.anchorX,
				startSec: segStart,
				endSec: segEnd,
				cueIndex: cue.cueIndex,
				collector,
			});
			if (placed) {
				events.push({
					layer: LAYER.emoji,
					startSec: segStart,
					endSec: segEnd,
					style: "Caption",
					text:
						`{\\an5\\pos(${num(placed.x)},${num(placed.y)})${tilt}${fade}\\fn${placed.face.assName}\\fs${num(geometry.px * CAPTION_EMOJI_FONT_EM * placed.face.lineHeightEm)}` +
						`\\fsp0\\bord0\\shad0\\1c${assColor(preset.primaryColor)}}${escapeAssText(activeWord.emoji.replace(/[\ufe0e\ufe0f]/g, ""))}`,
				});
			}
		}

		if (usesOverlay && box) {
			const activeSpan: Span = {
				text: activeWord.text,
				visibility: 1,
				fill: preset.highlightColor,
				glow: preset.highlightGlowColor ?? preset.glowColor ?? null,
			};
			if (motion.effect === "glitch") {
				events.push(
					...glitchEvents({
						preset, face, glyphs,
						geometry,
						box,
						span: activeSpan,
						startSec: segStart,
						endSec: segEnd,
						tilt,
					}),
				);
			} else {
				events.push(
					...stackEvents({
						preset, face, glyphs,
						px: geometry.px,
						spans: [activeSpan],
						startSec: segStart,
						endSec: segEnd,
						position: { x: box.eventX, y: box.anchorY },
						common: `${tilt}${fade}`,
						keyframes: motion.word,
						layers: {
							shadow: LAYER.overlayShadow,
							outer: LAYER.overlayOuter,
							glow: LAYER.overlayGlow,
							text: LAYER.overlayText,
						},
					}),
				);
			}
		}
	});

	return motion.flicker
		? applyFlicker(events, cueStart, motion.flicker)
		: events;
}

/** One cue word after glyph planning: the faces drawing it and the gap before it. */
interface WordPlan {
	readonly clusters: readonly PlannedCluster[];
	readonly parts: readonly { readonly text: string; readonly face: CaptionFace; readonly spaced: boolean }[];
	/** A space precedes the word (`hasSpaceBefore`): no-space scripts abut. */
	readonly space: boolean;
	/** The letter spacing applies to that space (neither neighbour is cursive or complex-script text). */
	readonly gapSpaced: boolean;
	/** Part of the word is cursive or complex-script text: libass cannot take a mid-word tag there. */
	readonly shapingSensitive: boolean;
}

function planWords(cue: CompositionCaptionVisualLayer, glyphs: CaptionGlyphPlanner): WordPlan[] {
	const plans: WordPlan[] = [];
	cue.words.forEach((word, index) => {
		const clusters = glyphs.plan(word.text);
		const parts: { text: string; face: CaptionFace; spaced: boolean }[] = [];
		for (const part of clusters.flatMap((cluster) => cluster.parts)) {
			const text = escapeAssText(part.text);
			const last = parts[parts.length - 1];
			if (last && last.face === part.face && last.spaced === part.spaced) last.text += text;
			else if (text) parts.push({ text, face: part.face, spaced: part.spaced });
		}
		const previous = plans[index - 1];
		const space = index > 0 && hasSpaceBefore(cue.words[index - 1]!.text, { word: word.text, spaceBefore: word.spaceBefore });
		const edges = [previous?.parts[previous.parts.length - 1], parts[0]].filter((edge) => edge !== undefined);
		plans.push({
			clusters,
			parts,
			space,
			gapSpaced: glyphs.requested.letterSpacing !== "disabled" && edges.every((edge) => edge.spaced),
			shapingSensitive: parts.some((part) => !part.spaced),
		});
	});
	return plans;
}

/** Text before a word: the space libass draws in the requested face (widened by a pill's padding), or nothing. */
function gapText(plan: WordPlan, preset: CaptionPreset, px: number): string {
	if (!plan.space) return "";
	const base = preset.letterSpacing * px;
	const spacing = (plan.gapSpaced ? base : 0) + (preset.highlightBoxColor ? CAPTION_PILL.extraWordSpacingEm * px : 0);
	return spacing === base ? " " : `{\\fsp${num(spacing)}} {\\fsp${num(base)}}`;
}

function cueGeometry(
	cue: CompositionCaptionVisualLayer,
	canvas: { width: number; height: number },
	glyphs: CaptionGlyphPlanner,
	plans: readonly WordPlan[],
	collector: TrackCollector,
): CueGeometry {
	const preset = cue.preset;
	const motion = CAPTION_MOTIONS[preset.animation];
	const requested = glyphs.requested;
	const anchorX = (cue.anchor.xPct / 100) * canvas.width;
	const anchorY = (cue.anchor.yPct / 100) * canvas.height;
	const tiltDeg = motion.tilt
		? CAPTION_CUE_TILTS_DEG[cue.cueIndex % CAPTION_CUE_TILTS_DEG.length]!
		: 0;
	const lineWords: CaptionLineWord[] = plans.map((plan) => ({
		parts: plan.parts.map((part) => ({ text: part.text, fontPath: part.face.path, spaced: part.spaced, inked: part.face !== requested })),
		gap: plan.space ? { text: " ", fontPath: requested.path, spaced: plan.gapSpaced, inked: false } : null,
		gapExtraEm: plan.space && preset.highlightBoxColor ? CAPTION_PILL.extraWordSpacingEm : 0,
	}));
	// libass lays a line out with the tallest ascent and deepest descent among the faces it draws; a space uses the requested face.
	const metricsOf = (faces: readonly CaptionFace[]) => {
		const used = faces.length > 0 ? faces : [requested];
		return { ascentEm: Math.max(...used.map((used) => used.ascentEm)), descentEm: Math.max(...used.map((used) => used.descentEm)) };
	};
	const lineFaces = [...new Set([...plans.flatMap((plan) => plan.parts.map((part) => part.face)), ...(plans.some((plan) => plan.space) ? [requested] : [])])];
	const line = metricsOf(lineFaces);
	const strokePx = preset.outlineWidth + (preset.outerOutlineWidth ?? 0);
	const direction = textDirection(lineWords.map((word) => word.parts.map((part) => part.text).join("")).join(" "), languageDirection(cue.language));

	let layout: CaptionLineLayout | null = null;
	try {
		layout = layoutCaptionLine(lineWords, preset.letterSpacing, direction);
	} catch (error) {
		if (!(error instanceof CaptionShapingError)) throw error;
		collector.geometryUnavailable.push({ code: "caption_geometry_unavailable", cueIndex: cue.cueIndex, fontPath: error.fontPath });
	}
	// Unmeasurable: assume the average advance so the line still fits the frame.
	const naturalEm = layout?.widthEm ?? 0.6 * [...cue.words.map((word) => word.text).join(" ")].length;
	const fit = Math.min(1, (CAPTION_FIT_WIDTH_FRACTION * canvas.width) / (naturalEm * preset.fontSize + 2 * strokePx));
	const px = preset.fontSize * fit;
	const baselineY = anchorY + ((line.ascentEm - line.descentEm) / 2) * px;
	const lineTopY = anchorY - ((line.ascentEm + line.descentEm) / 2) * px;
	const base = { px, anchorX, anchorY, baselineY, lineTopY, tiltDeg };
	if (!layout) return { ...base, words: null, lineWidth: null, lineCenterX: anchorX, inkTopEm: 0, inkBottomEm: 0 };
	// libass puts the middle of its `\pos` bbox, not of the advance box, on the anchor.
	const left = anchorX - layout.bboxCenterEm * px;
	const words = layout.words.map((box, index) => {
		const word = metricsOf(plans[index]!.parts.map((part) => part.face));
		const centerX = left + (box.leftEm + box.widthEm / 2) * px;
		// An event holding only this word is anchored by that word's own bbox.
		const alone = layoutCaptionLine([{ ...lineWords[index]!, gap: null, gapExtraEm: 0 }], preset.letterSpacing, textDirection(cue.words[index]!.text, "ltr"));
		return {
			centerX,
			eventX: centerX + (alone.bboxCenterEm - alone.widthEm / 2) * px,
			width: box.widthEm * px,
			inkTopEm: box.inkTopEm,
			inkBottomEm: box.inkBottomEm,
			// An event holding only this word is centred on its own line box; shift it so its baseline is the line's.
			anchorY: anchorY + (line.ascentEm - line.descentEm - (word.ascentEm - word.descentEm)) * 0.5 * px,
		};
	});
	return { ...base, words, lineWidth: layout.widthEm * px, lineCenterX: left + (layout.widthEm * px) / 2, inkTopEm: layout.inkTopEm, inkBottomEm: layout.inkBottomEm };
}

/**
 * Where the active word's emoji goes: a colour picture from the shared atlas
 * (recorded as an overlay), or, when the atlas lacks that sequence, the
 * monochrome Noto glyph as an ASS event (returned, and noted as a fallback).
 * Placement is Studio's: 0.8em above the word, bottom edge on the line box top,
 * centred on the word, turning with the cue. A sequence neither draws is
 * skipped and reported.
 */
function placeEmoji(input: {
	emoji: string;
	geometry: CueGeometry;
	centerX: number;
	startSec: number;
	endSec: number;
	cueIndex: number;
	collector: TrackCollector;
}): { x: number; y: number; face: CaptionFace } | null {
	const { geometry, collector } = input;
	const boxTop = geometry.lineTopY;
	const heightPx = CAPTION_EMOJI_HEIGHT_EM * geometry.px;
	const centerY = boxTop - heightPx / 2;
	const sprite = resolveCaptionEmoji(input.emoji);
	if (sprite) {
		const angle = (geometry.tiltDeg * Math.PI) / 180;
		const dx = input.centerX - geometry.anchorX;
		const dy = centerY - geometry.anchorY;
		collector.emoji.push({
			...sprite,
			startSec: input.startSec,
			endSec: input.endSec,
			centerX: geometry.anchorX + dx * Math.cos(angle) - dy * Math.sin(angle),
			centerY: geometry.anchorY + dx * Math.sin(angle) + dy * Math.cos(angle),
			widthPx: CAPTION_EMOJI_WIDTH_EM * geometry.px,
			heightPx,
			rotationDeg: geometry.tiltDeg,
		});
		return null;
	}
	const mono = monochromeEmojiFace();
	const glyph = input.emoji.replace(/\ufe0f/g, "");
	// Only a single pictograph survives as one monochrome picture; a ZWJ, flag
	// or skin-tone sequence would split into unrelated glyphs.
	if ([...glyph].length === 1 && fontFileCovers(mono.path, glyph)) {
		collector.notices.set(`${mono.assName}\0${input.emoji}`, { code: "glyph_fallback_used", cluster: input.emoji, font: mono.assName, sequenceSplit: false });
		return { x: input.centerX, y: centerY, face: mono };
	}
	collector.emojiSkipped.push({ emoji: input.emoji, cueIndex: input.cueIndex });
	return null;
}

function stackEvents(input: {
 face: CaptionFontFace;
	glyphs: CaptionGlyphPlanner;
	preset: CaptionPreset;
	px: number;
	spans: readonly Span[];
	/** Text before each span after the first: a space (with the pill's extra advance), or nothing between abutting words. */
	separators?: readonly string[];
	startSec: number;
	endSec: number;
	position: { x: number; y: number };
	common: string;
	layers: Record<StackLayer, number>;
	keyframes?: readonly CaptionKeyframe[];
	/** Only the fill layer: the shadows, outer stroke and glow are already drawn by another event. */
	textOnly?: boolean;
}): AssEvent[] {
	const { preset, px } = input;
	const fitScale = px / preset.fontSize;
	const stroke = preset.outlineWidth * fitScale;
	const outer = (preset.outerOutlineWidth ?? 0) * fitScale;
	const durationMs = Math.round((input.endSec - input.startSec) * 1000);
	const motion = motionTags(input.keyframes ?? [], durationMs, px);
	const events: AssEvent[] = [];
	const push = (
		layer: number,
		offset: { x: number; y: number },
		extraBlurPx: number,
		bord: number,
		paint: (span: Span) => { fill: string; outline: string; opacity: number } | null,
	) => {
		const body = input.spans
			.map((span, index) => (index > 0 ? (input.separators?.[index] ?? "") : "") + spanText(span, paint(span), preset.primaryColor, input.glyphs, px, preset.letterSpacing))
			.join("");
		const position = motion.position(input.position.x + offset.x, input.position.y + offset.y);
		events.push({
			layer,
			startSec: input.startSec,
			endSec: input.endSec,
			style: "Caption",
			text:
				`{\\an5\\fn${input.face.assName}${position}${input.common}\\fs${num(assFontSize(input.face, px))}` +
				`\\fsp${num(preset.letterSpacing * px)}\\bord${num(bord)}\\shad0` +
				`${motion.tags(extraBlurPx)}}${body}`,
		});
	};

	const silhouette = stroke + outer;
	if (!input.textOnly && preset.shadow !== "none") {
		const shadowPaint = (opacity: number) => (span: Span) =>
			span.visibility > 0
				? { fill: preset.shadowColor, outline: preset.shadowColor, opacity: span.visibility * opacity }
				: null;
		if (preset.shadow === "soft") {
			push(
				input.layers.shadow,
				{ x: 0, y: CAPTION_SOFT_SHADOW.offsetYEm * px },
				CAPTION_SOFT_SHADOW.blurEm * px,
				silhouette,
				shadowPaint(CAPTION_SOFT_SHADOW.opacity),
			);
		} else if (preset.shadow === "hard") {
			push(
				input.layers.shadow,
				{ x: CAPTION_HARD_SHADOW.offsetXEm * px, y: CAPTION_HARD_SHADOW.offsetYEm * px },
				0,
				silhouette,
				shadowPaint(1),
			);
		} else {
			for (let step = CAPTION_EXTRUDE.steps; step >= 1; step--) {
				const distance = step * CAPTION_EXTRUDE.stepEm * px;
				push(input.layers.shadow, { x: distance, y: distance }, 0, silhouette, shadowPaint(1));
			}
		}
	}
	if (!input.textOnly && outer > 0 && preset.outerOutlineColor) {
		const color = preset.outerOutlineColor;
		push(input.layers.outer, { x: 0, y: 0 }, 0, silhouette, (span) =>
			span.visibility > 0 ? { fill: color, outline: color, opacity: span.visibility } : null,
		);
	}
	if (!input.textOnly && input.spans.some((span) => span.glow && span.visibility > 0)) {
		const intensity = preset.glowIntensity ?? 8;
		for (const sigma of CAPTION_GLOW_SIGMAS) {
			push(input.layers.glow, { x: 0, y: 0 }, sigma * intensity * fitScale, 0, (span) =>
				span.glow && span.visibility > 0
					? { fill: span.glow, outline: span.glow, opacity: span.visibility }
					: null,
			);
		}
	}
	push(input.layers.text, { x: 0, y: 0 }, 0, stroke, (span) =>
		span.visibility > 0
			? { fill: span.fill, outline: preset.outlineColor, opacity: span.visibility }
			: null,
	);
	return events;
}

/** One span's override block and text. Hidden spans keep their width (alpha only). */
function spanText(
	span: Span,
	paint: { fill: string; outline: string; opacity: number } | null,
	primaryColor: string,
	glyphs: CaptionGlyphPlanner,
	px: number,
	letterSpacingEm: number,
): string {
	const clusters = glyphs.plan(span.text);
	if (!paint) return `{\\alpha&HFF&}${assText(clusters, glyphs.requested, px, letterSpacingEm)}`;
	const colors = `\\1c${assColor(paint.fill)}\\3c${assColor(paint.outline)}\\alpha${assAlpha(paint.opacity)}`;
	if (span.sweepMs !== undefined) {
		// Karaoke sweep: unsung = secondary (primary colour), sung = fill.
		const unsung = paint.fill === primaryColor ? paint.fill : primaryColor;
		return `{${colors}\\2c${assColor(unsung)}\\kf${Math.max(1, Math.round(span.sweepMs / 10))}}${assText(clusters, glyphs.requested, px, letterSpacingEm)}`;
	}
	if (span.letterDelaysMs) {
		// Typewriter: `\ko` hides each letter (fill via \2a, outline via \ko)
		// until its syllable starts.
		let previous = 0;
		const letters = assText(clusters, glyphs.requested, px, letterSpacingEm, (index) => {
			const next = span.letterDelaysMs![index + 1];
			const duration = next === undefined ? 1 : next - previous;
			previous = next ?? previous;
			return `{\\ko${Math.max(0, Math.round(duration / 10))}}`;
		});
		return `{${colors}\\2a&HFF&}${letters}`;
	}
	return `{${colors}}${assText(clusters, glyphs.requested, px, letterSpacingEm)}`;
}

/**
 * The ASS text of planned clusters. A cluster drawn by a fallback face is
 * wrapped in `\fn`/`\fs` overrides sized to the same em as the requested
 * face; text the requested face covers has no overrides at all.
 */
function assText(
	clusters: readonly PlannedCluster[],
	requested: CaptionFace,
	px: number,
	letterSpacingEm: number,
	/** Override block placed before each cluster (typewriter letters). */
	beforeCluster?: (index: number) => string,
): string {
	let current = requested;
	let spaced = true;
	let text = "";
	// libass stops joining and reordering cursive/complex scripts under non-zero `\\fsp`.
	const switchTo = (face: CaptionFace, faceSpaced: boolean): string => {
		const font = face !== current ? `\\fn${face.assName}\\fs${num(px * face.lineHeightEm)}` : "";
		const spacing = faceSpaced !== spaced ? `\\fsp${faceSpaced ? num(letterSpacingEm * px) : 0}` : "";
		return `{${font}${spacing}}`;
	};
	for (const [index, cluster] of clusters.entries()) {
		text += beforeCluster?.(index) ?? "";
		for (const part of cluster.parts) {
			if (part.face !== current || part.spaced !== spaced) {
				text += switchTo(part.face, part.spaced);
				current = part.face;
				spaced = part.spaced;
			}
			text += escapeAssText(part.text);
		}
	}
	if (current !== requested || !spaced) text += switchTo(requested, true);
	return text;
}

/**
 * Motion keyframes as ASS tags for one event: `\fscx/\fscy/\frx/\blur` through
 * `\t` (ease = acceleration), opacity through `\fade` (libass fades linearly;
 * the spec only has rising opacity tracks) and the vertical offset through
 * `\move` (linear). `px` converts em keyframes to canvas px.
 */
function motionTags(keyframes: readonly CaptionKeyframe[], durationMs: number, px: number) {
	const frames = (property: keyof Omit<CaptionKeyframe, "at" | "ease">) =>
		keyframes.filter((frame) => frame[property] !== undefined);
	const animate = (
		property: "scaleX" | "scaleY" | "rotateXDeg" | "blurEm",
		tag: string,
		format: (value: number) => string,
	) => {
		const track = frames(property);
		if (track.length === 0) return "";
		let tags = `\\${tag}${format(track[0]![property]!)}`;
		for (let index = 1; index < track.length; index++) {
			const from = track[index - 1]!;
			const to = track[index]!;
			tags += `\\t(${from.at},${to.at},${CAPTION_EASE_ACCEL[to.ease ?? "linear"]},\\${tag}${format(to[property]!)})`;
		}
		return tags;
	};
	const opacity = frames("opacity");
	const offset = frames("offsetYEm");
	return {
		/** `layerBlurPx`: the layer's own Gaussian sigma (soft shadow, glow). */
		tags(layerBlurPx: number): string {
			const blur = (em: number) => num((em * px + layerBlurPx) * ASS_BLUR_PER_SIGMA);
			let tags =
				animate("scaleX", "fscx", (value) => num(value * 100)) +
				animate("scaleY", "fscy", (value) => num(value * 100)) +
				// CSS rotateX(-a) tips the top edge toward the viewer; ASS \frx turns the other way.
				animate("rotateXDeg", "frx", (value) => num(-value));
			if (frames("blurEm").length > 0) tags += animate("blurEm", "blur", blur);
			else if (layerBlurPx > 0) tags += `\\blur${blur(0)}`;
			if (opacity.length >= 2) {
				const from = opacity[0]!;
				const to = opacity[opacity.length - 1]!;
				const hold = Math.max(to.at, durationMs);
				tags += `\\fade(${alphaByte(from.opacity!)},${alphaByte(to.opacity!)},${alphaByte(to.opacity!)},${from.at},${to.at},${hold},${hold})`;
			}
			return tags;
		},
		position(x: number, y: number): string {
			if (offset.length < 2) return `\\pos(${num(x)},${num(y)})`;
			const from = offset[0]!;
			const to = offset[offset.length - 1]!;
			return `\\move(${num(x)},${num(y + from.offsetYEm! * px)},${num(x)},${num(y + to.offsetYEm! * px)},${from.at},${to.at})`;
		},
	};
}

function pillEvent(input: {
	preset: CaptionPreset;
	face: CaptionFontFace;
	geometry: CueGeometry;
	box: { centerX: number; width: number; inkTopEm: number; inkBottomEm: number };
	motion: CaptionMotionSpec;
	layer: number;
	startSec: number;
	endSec: number;
	common: string;
}): AssEvent {
	const { preset, face, geometry, box } = input;
	const px = geometry.px;
	const width = box.width + 2 * CAPTION_PILL.padXEm * px;
	const { top, bottom } = decorationSpan(face, geometry, CAPTION_PILL, box);
	// The pill rides on the word: its scale is the pill entrance times the
	// word motion, sampled into linear segments (the preview nests the two).
	const times = [...new Set([...CAPTION_PILL.enter.map((frame) => frame.at), ...input.motion.word.map((frame) => frame.at)])]
		.flatMap((at, index, all) => (index === 0 ? [at] : [(all[index - 1]! + at) / 2, at]))
		.sort((left, right) => left - right);
	const scaleAt = (axis: "scaleX" | "scaleY", at: number) =>
		(captionKeyframeValue(CAPTION_PILL.enter, axis, at) ?? 1) *
		(captionKeyframeValue(input.motion.word, axis, at) ?? 1);
	let tags = `\\fscx${num(scaleAt("scaleX", 0) * 100)}\\fscy${num(scaleAt("scaleY", 0) * 100)}`;
	for (let index = 1; index < times.length; index++) {
		const at = times[index]!;
		tags += `\\t(${num(times[index - 1]!)},${num(at)},\\fscx${num(scaleAt("scaleX", at) * 100)}\\fscy${num(scaleAt("scaleY", at) * 100)})`;
	}
	const enterEnd = CAPTION_PILL.enter[CAPTION_PILL.enter.length - 1]!.at;
	const holdMs = Math.max(enterEnd, Math.round((input.endSec - input.startSec) * 1000));
	const fade = input.common.includes("\\fad(") ? "" : `\\fade(255,0,0,0,${enterEnd},${holdMs},${holdMs})`;
	return {
		layer: input.layer,
		startSec: input.startSec,
		endSec: input.endSec,
		style: "Shape",
		text:
			`{\\an5\\pos(${num(box.centerX)},${num((top + bottom) / 2)})${input.common}${fade}\\bord0\\shad0` +
			`\\1c${assColor(preset.highlightBoxColor!)}\\1a${assAlpha(preset.highlightBoxOpacity ?? 1)}${tags}\\p1}` +
			roundedRectPath(width, bottom - top, CAPTION_PILL.radiusEm * px) +
			"{\\p0}",
	};
}

function glitchEvents(input: {
 face: CaptionFontFace;
	glyphs: CaptionGlyphPlanner;
	preset: CaptionPreset;
	geometry: CueGeometry;
	box: { centerX: number; eventX: number; width: number; anchorY: number };
	span: Span;
	startSec: number;
	endSec: number;
	tilt: string;
}): AssEvent[] {
	const { preset, geometry, box, span } = input;
	const px = geometry.px;
	const events: AssEvent[] = [];
	const slices = [
		...CAPTION_GLITCH.steps.map((step, index) => ({
			startSec: input.startSec + (index * CAPTION_GLITCH.stepMs) / 1000,
			endSec: input.startSec + ((index + 1) * CAPTION_GLITCH.stepMs) / 1000,
			ghostEm: step.ghostEm,
			ghostOpacity: CAPTION_GLITCH.ghostOpacity,
			textDxEm: step.textDxEm,
			shear: step.shear,
		})),
		{
			startSec: input.startSec + (CAPTION_GLITCH.steps.length * CAPTION_GLITCH.stepMs) / 1000,
			endSec: input.endSec,
			ghostEm: CAPTION_GLITCH.heldGhostEm,
			ghostOpacity: CAPTION_GLITCH.heldGhostOpacity,
			textDxEm: 0,
			shear: 0,
		},
	];
	for (const slice of slices) {
		const startSec = slice.startSec;
		const endSec = Math.min(slice.endSec, input.endSec);
		if (endSec <= startSec) continue;
		const fs = num(assFontSize(input.face, px));
		const fsp = num(preset.letterSpacing * px);
		CAPTION_GLITCH.ghostColors.forEach((color, ghostIndex) => {
			const sign = ghostIndex === 0 ? 1 : -1;
			const x = box.eventX + sign * slice.ghostEm[0] * px;
			const y = box.anchorY + sign * slice.ghostEm[1] * px;
			events.push({
				layer: LAYER.ghost,
				startSec,
				endSec,
				style: "Caption",
				text: `{\\an5\\pos(${num(x)},${num(y)})${input.tilt}\\fs${fs}\\fsp${fsp}\\bord0\\shad0\\1c${assColor(color)}\\alpha${assAlpha(slice.ghostOpacity)}}${assText(input.glyphs.plan(span.text), input.glyphs.requested, px, preset.letterSpacing)}`,
			});
		});
		events.push(
			...stackEvents({
				preset, face: input.face, glyphs: input.glyphs,
				px,
				spans: [span],
				startSec,
				endSec,
				position: { x: box.eventX + slice.textDxEm * px, y: box.anchorY },
				common: `${input.tilt}${slice.shear ? `\\fax${num(slice.shear)}` : ""}`,
				layers: {
					shadow: LAYER.overlayShadow,
					outer: LAYER.overlayOuter,
					glow: LAYER.overlayGlow,
					text: LAYER.overlayText,
				},
			}),
		);
	}
	return events;
}

/** Splits the cue's opening events into constant-opacity slices (neon flicker). */
function applyFlicker(
	events: readonly AssEvent[],
	cueStart: number,
	flicker: readonly { at: number; opacity: number }[],
): AssEvent[] {
	const steps = flicker.map((step, index) => ({
		startSec: cueStart + step.at / 1000,
		endSec: index + 1 < flicker.length ? cueStart + flicker[index + 1]!.at / 1000 : Number.POSITIVE_INFINITY,
		opacity: step.opacity,
	}));
	return events.flatMap((event) =>
		steps.flatMap((step) => {
			const startSec = Math.max(event.startSec, step.startSec);
			const endSec = Math.min(event.endSec, step.endSec);
			if (endSec <= startSec || step.opacity <= 0) return [];
			if (step.opacity >= 1) return [{ ...event, startSec, endSec }];
			const alpha = alphaByte(step.opacity);
			return [
				{
					...event,
					startSec,
					endSec,
					text: event.text.replace(/^\{/, `{\\fade(${alpha},${alpha},${alpha},0,0,0,0)`),
				},
			];
		}),
	);
}

/**
 * Vertical extent of a pill or plate: padding above the cap height and below
 * the baseline, grown to the ink of fallback faces whose glyphs stand taller or
 * hang lower (Nastaliq swashes, Indic and Thai marks): a pill by its own
 * word's ink, a plate by the whole line's. Latin lines have no fallback ink and
 * keep the catalog metrics exactly.
 */
function decorationSpan(face: CaptionFontFace, geometry: CueGeometry, pad: { padTopEm: number; padBottomEm: number }, ink: { inkTopEm: number; inkBottomEm: number }) {
	const px = geometry.px;
	return {
		top: geometry.baselineY - (Math.max(face.capHeight, ink.inkTopEm) + pad.padTopEm) * px,
		bottom: geometry.baselineY + Math.max(pad.padBottomEm, ink.inkBottomEm + CAPTION_INK_MARGIN_EM) * px,
	};
}

function plateRect(face: CaptionFontFace, geometry: CueGeometry) {
	const px = geometry.px;
	const width = geometry.lineWidth! + 2 * CAPTION_PLATE.padXEm * px;
	const { top, bottom } = decorationSpan(face, geometry, CAPTION_PLATE, geometry);
	return { centerX: geometry.lineCenterX, centerY: (top + bottom) / 2, width, height: bottom - top };
}

function tiltTags(geometry: CueGeometry): string {
	if (geometry.tiltDeg === 0) return "";
	// ASS \frz turns counter-clockwise; the spec's tilt is clockwise like CSS.
	return `\\org(${num(geometry.anchorX)},${num(geometry.anchorY)})\\frz${num(-geometry.tiltDeg)}`;
}

/** Rounded rectangle from (0,0) to (w,h) as an ASS `\p1` path. */
export function roundedRectPath(width: number, height: number, radius: number): string {
	const r = Math.max(0, Math.min(radius, width / 2, height / 2));
	const k = r * 0.5523;
	const w = width;
	const h = height;
	return [
		`m ${num(r)} 0`,
		`l ${num(w - r)} 0`,
		`b ${num(w - r + k)} 0 ${num(w)} ${num(r - k)} ${num(w)} ${num(r)}`,
		`l ${num(w)} ${num(h - r)}`,
		`b ${num(w)} ${num(h - r + k)} ${num(w - r + k)} ${num(h)} ${num(w - r)} ${num(h)}`,
		`l ${num(r)} ${num(h)}`,
		`b ${num(r - k)} ${num(h)} 0 ${num(h - r + k)} 0 ${num(h - r)}`,
		`l 0 ${num(r)}`,
		`b 0 ${num(r - k)} ${num(r - k)} 0 ${num(r)} 0`,
	].join(" ");
}

/** libass sizes a font so ascent + descent (win metrics) equals the ASS font size. */
function assFontSize(face: CaptionFontFace, emPx: number): number {
	return emPx * (face.ascent + face.descent);
}

function assTime(seconds: number): string {
	const totalCs = Math.max(0, Math.round(seconds * 100));
	const h = Math.floor(totalCs / 360_000);
	const m = Math.floor((totalCs % 360_000) / 6000);
	const s = Math.floor((totalCs % 6000) / 100);
	const cs = totalCs % 100;
	return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function assColor(hex: string): string {
	return `&H${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}&`.toUpperCase();
}

/** ASS alpha is inverse opacity: 00 opaque, FF transparent. */
function assAlpha(opacity: number): string {
	return `&H${alphaByte(opacity).toString(16).toUpperCase().padStart(2, "0")}&`;
}

function alphaByte(opacity: number): number {
	return Math.round((1 - Math.max(0, Math.min(1, opacity))) * 255);
}

function num(value: number): string {
	return String(Math.round(value * 100) / 100);
}

/** Braces and backslashes would open override blocks or escapes in ASS text. */
function escapeAssText(text: string): string {
	return text.replace(/[{}\\]/g, "");
}
