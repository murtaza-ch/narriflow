import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type CaptionBehindPlacement,
	captionBehindColumns,
	captionBehindPlacement,
	captionMatteColumnTop,
} from "@narriflow/caption-fonts/caption-block";
import type { ClipCompositionPlan, CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import type { RenderBrandFonts } from "./brand-font-resolution";
import { type CaptionTrack, captionBehindCandidates } from "./caption-ass";
import {
	type CompositionCaptionBehindInput,
	compileCompositionPlanMatteCommand,
	PERSON_MATTE_FPS,
	personMatteFrameIndex,
} from "./composition-ffmpeg-adapter";
import type { WorkerMediaInspection } from "./worker-process";
import type { ClipCutPlan } from "./tasks/cut-plan";

// Heroes drawn behind the speaker (dynamic captions spec 5.12), worker side. Before a target's
// render, `preparePersonMatte` writes the person matte over the plan's `mattes` (person_matte.py),
// runs it through the visual stack in matte mode (the matte pass), and places every behind cue
// with the shared rule from the canvas matte at its hero's onset. The render then alphamerges
// the canvas matte inside the behind rows' box. Any failure is typed degradation: those heroes
// are drawn in front and the render records `caption_matte_unavailable`.

export const PERSON_MATTE_SCRIPT = fileURLToPath(new URL("../python/narriflow_media/person_matte.py", import.meta.url));

/** The notice a render records when its person matte could not be made. */
export const CAPTION_MATTE_UNAVAILABLE = "caption_matte_unavailable";

export interface PersonMatteCommandResult {
	readonly exitCode: number;
	readonly stdout: string;
}

export interface PreparedPersonMatte {
	readonly status: "ready";
	/** Placement of each behind cue, by cue index, for `renderCaptionTrack`. */
	readonly placements: ReadonlyMap<number, CaptionBehindPlacement>;
	/** The canvas matte the render takes as its last input. */
	readonly mattePath: string;
	readonly matteSize: { readonly width: number; readonly height: number };
}

export type PersonMatteOutcome =
	| PreparedPersonMatte
	| { readonly status: "none" }
	| { readonly status: "unavailable"; readonly reason: string };

/** The person_matte.py spec for one target, or null when the target needs no matte. */
export function personMatteSpec(input: {
	plan: ClipCompositionPlan;
	targetId: string;
	sourcePath: string;
	startSec: number;
	endSec: number;
	outputPath: string;
	modelPath: string;
}): Record<string, unknown> | null {
	const target = input.plan.targets.find((candidate) => candidate.id === input.targetId);
	if (!target?.mattes?.length) return null;
	return {
		source: input.sourcePath,
		output: input.outputPath,
		window: [input.startSec, input.endSec],
		size: [input.plan.source.width, input.plan.source.height],
		fps: PERSON_MATTE_FPS,
		model: input.modelPath,
		ranges: target.mattes.map((matte) => ({
			start: matte.sourceStartSec,
			end: matte.sourceEndSec,
			regions: matte.region.map((rect) => [rect.x, rect.y, rect.width, rect.height]),
		})),
	};
}

/**
 * Makes the person matte for one target and places its behind cues. `run` executes a command and
 * resolves with its exit code (it may reject on a deadline or abort, which propagates); any
 * other failure resolves to `unavailable`.
 */
export async function preparePersonMatte(input: {
	plan: ClipCompositionPlan;
	targetId: string;
	sourcePath: string;
	startSec: number;
	endSec: number;
	source: WorkerMediaInspection;
	cutPlan?: ClipCutPlan | null;
	fonts?: RenderBrandFonts;
	directory: string;
	python: string;
	modelPath: string;
	run: (command: string, args: string[]) => Promise<PersonMatteCommandResult>;
	writeFile: (path: string, contents: string) => Promise<void>;
	readFile: (path: string) => Promise<Uint8Array>;
}): Promise<PersonMatteOutcome> {
	const target = input.plan.targets.find((candidate) => candidate.id === input.targetId);
	if (!target?.mattes?.length || !input.source.hasVideo) return { status: "none" };
	const layers = target.visualLayers.filter((layer): layer is CompositionCaptionVisualLayer => layer.kind === "caption");
	const candidates = captionBehindCandidates({ layers, canvas: target.canvas, ...(input.fonts ? { fonts: input.fonts } : {}) });
	if (candidates.length === 0) return { status: "none" };
	const stem = join(input.directory, `person-matte-${target.id.replace(/[^\w-]/g, "_")}`);
	const specPath = `${stem}.json`;
	const sourceMattePath = `${stem}-source.mkv`;
	const spec = personMatteSpec({ ...input, outputPath: sourceMattePath });
	await input.writeFile(specPath, JSON.stringify(spec));
	const matte = await input.run(input.python, [PERSON_MATTE_SCRIPT, "--spec", specPath]);
	if (matte.exitCode !== 0) return { status: "unavailable", reason: matteFailureReason(matte) };
	const mattePath = `${stem}-canvas.mkv`;
	const probePath = `${stem}-probe.gray`;
	const command = compileCompositionPlanMatteCommand({
		plan: input.plan,
		targetId: target.id,
		mattePath: sourceMattePath,
		startSec: input.startSec,
		source: input.source,
		...(input.cutPlan ? { cutPlan: input.cutPlan } : {}),
		outputPath: mattePath,
		probePath,
		probeTimesSec: candidates.map((candidate) => candidate.onsetSec),
	});
	const pass = await input.run("ffmpeg", ["-nostdin", "-loglevel", "error", ...command.args]);
	if (pass.exitCode !== 0) return { status: "unavailable", reason: "matte_pass_failed" };
	const frameBytes = command.size.width * command.size.height;
	const probe = await input.readFile(probePath);
	if (probe.byteLength < frameBytes * command.probeFrames.length) return { status: "unavailable", reason: "matte_probe_short" };
	const placements = new Map<number, CaptionBehindPlacement>();
	for (const candidate of candidates) {
		const at = command.probeFrames.indexOf(personMatteFrameIndex(candidate.onsetSec));
		const data = probe.subarray(at * frameBytes, (at + 1) * frameBytes);
		const frame = { width: command.size.width, height: command.size.height, data };
		const personTop = captionBehindColumns(candidate.heroInk).map((x) => captionMatteColumnTop(frame, target.canvas, x));
		placements.set(candidate.cueIndex, captionBehindPlacement({ heroInk: candidate.heroInk, bounds: candidate.bounds, canvas: target.canvas, personTop }));
	}
	return { status: "ready", placements, mattePath, matteSize: command.size };
}

function matteFailureReason(result: PersonMatteCommandResult): string {
	try {
		const parsed = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "") as { detail?: unknown; error?: unknown };
		return String(parsed.detail ?? parsed.error ?? `exit_${result.exitCode}`).slice(0, 200);
	} catch {
		return `exit_${result.exitCode}`;
	}
}

/**
 * The graph input for a track drawn with a prepared matte, or null when no cue ended up behind.
 * The person is redrawn in a full-width band around the behind cues' reserved bounds, grown by a
 * quarter of its height so the hero's soft shadow under the person is covered too.
 */
export function captionBehindGraphInput(input: {
	track: Pick<CaptionTrack, "behindAss" | "behind">;
	matte: PreparedPersonMatte;
	subtitlePath: string;
	canvas: { readonly width: number; readonly height: number };
}): CompositionCaptionBehindInput | null {
	const { track, canvas } = input;
	if (!track.behindAss || track.behind.length === 0) return null;
	const top = Math.min(...track.behind.map((cue) => cue.bounds.y));
	const bottom = Math.max(...track.behind.map((cue) => cue.bounds.y + cue.bounds.height));
	const pad = Math.max(24, (bottom - top) / 4);
	const limit = Math.floor(canvas.height / 4) * 4;
	const y = Math.max(0, Math.floor((top - pad) / 4) * 4);
	const end = Math.min(limit, Math.ceil((bottom + pad) / 4) * 4);
	return {
		subtitlePath: input.subtitlePath,
		mattePath: input.matte.mattePath,
		matteSize: input.matte.matteSize,
		canvas: { width: canvas.width, height: canvas.height },
		box: { x: 0, y, width: Math.floor(canvas.width / 2) * 2, height: Math.max(4, end - y) },
		windows: track.behind.map((cue) => ({ startSec: cue.startSec, endSec: cue.endSec })),
	};
}
