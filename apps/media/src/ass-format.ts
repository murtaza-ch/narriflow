import type { CaptionFontFace } from "@narriflow/validators";
import type { CaptionFace, PlannedCluster } from "./caption-glyphs";

/**
 * ASS serialization primitives shared by the classic and Dynamic caption writer (caption-ass.ts)
 * and the Scene Style writer (caption-scene-ass.ts): event shape, time and colour formatting, and
 * the text of planned glyph clusters.
 */

/** libass `\blur` strength per unit of Gaussian standard deviation. */
export const ASS_BLUR_PER_SIGMA = 1 / 0.849;

export interface AssEvent {
	readonly layer: number;
	readonly startSec: number;
	readonly endSec: number;
	readonly style: "Caption" | "Shape";
	readonly text: string;
}

/**
 * The ASS text of planned clusters. A cluster drawn by a fallback face is
 * wrapped in `\fn`/`\fs` overrides sized to the same em as the requested
 * face; text the requested face covers has no overrides at all.
 */
export function assText(
	clusters: readonly PlannedCluster[],
	requested: CaptionFace,
	px: number,
	letterSpacingEm: number,
	/** Override block placed before each cluster (typewriter letters). */
	beforeCluster?: (index: number) => string,
	/** Keep braces and backslashes as typed (`escapeLiteralAssText`) instead of leaving them out. */
	literal = false,
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
			text += literal ? escapeLiteralAssText(part.text) : escapeAssText(part.text);
		}
	}
	if (current !== requested || !spaced) text += switchTo(requested, true);
	return text;
}

/** libass sizes a font so ascent + descent (win metrics) equals the ASS font size. */
export function assFontSize(face: CaptionFontFace, emPx: number): number {
	return emPx * (face.ascent + face.descent);
}

export function assTime(seconds: number): string {
	const totalCs = Math.max(0, Math.round(seconds * 100));
	const h = Math.floor(totalCs / 360_000);
	const m = Math.floor((totalCs % 360_000) / 6000);
	const s = Math.floor((totalCs % 6000) / 100);
	const cs = totalCs % 100;
	return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export function assColor(hex: string): string {
	return `&H${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}&`.toUpperCase();
}

/** ASS alpha is inverse opacity: 00 opaque, FF transparent. */
export function assAlpha(opacity: number): string {
	return `&H${alphaByte(opacity).toString(16).toUpperCase().padStart(2, "0")}&`;
}

export function alphaByte(opacity: number): number {
	return Math.round((1 - Math.max(0, Math.min(1, opacity))) * 255);
}

export function num(value: number): string {
	return String(Math.round(value * 100) / 100);
}

/** Braces and backslashes would open override blocks or escapes in ASS text. */
export function escapeAssText(text: string): string {
	return text.replace(/[{}\\]/g, "");
}

/**
 * Braces and backslashes drawn as typed. libass reads `\{` and `\}` as literal braces. A backslash is
 * followed by U+2060 WORD JOINER (zero width, no glyph needed), so it can never start an escape
 * (`\N`, `\h`, `\{`), not even with the override block a fallback face opens right after it.
 * Settled against a real libass render (title-text ticket 02).
 */
export function escapeLiteralAssText(text: string): string {
	return text.replace(/\\/g, "\\\u2060").replace(/[{}]/g, (brace) => `\\${brace}`);
}
