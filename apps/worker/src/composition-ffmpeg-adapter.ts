import { WorkflowFailure } from "@narriflow/services";
import {
	clipAspectRatioOptions,
	type ClipAspectRatio,
	type BrandTemplateSnapshot,
} from "@narriflow/validators";
import type { CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import {
	HTTP_SOURCE_RW_TIMEOUT_US,
	type WorkerMediaInspection,
} from "./worker-process";
import { buildDuckingVolumeExpression } from "./tasks/ducking";
import type { ClipCutPlan } from "./tasks/cut-plan";
import {
	CLIP_COMPOSITION_PLAN_VERSION,
	COMPOSITION_MOTION_VERSION,
	SCENE_CONTINUITY_EPSILON_SEC,
	assertCompositionSceneTextRender,
	compositionAssetRef,
	type ClipCompositionPlan,
	type CompositionBrollVideoLayer,
	type CompositionBrollImageLayer,
	type CompositionInsertedSceneLayer,
	type CompositionMotionPlan,
	type CompositionMotionState,
	type CompositionRect,
	type CompositionSourceVideoLayer,
	type CompositionTargetPlan,
	type CompositionVisualLayer,
} from "@narriflow/composition-plan";
import { escapeDrawtextText } from "./ffmpeg-text";

export function compileOptionalMediaValidationCommand(
	filePath: string,
	kind: "video" | "audio" | "image",
): string[] {
	return [
		"-v",
		"error",
		"-i",
		filePath,
		"-map",
		kind === "audio" ? "0:a:0" : "0:v:0",
		"-f",
		"null",
		"-",
	];
}

export function compileLayoutEvidenceSegmentCommand(input: {
	sourcePath: string;
	outputPath: string;
	startSec: number;
	durationSec: number;
}): string[] {
	return [
		"-y",
		...httpSourceInputArgs(input.sourcePath),
		"-ss",
		String(input.startSec),
		"-t",
		String(input.durationSec),
		"-i",
		input.sourcePath,
		"-map",
		"0:v:0",
		"-vf",
		"scale=-2:360",
		"-c:v",
		"libx264",
		"-preset",
		"ultrafast",
		"-crf",
		"30",
		"-an",
		input.outputPath,
	];
}

export function compileCompositionPlanAudiogram(
	plan: ClipCompositionPlan,
	targetId: string,
) {
	if (plan.version !== CLIP_COMPOSITION_PLAN_VERSION) {
		throw new Error("unsupported_clip_composition_plan_version");
	}
	const target = plan.targets.find((candidate) => candidate.id === targetId);
	if (!target) throw new Error("clip_composition_target_missing");
	if (target.effectiveMode !== "audiogram" || target.scenes.length === 0) {
		throw new Error("clip_composition_audiogram_missing");
	}
	const scene = target.scenes.find((candidate) =>
		candidate.layers.some((layer) => layer.kind === "audiogram"),
	);
	if (!scene) throw new Error("clip_composition_audiogram_missing");
	const layer = scene.layers.find(
		(candidate) => candidate.kind === "audiogram",
	);
	if (
		!layer ||
		layer.sourceRef !== plan.source.ref ||
		layer.destination.x !== 0 ||
		layer.destination.y !== 0 ||
		layer.destination.width !== target.canvas.width ||
		layer.destination.height !== target.canvas.height ||
		layer.waveformHeightRatio <= 0 ||
		layer.waveformHeightRatio > 1
	) {
		throw new Error("invalid_clip_composition_audiogram");
	}
	return {
		sourceRef: layer.sourceRef,
		canvas: target.canvas,
		backgroundColor: layer.backgroundColor,
		waveformColor: layer.waveformColor,
		waveformHeight: Math.round(
			target.canvas.height * layer.waveformHeightRatio,
		),
	};
}

export function compileCompositionPlanAudioSchedule(plan: ClipCompositionPlan) {
	if (plan.version !== CLIP_COMPOSITION_PLAN_VERSION) {
		throw new Error("unsupported_clip_composition_plan_version");
	}
	const schedule = plan.audioSchedule;
	const validRange = (range: { startSec: number; endSec: number }) =>
		Number.isFinite(range.startSec) &&
		Number.isFinite(range.endSec) &&
		range.startSec >= 0 &&
		range.endSec > range.startSec &&
		range.endSec <= plan.editedDurationSec;
	const validFadeRange = (range: { startSec: number; endSec: number }) =>
		Number.isFinite(range.startSec) &&
		Number.isFinite(range.endSec) &&
		range.startSec >= 0 &&
		range.endSec >= range.startSec &&
		range.endSec <= plan.editedDurationSec;
	if (
		!validFadeRange(schedule.outputFades.fadeIn) ||
		!validFadeRange(schedule.outputFades.fadeOut) ||
		!validRange(schedule.source.activeRange) ||
		!Number.isFinite(schedule.source.gain) ||
		schedule.source.gain < 0 ||
		schedule.source.gain > 1
	) {
		throw new Error("invalid_clip_composition_audio_schedule");
	}
	const music = schedule.music;
	if (
		music &&
		(!validRange(music.activeRange) ||
			!validFadeRange(music.fades.fadeIn) ||
			!validFadeRange(music.fades.fadeOut) ||
			music.fades.fadeIn.endSec > music.fades.fadeOut.startSec ||
			!Number.isFinite(music.gain) ||
			music.gain < 0 ||
			music.gain > 1 ||
			!Number.isFinite(music.startOffsetSec) ||
			music.startOffsetSec < 0 ||
			music.ducking.windows.some((window) => !validRange(window)))
	) {
		throw new Error("invalid_clip_composition_audio_schedule");
	}
	if (
		schedule.soundEffects.some(
			(effect) =>
				!validRange(effect.activeRange) ||
				!Number.isFinite(effect.gain) ||
				effect.gain < 0 ||
				effect.gain > 1,
		)
	) {
		throw new Error("invalid_clip_composition_audio_schedule");
	}
	if (
		schedule.censors.some((censor, index) => {
			if (!validRange(censor)) return true;
			const previous = schedule.censors[index - 1];
			if (previous && previous.endSec > censor.startSec) return true;
			if (censor.treatment === "mute") return false;
			const durationSec = censor.endSec - censor.startSec;
			return (
				!Number.isFinite(censor.frequencyHz) ||
				censor.frequencyHz < 200 ||
				censor.frequencyHz > 2_000 ||
				!Number.isFinite(censor.gain) ||
				censor.gain < 0 ||
				censor.gain > 0.95 ||
				!Number.isFinite(censor.fadeInSec) ||
				!Number.isFinite(censor.fadeOutSec) ||
				censor.fadeInSec < 0 ||
				censor.fadeOutSec < 0 ||
				censor.fadeInSec + censor.fadeOutSec > durationSec
			);
		})
	) {
		throw new Error("invalid_clip_composition_audio_schedule");
	}
	return {
		scheduleFingerprint: schedule.fingerprint,
		outputFades: schedule.outputFades,
		source: {
			activeRange: schedule.source.activeRange,
			available: schedule.source.available,
			gain: schedule.source.gain,
			muted: schedule.source.muted,
		},
		music: music
			? {
					sourceRef: music.sourceRef,
					activeRange: music.activeRange,
					gain: music.gain,
					startOffsetSec: music.startOffsetSec,
					sourceDurationSec: music.sourceDurationSec,
					loop: music.loop,
					fades: music.fades,
					ducking: music.ducking,
				}
			: null,
		soundEffects: schedule.soundEffects.map((effect) => ({
			id: effect.id,
			sourceRef: effect.sourceRef,
			activeRange: effect.activeRange,
			gain: effect.gain,
		})),
		censors: schedule.censors.map((censor) => ({ ...censor })),
	};
}

export type CompositionAudioRenderRequest = ReturnType<
	typeof compileCompositionPlanAudioSchedule
>;

export function bindCompositionPlanAudioInputs(
	request: CompositionAudioRenderRequest,
	resolved: {
		music?: { sourceRef: string; path: string } | null;
		soundEffects?: readonly {
			id: string;
			sourceRef: string;
			path: string;
		}[];
	},
) {
	const music = request.music
		? resolved.music?.sourceRef === request.music.sourceRef
			? { ...request.music, path: resolved.music.path }
			: null
		: null;
	if (request.music && !music) {
		throw new Error("clip_composition_music_input_missing");
	}
	const soundEffects = request.soundEffects.map((planned) => {
		const input = resolved.soundEffects?.find(
			(candidate) =>
				candidate.id === planned.id &&
				candidate.sourceRef === planned.sourceRef,
		);
		if (!input) throw new Error("clip_composition_sound_effect_input_missing");
		return { ...planned, path: input.path };
	});
	return { ...request, music, soundEffects };
}

export type BoundCompositionAudioRenderRequest = ReturnType<
	typeof bindCompositionPlanAudioInputs
>;

export function compileCompositionPlanSceneAudio(input: {
	plan: ClipCompositionPlan;
	targetId: string;
	sourceAudioLabel: string | null;
	sceneInputs: ReadonlyArray<{
		sourceRef: string;
		inputIndex: number;
		hasAudio: boolean;
	}>;
}) {
	const target = input.plan.targets.find(
		(candidate) => candidate.id === input.targetId,
	);
	if (!target) throw new Error("clip_composition_target_missing");
	if (
		!target.scenes.some((scene) =>
			scene.layers.some((layer) => layer.kind === "inserted-scene"),
		)
	) {
		return { filterParts: [] as string[], outputLabel: input.sourceAudioLabel };
	}
	const sourceScenes = target.scenes.filter((scene) => scene.sourceRange);
	const sourceLabels = sourceScenes.map(
		(_, index) => `[composition_source_audio_${index}]`,
	);
	const parts: string[] = [];
	if (input.sourceAudioLabel && sourceLabels.length > 1) {
		parts.push(
			`${input.sourceAudioLabel}asplit=${sourceLabels.length}${sourceLabels.join("")}`,
		);
	}
	let sourceIndex = 0;
	const outputs: string[] = [];
	target.scenes.forEach((scene, index) => {
		const duration = scene.endSec - scene.startSec;
		const output = `[composition_scene_audio_${index}]`;
		outputs.push(output);
		const inserted = scene.layers.find(
			(layer): layer is CompositionInsertedSceneLayer =>
				layer.kind === "inserted-scene",
		);
		if (!inserted) {
			if (!input.sourceAudioLabel) {
				parts.push(
					`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${duration.toFixed(3)}${output}`,
				);
				return;
			}
			const source =
				sourceLabels.length === 1
					? input.sourceAudioLabel
					: sourceLabels[sourceIndex]!;
			sourceIndex += 1;
			parts.push(
				`${source}atrim=start=${scene.sourceRange!.startSec.toFixed(3)}:end=${scene.sourceRange!.endSec.toFixed(3)},asetpts=PTS-STARTPTS${output}`,
			);
			return;
		}
		if (inserted.content.kind === "video" && !inserted.content.muted) {
			const asset = input.sceneInputs.find(
				(candidate) => candidate.sourceRef === inserted.sourceRef,
			);
			if (asset?.hasAudio) {
				parts.push(
					`[${asset.inputIndex}:a]atrim=start=${inserted.content.sourceStartSec.toFixed(3)}:end=${inserted.content.sourceEndSec.toFixed(3)},asetpts=PTS-STARTPTS,volume=${(inserted.content.volume / 100).toFixed(3)},apad,atrim=duration=${duration.toFixed(3)}${output}`,
				);
				return;
			}
		}
		parts.push(
			`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${duration.toFixed(3)}${output}`,
		);
	});
	parts.push(
		`${outputs.join("")}concat=n=${outputs.length}:v=0:a=1[composition_scene_audio]`,
	);
	return { filterParts: parts, outputLabel: "[composition_scene_audio]" };
}

function assertCompositionMotion(
	motion: CompositionMotionPlan,
	canvas: { width: number; height: number },
): void {
	if (motion.version !== COMPOSITION_MOTION_VERSION) {
		throw new Error("unsupported_composition_motion_version");
	}
	const validRange = (range: { startSec: number; endSec: number }) =>
		Number.isFinite(range.startSec) &&
		Number.isFinite(range.endSec) &&
		range.startSec >= motion.activeRange.startSec &&
		range.endSec <= motion.activeRange.endSec &&
		range.endSec > range.startSec;
	const validRect = (
		rect: CompositionMotionState["crop"],
		allowEmpty: boolean,
	) =>
		[rect.x, rect.y, rect.width, rect.height].every(
			(value) => Number.isFinite(value) && Number.isInteger(value),
		) &&
		rect.x >= 0 &&
		rect.y >= 0 &&
		rect.width >= (allowEmpty ? 0 : 2) &&
		rect.height >= (allowEmpty ? 0 : 2) &&
		rect.x + rect.width <= canvas.width &&
		rect.y + rect.height <= canvas.height;
	const validState = (state: CompositionMotionState) =>
		Number.isFinite(state.opacity) &&
		state.opacity >= 0 &&
		state.opacity <= 1 &&
		Number.isFinite(state.transform.translateX) &&
		Number.isFinite(state.transform.translateY) &&
		Number.isFinite(state.transform.scale) &&
		state.transform.scale > 0 &&
		validRect(state.crop, false) &&
		validRect(state.clip, true);
	const windows = [motion.entrance, motion.exit].filter(
		(window): window is NonNullable<typeof window> => window !== null,
	);
	if (
		motion.activeRange.startSec < 0 ||
		motion.activeRange.endSec <= motion.activeRange.startSec ||
		!validState(motion.restingState) ||
		windows.some(
			(window) =>
				!validRange(window.range) ||
				!validState(window.from) ||
				!validState(window.to),
		) ||
		(motion.entrance &&
			motion.exit &&
			motion.entrance.range.endSec > motion.exit.range.startSec)
	) {
		throw new Error("invalid_composition_motion_plan");
	}
}

function motionValueExpression(input: {
	motion: CompositionMotionPlan;
	timeOffsetSec: number;
	resting: number;
	read: (state: CompositionMotionState) => number;
}): string {
	const interpolate = (
		from: number,
		to: number,
		startSec: number,
		endSec: number,
	) => {
		const start = startSec - input.timeOffsetSec;
		const end = endSec - input.timeOffsetSec;
		const duration = Math.max(0.001, end - start);
		return `${from.toFixed(6)}+${(to - from).toFixed(6)}*clip((t-${start.toFixed(6)})/${duration.toFixed(6)},0,1)`;
	};
	let expression = input.resting.toFixed(6);
	if (input.motion.entrance) {
		const window = input.motion.entrance;
		expression = `if(lt(t,${(window.range.endSec - input.timeOffsetSec).toFixed(6)}),${interpolate(input.read(window.from), input.read(window.to), window.range.startSec, window.range.endSec)},${expression})`;
	}
	if (input.motion.exit) {
		const window = input.motion.exit;
		expression = `if(gte(t,${(window.range.startSec - input.timeOffsetSec).toFixed(6)}),${interpolate(input.read(window.from), input.read(window.to), window.range.startSec, window.range.endSec)},${expression})`;
	}
	return expression;
}

function compositionMotionFilters(input: {
	motion: CompositionMotionPlan | null;
	width: number;
	height: number;
	backgroundColor: string;
	timeOffsetSec?: number;
	alpha?: boolean;
}) {
	if (!input.motion) return "";
	assertCompositionMotion(input.motion, {
		width: input.width,
		height: input.height,
	});
	const offset = input.timeOffsetSec ?? 0;
	const states = [
		input.motion.restingState,
		input.motion.entrance?.from,
		input.motion.entrance?.to,
		input.motion.exit?.from,
		input.motion.exit?.to,
	].filter((state): state is CompositionMotionState => state !== undefined);
	const expr = (
		resting: number,
		read: (state: CompositionMotionState) => number,
	) =>
		motionValueExpression({
			motion: input.motion!,
			timeOffsetSec: offset,
			resting,
			read,
		});
	const filters: string[] = [];
	const alpha = input.alpha ? ":alpha=1" : "";
	const backgroundColor = input.backgroundColor.startsWith("#")
		? `0x${input.backgroundColor.slice(1)}`
		: input.backgroundColor;
	for (const window of [input.motion.entrance, input.motion.exit]) {
		if (!window || window.from.opacity === window.to.opacity) continue;
		const type = window.from.opacity < window.to.opacity ? "in" : "out";
		filters.push(
			`fade=t=${type}:st=${(window.range.startSec - offset).toFixed(3)}:d=${(window.range.endSec - window.range.startSec).toFixed(3)}${alpha}`,
		);
	}
	const cropChanged = states.some(
		(state) =>
			JSON.stringify(state.crop) !==
			JSON.stringify(input.motion!.restingState.crop),
	);
	if (cropChanged) {
		const crop = input.motion.restingState.crop;
		const cropWidth = expr(crop.width, (state) => state.crop.width);
		const cropHeight = expr(crop.height, (state) => state.crop.height);
		const cropX = expr(crop.x, (state) => state.crop.x);
		const cropY = expr(crop.y, (state) => state.crop.y);
		filters.push(
			`scale=w='max(2,round(iw*${input.width}/(${cropWidth})/2)*2)':h='max(2,round(ih*${input.height}/(${cropHeight})/2)*2)':eval=frame`,
			`crop=${input.width}:${input.height}:x='max(0,(${cropX})*${input.width}/(${cropWidth}))':y='max(0,(${cropY})*${input.height}/(${cropHeight}))'`,
		);
	}
	const transformChanged = states.some(
		(state) =>
			JSON.stringify(state.transform) !==
			JSON.stringify(input.motion!.restingState.transform),
	);
	if (transformChanged) {
		const transform = input.motion.restingState.transform;
		const scale = expr(transform.scale, (state) => state.transform.scale);
		const x = expr(transform.translateX, (state) => state.transform.translateX);
		const y = expr(transform.translateY, (state) => state.transform.translateY);
		const largeTranslation = states.some(
			(state) =>
				Math.abs(state.transform.translateX) >= input.width / 2 ||
				Math.abs(state.transform.translateY) >= input.height / 2,
		);
		if (largeTranslation) {
			filters.push(
				`pad=${input.width * 3}:${input.height * 3}:${input.width}:${input.height}:color=${input.alpha ? "black@0" : backgroundColor}`,
				`crop=${input.width}:${input.height}:x='${input.width}-(${x})':y='${input.height}-(${y})'`,
			);
		} else {
			filters.push(
				`scale=w='max(2,round(iw*(${scale})/2)*2)':h='max(2,round(ih*(${scale})/2)*2)':eval=frame`,
				`crop=w='min(iw,${input.width})':h='min(ih,${input.height})':x='max(0,(iw-${input.width})/2-(${x}))':y='max(0,(ih-${input.height})/2-(${y}))'`,
				`pad=${input.width}:${input.height}:(ow-iw)/2:(oh-ih)/2:color=${input.alpha ? "black@0" : backgroundColor}`,
			);
		}
	}
	const clipChanged = states.some(
		(state) =>
			JSON.stringify(state.clip) !==
			JSON.stringify(input.motion!.restingState.clip),
	);
	if (clipChanged) {
		const clip = input.motion.restingState.clip;
		const clipX = expr(clip.x, (state) => state.clip.x);
		const clipY = expr(clip.y, (state) => state.clip.y);
		const clipWidth = expr(clip.width, (state) => state.clip.width);
		const clipHeight = expr(clip.height, (state) => state.clip.height);
		const color = input.alpha ? "black@0" : backgroundColor;
		filters.push(
			`drawbox=x=0:y=0:w='max(0,${clipX})':h=${input.height}:color=${color}:t=fill`,
			`drawbox=x='min(${input.width},(${clipX})+(${clipWidth}))':y=0:w='max(0,${input.width}-((${clipX})+(${clipWidth})))':h=${input.height}:color=${color}:t=fill`,
			`drawbox=x=0:y=0:w=${input.width}:h='max(0,${clipY})':color=${color}:t=fill`,
			`drawbox=x=0:y='min(${input.height},(${clipY})+(${clipHeight}))':w=${input.width}:h='max(0,${input.height}-((${clipY})+(${clipHeight})))':color=${color}:t=fill`,
		);
	}
	return filters.length ? `,${filters.join(",")},setsar=1` : "";
}

function escapeDrawtextValue(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/:/g, "\\:")
		.replace(/'/g, "\\'")
		.replace(/\[/g, "\\[")
		.replace(/\]/g, "\\]")
		.replace(/%/g, "\\%");
}

function escapeSubtitlePath(filePath: string): string {
	return filePath.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

function logoOverlayPosition(position: string, marginPx: number) {
	const [vertical, horizontal] = position.split("-");
	const x =
		horizontal === "left"
			? `${marginPx}`
			: horizontal === "right"
				? `W-w-${marginPx}`
				: "(W-w)/2";
	const y =
		vertical === "top"
			? `${marginPx}`
			: vertical === "bot"
				? `H-h-${marginPx}`
				: "(H-h)/2";
	return { x, y };
}

function textLayerFilter(
	layer: Extract<CompositionVisualLayer, { kind: "text" }>,
): string {
	const value = layer.value;
	const border =
		value.outlineWidth > 0
			? `:borderw=${value.outlineWidth}:bordercolor=0x${value.outlineColor.slice(1)}`
			: "";
	const box = value.backgroundColor
		? `:box=1:boxcolor=0x${value.backgroundColor.slice(1)}@${value.backgroundOpacity.toFixed(3)}:boxborderw=10`
		: "";
	return (
		`drawtext=font='${escapeDrawtextValue(value.fontName)}'` +
		`:text='${escapeDrawtextValue(value.text)}'` +
		`:fontsize=${Math.round(value.fontSize)}` +
		`:fontcolor=0x${value.color.slice(1)}` +
		`:x=w*${(layer.anchor.xPct / 100).toFixed(4)}-text_w/2` +
		`:y=h*${(layer.anchor.yPct / 100).toFixed(4)}-text_h/2` +
		`:enable='between(t\\,${layer.activeRange.startSec.toFixed(3)}\\,${layer.activeRange.endSec.toFixed(3)})'` +
		":shadowcolor=black@0.45:shadowx=0:shadowy=2" +
		border +
		box
	);
}

/** Translates the target's already-ordered visual schedule into FFmpeg syntax.
 * It does not inspect the editor document or select timing, precedence,
 * entitlement, geometry, or optional-media fallbacks. */
export function compileCompositionPlanVisualLayers(input: {
	plan: ClipCompositionPlan;
	targetId: string;
	inputLabel: string;
	outputLabel: string;
	subtitlePath?: string | null;
	logoInputIndex?: number | null;
}): {
	filterParts: string[];
	logoInput: { sourceRef: string; inputIndex: number } | null;
} {
	if (input.plan.version !== CLIP_COMPOSITION_PLAN_VERSION) {
		throw new Error("unsupported_clip_composition_plan_version");
	}
	const target = input.plan.targets.find(
		(candidate) => candidate.id === input.targetId,
	);
	if (!target) throw new Error("clip_composition_target_missing");

	let previousZIndex = -Infinity;
	for (const layer of target.visualLayers) {
		assertRect(
			layer.destination,
			target.canvas,
			"invalid_clip_composition_visual_destination",
		);
		if (
			layer.zIndex < previousZIndex ||
			layer.activeRange.startSec < 0 ||
			layer.activeRange.endSec <= layer.activeRange.startSec ||
			layer.activeRange.endSec >
				input.plan.editedDurationSec + SCENE_CONTINUITY_EPSILON_SEC
		) {
			throw new Error("invalid_clip_composition_visual_layers");
		}
		if (layer.kind === "transition") {
			assertCompositionMotion(layer.motion, target.canvas);
		}
		previousZIndex = layer.zIndex;
	}

	type Stage = (
		source: string,
		output: string,
		stageIndex: number,
	) => {
		parts: string[];
		logoInput?: { sourceRef: string; inputIndex: number };
	};
	const stages: Stage[] = [];
	let captionsAdded = false;
	for (const layer of target.visualLayers) {
		if (layer.kind === "text") {
			stages.push((source, output) => ({
				parts: [`${source}${textLayerFilter(layer)}${output}`],
			}));
		} else if (layer.kind === "caption" && !captionsAdded) {
			captionsAdded = true;
			stages.push((source, output) => {
				if (!input.subtitlePath) {
					throw new Error("clip_composition_caption_asset_missing");
				}
				const filter = input.subtitlePath.endsWith(".ass")
					? `ass='${escapeSubtitlePath(input.subtitlePath)}'`
					: `subtitles='${escapeSubtitlePath(input.subtitlePath)}'`;
				return { parts: [`${source}${filter}${output}`] };
			});
		} else if (layer.kind === "logo") {
			stages.push((source, output, stageIndex) => {
				if (input.logoInputIndex == null) {
					throw new Error("clip_composition_logo_input_missing");
				}
				const logoLabel = `[composition_logo_${stageIndex}]`;
				const position = logoOverlayPosition(layer.position, layer.marginPx);
				return {
					parts: [
						`[${input.logoInputIndex}:v]scale=${layer.widthPx}:-1,format=rgba,colorchannelmixer=aa=${layer.opacity.toFixed(3)}${logoLabel}`,
						`${source}${logoLabel}overlay=${position.x}:${position.y}${output}`,
					],
					logoInput: {
						sourceRef: layer.sourceRef,
						inputIndex: input.logoInputIndex,
					},
				};
			});
		} else if (layer.kind === "transition") {
			stages.push((source, output) => {
				if (layer.application === "overlay") {
					const fadeIn = layer.motion.entrance;
					const fadeOut = layer.motion.exit;
					if (!fadeIn || !fadeOut) {
						throw new Error("invalid_composition_motion_plan");
					}
					return {
						parts: [
							`${source}fade=t=in:st=${fadeIn.range.startSec.toFixed(3)}:d=${(fadeIn.range.endSec - fadeIn.range.startSec).toFixed(3)}:color=${layer.color},` +
								`fade=t=out:st=${fadeOut.range.startSec.toFixed(3)}:d=${(fadeOut.range.endSec - fadeOut.range.startSec).toFixed(3)}:color=${layer.color}${output}`,
						],
					};
				}
				const motion = compositionMotionFilters({
					motion: layer.motion,
					width: target.canvas.width,
					height: target.canvas.height,
					backgroundColor: layer.color,
				});
				const motionChain = motion.startsWith(",") ? motion.slice(1) : motion;
				return {
					parts: [`${source}${motionChain || "null"}${output}`],
				};
			});
		} else if (layer.kind === "output-treatment") {
			if (layer.resolution === "1080p" && !layer.watermark.enabled) continue;
			stages.push((source, output) => {
				const filters = [
					layer.resolution === "720p"
						? "scale=trunc(iw*2/3/2)*2:trunc(ih*2/3/2)*2"
						: "",
					layer.watermark.enabled
						? `drawtext=text=${escapeDrawtextValue(layer.watermark.text)}` +
							`:font='${escapeDrawtextValue(`${layer.watermark.fontFamily} Bold`)}'` +
							`:fontcolor=0x${layer.watermark.color.slice(1)}@${layer.watermark.opacity.toFixed(2)}` +
							`:borderw=${layer.watermark.outline.widthPx}` +
							`:bordercolor=0x${layer.watermark.outline.color.slice(1)}@${layer.watermark.outline.opacity.toFixed(2)}` +
							`:fontsize=${layer.watermark.fontSizePx}` +
							`:x=w-tw-${layer.watermark.marginPx.x}:y=${layer.watermark.marginPx.y}`
						: "",
				].filter(Boolean);
				return { parts: [`${source}${filters.join(",")}${output}`] };
			});
		}
	}

	if (stages.length === 0) {
		return {
			filterParts:
				input.inputLabel === input.outputLabel
					? []
					: [`${input.inputLabel}null${input.outputLabel}`],
			logoInput: null,
		};
	}
	const filterParts: string[] = [];
	let source = input.inputLabel;
	let logoInput: { sourceRef: string; inputIndex: number } | null = null;
	stages.forEach((stage, index) => {
		const output =
			index === stages.length - 1
				? input.outputLabel
				: `[composition_visual_${index}]`;
		const compiled = stage(source, output, index);
		filterParts.push(...compiled.parts);
		if (compiled.logoInput) logoInput = compiled.logoInput;
		source = output;
	});
	return { filterParts, logoInput };
}

function baseOnlyTarget(target: CompositionTargetPlan): CompositionTargetPlan {
	const hasInsertions = target.scenes.some((scene) =>
		scene.layers.some((layer) => layer.kind === "inserted-scene"),
	);
	const scenes = target.scenes
		.filter(
			(scene) => !scene.layers.some((layer) => layer.kind === "inserted-scene"),
		)
		.map((scene) => ({
			...scene,
			layers: scene.layers.filter(
				(layer) => layer.kind === "source-video" || layer.kind === "background",
			),
		}));
	// Final-time source fragments retain their own geometry and sourceRange.
	// Coalescing across an insertion would consume different source frames.
	if (hasInsertions) return { ...target, scenes };
	const coalesced = scenes.reduce<typeof scenes>((result, scene) => {
		const previous = result[result.length - 1];
		if (
			previous &&
			Math.abs(previous.endSec - scene.startSec) <=
				SCENE_CONTINUITY_EPSILON_SEC &&
			JSON.stringify(previous.layers) === JSON.stringify(scene.layers)
		) {
			result[result.length - 1] = { ...previous, endSec: scene.endSec };
		} else {
			result.push(scene);
		}
		return result;
	}, []);
	return { ...target, scenes: coalesced };
}

function plannedCompositionBrollPlacements(
	plan: ClipCompositionPlan,
	targetId: string,
): Array<{
	id: string;
	sourceRef: string;
	startSec: number;
	endSec: number;
	audio: "source";
	kind: "image" | "video";
	motion: CompositionMotionPlan | null;
	visibleRanges: Array<{ startSec: number; endSec: number }>;
}> {
	if (plan.version !== CLIP_COMPOSITION_PLAN_VERSION) {
		throw new Error("unsupported_clip_composition_plan_version");
	}
	const target = plan.targets.find((candidate) => candidate.id === targetId);
	if (!target) throw new Error("clip_composition_target_missing");

	const fragments = new Map<
		string,
		{
			layer: CompositionBrollVideoLayer | CompositionBrollImageLayer;
			ranges: Array<[number, number]>;
		}
	>();
	for (const scene of target.scenes) {
		const active = scene.layers.filter(
			(
				layer,
			): layer is CompositionBrollVideoLayer | CompositionBrollImageLayer =>
				layer.kind === "broll-video" || layer.kind === "broll-image",
		);
		if (active.length > 1) {
			throw new Error("invalid_clip_composition_broll_overlap");
		}
		for (const layer of active) {
			assertRect(
				layer.destination,
				target.canvas,
				"invalid_clip_composition_destination",
			);
			if (
				layer.sourceRef.length === 0 ||
				layer.fit !== "cover" ||
				(layer.kind === "broll-video" && layer.audio !== "source") ||
				layer.destination.x !== 0 ||
				layer.destination.y !== 0 ||
				layer.destination.width !== target.canvas.width ||
				layer.destination.height !== target.canvas.height ||
				layer.activeRange.startSec < 0 ||
				layer.activeRange.endSec <= layer.activeRange.startSec ||
				scene.startSec < layer.activeRange.startSec ||
				scene.endSec > layer.activeRange.endSec
			) {
				throw new Error("invalid_clip_composition_broll_layer");
			}
			const existing = fragments.get(layer.id);
			if (existing) {
				if (
					existing.layer.sourceRef !== layer.sourceRef ||
					existing.layer.kind !== layer.kind ||
					existing.layer.activeRange.startSec !== layer.activeRange.startSec ||
					existing.layer.activeRange.endSec !== layer.activeRange.endSec
				) {
					throw new Error("invalid_clip_composition_broll_layer");
				}
				existing.ranges.push([scene.startSec, scene.endSec]);
			} else {
				fragments.set(layer.id, {
					layer,
					ranges: [[scene.startSec, scene.endSec]],
				});
			}
		}
	}

	return [...fragments.values()]
		.map(({ layer, ranges }) => {
			const ordered = ranges.sort((left, right) => left[0] - right[0]);
			let cursor = layer.activeRange.startSec;
			const visibleRanges: Array<{ startSec: number; endSec: number }> = [];
			for (const [startSec, endSec] of ordered) {
				if (startSec < cursor - SCENE_CONTINUITY_EPSILON_SEC) {
					throw new Error("invalid_clip_composition_broll_layer");
				}
				if (startSec > cursor + SCENE_CONTINUITY_EPSILON_SEC) {
					// B-roll may be hidden by inserted Scenes. Any other missing
					// fragment contradicts the plan's advertised active range.
					for (const scene of target.scenes) {
						if (scene.endSec <= cursor || scene.startSec >= startSec) continue;
						if (
							Math.abs(scene.startSec - cursor) >
								SCENE_CONTINUITY_EPSILON_SEC ||
							!scene.layers.some(
								(candidate) => candidate.kind === "inserted-scene",
							)
						) {
							throw new Error("invalid_clip_composition_broll_layer");
						}
						cursor = scene.endSec;
					}
					if (Math.abs(startSec - cursor) > SCENE_CONTINUITY_EPSILON_SEC)
						throw new Error("invalid_clip_composition_broll_layer");
				}
				const previous = visibleRanges.at(-1);
				if (
					previous &&
					Math.abs(previous.endSec - startSec) <= SCENE_CONTINUITY_EPSILON_SEC
				)
					previous.endSec = endSec;
				else visibleRanges.push({ startSec, endSec });
				cursor = endSec;
			}
			if (
				Math.abs(cursor - layer.activeRange.endSec) >
				SCENE_CONTINUITY_EPSILON_SEC
			) {
				throw new Error("invalid_clip_composition_broll_layer");
			}
			return {
				id: layer.id,
				sourceRef: layer.sourceRef,
				startSec: layer.activeRange.startSec,
				endSec: layer.activeRange.endSec,
				audio: "source" as const,
				kind:
					layer.kind === "broll-image"
						? ("image" as const)
						: ("video" as const),
				motion: layer.motion,
				visibleRanges,
			};
		})
		.sort((left, right) => left.startSec - right.startSec);
}

function assertRect(
	rect: CompositionRect,
	bounds: { width: number; height: number } | null,
	code: string,
): void {
	if (
		![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
		![rect.x, rect.y, rect.width, rect.height].every(Number.isInteger) ||
		rect.x < 0 ||
		rect.y < 0 ||
		rect.width <= 0 ||
		rect.height <= 0 ||
		(bounds !== null &&
			(rect.x + rect.width > bounds.width ||
				rect.y + rect.height > bounds.height))
	) {
		throw new Error(code);
	}
}

function cropCoordinateExpression(
	crop: { x: number; y: number },
	track: readonly { timeSec: number; x: number; y: number }[] | undefined,
	sceneStartSec: number,
	axis: "x" | "y",
): string {
	if (!track?.length) return String(Math.round(crop[axis]));
	const points = track.map((keyframe) => ({
		timeSec: keyframe.timeSec - sceneStartSec,
		value: Math.round(keyframe[axis]),
	}));
	let expression = String(points[points.length - 1]!.value);
	for (let index = points.length - 2; index >= 0; index -= 1) {
		const left = points[index]!;
		const right = points[index + 1]!;
		const linear = `${left.value}+(${right.value}-${left.value})*(t-${left.timeSec.toFixed(3)})/${Math.max(0.001, right.timeSec - left.timeSec).toFixed(3)}`;
		expression = `if(lt(t,${right.timeSec.toFixed(3)}),${linear},${expression})`;
	}
	return expression;
}

function cropFilter(
	crop: { x: number; y: number; width: number; height: number },
	track: readonly { timeSec: number; x: number; y: number }[] | undefined,
	sceneStartSec: number,
): string {
	if (!track?.length) {
		return `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`;
	}
	return `crop=${crop.width}:${crop.height}:x='${cropCoordinateExpression(crop, track, sceneStartSec, "x")}':y='${cropCoordinateExpression(crop, track, sceneStartSec, "y")}'`;
}

function sourceLayerMaskSuffix(layer: CompositionSourceVideoLayer): string {
	if (!layer.mask) return "";
	const { width, height } = layer.destination;
	const rgbChannels = "r='r(X,Y)':g='g(X,Y)':b='b(X,Y)'";
	if (layer.mask.kind === "circle") {
		const alpha =
			"if(lte((X-W/2)*(X-W/2)+(Y-H/2)*(Y-H/2)," +
			"(min(W,H)/2)*(min(W,H)/2)),255,0)";
		return `,format=rgba,geq=${rgbChannels}:a='${alpha}'`;
	}
	const radius = layer.mask.radiusPx;
	if (
		!Number.isFinite(radius) ||
		radius <= 0 ||
		radius > Math.min(width, height) / 2
	) {
		throw new Error("invalid_clip_composition_source_mask");
	}
	const formattedRadius = radius.toFixed(3);
	const alpha =
		`if(lte(hypot(max(abs(X-W/2)-(W/2-${formattedRadius}),0),` +
		`max(abs(Y-H/2)-(H/2-${formattedRadius}),0)),${formattedRadius}),255,0)`;
	return `,format=rgba,geq=${rgbChannels}:a='${alpha}'`;
}

export function compileCompositionPlanInsertedSceneSequence(input: {
	plan: ClipCompositionPlan;
	targetId: string;
	baseVideoLabel: string;
	outputLabel: string;
	trailingChain?: string;
	fps?: number;
	resolvedSceneAssets?: Readonly<
		Record<string, { path: string; kind: "image" | "video" }>
	>;
	resolvedSceneFonts?: Readonly<Record<string, string>>;
	sceneInputStartIndex?: number;
}) {
	const target = input.plan.targets.find(
		(candidate) => candidate.id === input.targetId,
	);
	if (!target) throw new Error("clip_composition_target_missing");
	const sourceFragments = target.scenes.filter((scene) => scene.sourceRange);
	const sourceLabels = sourceFragments.map(
		(_, index) => `[composition_source_fragment_${index}]`,
	);
	const filterParts: string[] = [];
	if (sourceLabels.length > 1)
		filterParts.push(
			`${input.baseVideoLabel}split=${sourceLabels.length}${sourceLabels.join("")}`,
		);
	const compiledSourceScenes = new Map<string, string>();
	sourceFragments.forEach((scene, index) => {
		const source =
			sourceLabels.length === 1 ? input.baseVideoLabel : sourceLabels[index]!;
		const output = `[composition_audiogram_fragment_${index}]`;
		filterParts.push(
			`${source}trim=start=${scene.sourceRange!.startSec.toFixed(3)}:end=${scene.sourceRange!.endSec.toFixed(3)},setpts=PTS-STARTPTS,setsar=1${output}`,
		);
		compiledSourceScenes.set(scene.id, output);
	});
	const sequence = compileInsertedSceneSequence({
		...input,
		compiledSourceScenes,
	});
	return {
		...sequence,
		filterParts: [...filterParts, ...sequence.filterParts],
	};
}

function compileInsertedSceneSequence(input: {
	plan: ClipCompositionPlan;
	targetId: string;
	compiledSourceScenes: ReadonlyMap<string, string>;
	outputLabel: string;
	trailingChain?: string;
	fps?: number;
	resolvedSceneAssets?: Readonly<
		Record<string, { path: string; kind: "image" | "video" }>
	>;
	resolvedSceneFonts?: Readonly<Record<string, string>>;
	sceneInputStartIndex?: number;
}) {
	const target = input.plan.targets.find(
		(candidate) => candidate.id === input.targetId,
	);
	if (!target) throw new Error("clip_composition_target_missing");
	const insertedLayers = target.scenes.flatMap((scene) =>
		scene.layers.filter(
			(layer): layer is CompositionInsertedSceneLayer =>
				layer.kind === "inserted-scene",
		),
	);
	if (insertedLayers.length === 0) {
		throw new Error("clip_composition_inserted_scenes_missing");
	}
	const uniqueLayers = [
		...new Map(
			insertedLayers
				.filter((layer) => layer.sourceRef !== null)
				.map((layer) => [layer.sourceRef!, layer]),
		).values(),
	];
	if (uniqueLayers.length > 0 && input.sceneInputStartIndex == null) {
		throw new Error("clip_composition_scene_input_index_missing");
	}
	const sceneInputs = uniqueLayers.map((layer, index) => {
		const asset = input.resolvedSceneAssets?.[layer.sourceRef!];
		if (!asset || asset.kind !== layer.content.kind) {
			throw new Error("clip_composition_scene_input_missing");
		}
		return {
			...asset,
			sourceRef: layer.sourceRef!,
			inputIndex: input.sceneInputStartIndex! + index,
		};
	});
	let cursor = 0;
	for (const scene of target.scenes) {
		if (
			Math.abs(scene.startSec - cursor) > SCENE_CONTINUITY_EPSILON_SEC ||
			scene.endSec <= scene.startSec
		) {
			throw new Error("invalid_clip_composition_scenes");
		}
		cursor = scene.endSec;
	}
	if (
		Math.abs(cursor - input.plan.editedDurationSec) >
		SCENE_CONTINUITY_EPSILON_SEC
	) {
		throw new Error("invalid_clip_composition_scenes");
	}

	if (input.compiledSourceScenes.size === 0)
		throw new Error("invalid_clip_composition_source_scenes");
	const parts: string[] = [];
	const outputs: string[] = [];
	const fps = input.fps && input.fps > 0 ? input.fps : 30;
	target.scenes.forEach((scene, sceneIndex) => {
		const output = `[composition_insert_sequence_${sceneIndex}]`;
		outputs.push(output);
		const duration = scene.endSec - scene.startSec;
		const inserted = scene.layers.find(
			(layer): layer is CompositionInsertedSceneLayer =>
				layer.kind === "inserted-scene",
		);
		if (!inserted) {
			const source = input.compiledSourceScenes.get(scene.id);
			if (!source) throw new Error("invalid_clip_composition_source_scenes");
			parts.push(`${source}null${output}`);
			return;
		}
		const color =
			inserted.content.kind === "color"
				? inserted.content.color
				: inserted.content.backgroundColor;
		const motionFilters = compositionMotionFilters({
			motion: inserted.motion,
			width: target.canvas.width,
			height: target.canvas.height,
			backgroundColor: color,
			timeOffsetSec: scene.startSec,
		});
		if (inserted.content.kind === "color") {
			if (inserted.textRender !== null) {
				throw new Error("invalid_clip_composition_scene_text");
			}
			parts.push(
				`color=c=0x${color.slice(1)}:s=${target.canvas.width}x${target.canvas.height}:r=${fps}:d=${duration.toFixed(3)},format=yuv420p${motionFilters}${output}`,
			);
			return;
		}
		if (inserted.content.kind === "text") {
			assertCompositionSceneTextRender(inserted.textRender, target.canvas);
			const textContent = inserted.content;
			const textRender = inserted.textRender;
			const fontSelector = textContent.fontAsset
				? (() => {
						const fontPath =
							input.resolvedSceneFonts?.[
								compositionAssetRef(
									"brand_font",
									`${textContent.fontAsset.id}:${textContent.fontAsset.fingerprint}`,
								)
							];
						if (!fontPath)
							throw new Error("clip_composition_scene_font_missing");
						return `fontfile='${escapeDrawtextValue(fontPath)}'`;
					})()
				: `font='${escapeDrawtextValue(textContent.fontFamily)}'`;
			const textBlockHeightPx =
				textRender.lines.length * textRender.lineHeightPx;
			const drawTextFilters = textRender.lines
				.map(
					(line, index) =>
						`drawtext=${fontSelector}:text=${escapeDrawtextText(line)}` +
						`:fontcolor=0x${textContent.color.slice(1)}` +
						`:fontsize=${textRender.fontSizePx}` +
						":x=(w-text_w)/2" +
						`:y=(h-${textBlockHeightPx})/2+${index * textRender.lineHeightPx}` +
						`+(${textRender.lineHeightPx}-text_h)/2`,
				)
				.join(",");
			parts.push(
				`color=c=0x${color.slice(1)}:s=${target.canvas.width}x${target.canvas.height}:r=${fps}:d=${duration.toFixed(3)},` +
					`${drawTextFilters},format=yuv420p${motionFilters}${output}`,
			);
			return;
		}
		if (inserted.textRender !== null) {
			throw new Error("invalid_clip_composition_scene_text");
		}
		const asset = sceneInputs.find(
			(candidate) => candidate.sourceRef === inserted.sourceRef,
		);
		if (!asset) throw new Error("clip_composition_scene_input_missing");
		const fit =
			inserted.content.fit === "cover"
				? `scale=${target.canvas.width}:${target.canvas.height}:force_original_aspect_ratio=increase,crop=${target.canvas.width}:${target.canvas.height}`
				: `scale=${target.canvas.width}:${target.canvas.height}:force_original_aspect_ratio=decrease,pad=${target.canvas.width}:${target.canvas.height}:(ow-iw)/2:(oh-ih)/2:color=0x${inserted.content.backgroundColor.slice(1)}`;
		const trim =
			inserted.content.kind === "video"
				? `trim=start=${inserted.content.sourceStartSec.toFixed(3)}:end=${inserted.content.sourceEndSec.toFixed(3)},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${duration.toFixed(3)},trim=duration=${duration.toFixed(3)}`
				: `trim=duration=${duration.toFixed(3)},setpts=PTS-STARTPTS`;
		parts.push(
			`[${asset.inputIndex}:v]${trim},${fit},setsar=1,format=yuv420p${motionFilters}${output}`,
		);
	});
	const trailingSuffix = input.trailingChain ? `,${input.trailingChain}` : "";
	parts.push(
		`${outputs.join("")}concat=n=${outputs.length}:v=1:a=0,format=yuv420p${trailingSuffix}${input.outputLabel}`,
	);
	return { filterParts: parts, sceneInputs };
}

export function compileCompositionPlanVideo(input: {
	plan: ClipCompositionPlan;
	targetId: string;
	videoInputLabel: string;
	outputLabel: string;
	trailingChain?: string;
	backgroundImageInputIndex?: number | null;
	fps?: number;
	resolvedBrollAssets?: Readonly<Record<string, string>>;
	brollInputStartIndex?: number;
	resolvedSceneAssets?: Readonly<
		Record<string, { path: string; kind: "image" | "video" }>
	>;
	resolvedSceneFonts?: Readonly<Record<string, string>>;
	sceneInputStartIndex?: number;
}): {
	filterParts: string[];
	backgroundImageInputRequired: boolean;
	brollInputs: Array<{
		sourceRef: string;
		path: string;
		inputIndex: number;
		startSec: number;
		endSec: number;
		kind: "image" | "video";
		motion: CompositionMotionPlan | null;
	}>;
	sceneInputs: Array<{
		sourceRef: string;
		path: string;
		kind: "image" | "video";
		inputIndex: number;
	}>;
} {
	if (input.plan.version !== CLIP_COMPOSITION_PLAN_VERSION) {
		throw new Error("unsupported_clip_composition_plan_version");
	}
	const plannedTarget = input.plan.targets.find(
		(candidate) => candidate.id === input.targetId,
	);
	if (!plannedTarget) throw new Error("clip_composition_target_missing");
	const insertedLayers = plannedTarget.scenes.flatMap((scene) =>
		scene.layers.filter(
			(layer): layer is CompositionInsertedSceneLayer =>
				layer.kind === "inserted-scene",
		),
	);
	const uniqueSceneLayers = [
		...new Map(
			insertedLayers
				.filter((layer) => layer.sourceRef !== null)
				.map((layer) => [layer.sourceRef!, layer]),
		).values(),
	];
	if (uniqueSceneLayers.length > 0 && input.sceneInputStartIndex == null) {
		throw new Error("clip_composition_scene_input_index_missing");
	}
	const sceneInputs = uniqueSceneLayers.map((layer, index) => {
		const asset = input.resolvedSceneAssets?.[layer.sourceRef!];
		if (!asset || asset.kind !== layer.content.kind) {
			throw new Error("clip_composition_scene_input_missing");
		}
		return {
			...asset,
			sourceRef: layer.sourceRef!,
			inputIndex: input.sceneInputStartIndex! + index,
		};
	});

	if (insertedLayers.length > 0) {
		let cursor = 0;
		for (const scene of plannedTarget.scenes) {
			if (
				Math.abs(scene.startSec - cursor) > SCENE_CONTINUITY_EPSILON_SEC ||
				scene.endSec <= scene.startSec
			) {
				throw new Error("invalid_clip_composition_scenes");
			}
			cursor = scene.endSec;
		}
		if (
			Math.abs(cursor - input.plan.editedDurationSec) >
			SCENE_CONTINUITY_EPSILON_SEC
		) {
			throw new Error("invalid_clip_composition_scenes");
		}
	}
	const brollPlacements = plannedCompositionBrollPlacements(
		input.plan,
		input.targetId,
	);
	if (brollPlacements.length > 0 && input.brollInputStartIndex == null) {
		throw new Error("clip_composition_broll_input_index_missing");
	}
	const brollInputs = brollPlacements.map((placement, index) => {
		const path = input.resolvedBrollAssets?.[placement.sourceRef];
		if (!path) throw new Error("clip_composition_broll_input_missing");
		return {
			sourceRef: placement.sourceRef,
			path,
			inputIndex: input.brollInputStartIndex! + index,
			startSec: placement.startSec,
			endSec: placement.endSec,
			kind: placement.kind,
			motion: placement.motion,
		};
	});
	const baseOutputLabel =
		brollInputs.length > 0 ? "[composition_base]" : input.outputLabel;
	const trailingSuffix = input.trailingChain ? `,${input.trailingChain}` : "";
	const baseSuffix = brollInputs.length === 0 ? trailingSuffix : "";
	const finalize = (result: {
		filterParts: string[];
		backgroundImageInputRequired: boolean;
	}) => {
		if (brollInputs.length === 0) {
			return { ...result, brollInputs, sceneInputs };
		}
		let current = baseOutputLabel;
		brollInputs.forEach((asset, index) => {
			const layer = `[composition_broll_${index}]`;
			const next =
				index === brollInputs.length - 1
					? input.outputLabel
					: `[composition_broll_stage_${index}]`;
			const visible = brollPlacements[index]!.visibleRanges.map(
				(range) => `gte(t,${range.startSec})*lt(t,${range.endSec})`,
			).join("+");
			result.filterParts.push(
				`[${asset.inputIndex}:v]scale=${plannedTarget.canvas.width}:${plannedTarget.canvas.height}:` +
					`force_original_aspect_ratio=increase,crop=${plannedTarget.canvas.width}:` +
					`${plannedTarget.canvas.height},format=rgba` +
					compositionMotionFilters({
						motion: asset.motion,
						width: plannedTarget.canvas.width,
						height: plannedTarget.canvas.height,
						backgroundColor: "#000000",
						timeOffsetSec: asset.startSec,
						alpha: true,
					}) +
					`,setpts=PTS-STARTPTS+${asset.startSec}/TB${layer}`,
				`${current}${layer}overlay=0:0:enable='${visible}'` +
					`${index === brollInputs.length - 1 ? trailingSuffix : ""}${next}`,
			);
			current = next;
		});
		return { ...result, brollInputs, sceneInputs };
	};
	const target = baseOnlyTarget(plannedTarget);
	const hasInsertedScenes = insertedLayers.length > 0;
	const needsSceneCompiler =
		hasInsertedScenes ||
		target.effectiveMode === "auto" ||
		target.effectiveMode === "split" ||
		target.effectiveMode === "screen" ||
		target.scenes.length > 1 ||
		target.scenes.some((scene) => scene.layoutSelection != null);
	if (needsSceneCompiler) {
		if (target.scenes.length === 0) {
			throw new Error("invalid_clip_composition_scenes");
		}
		const parts: string[] = [];
		const sceneInputs = target.scenes.map((_, index) =>
			target.scenes.length === 1
				? input.videoInputLabel
				: `[composition_scene_${index}_src]`,
		);
		if (target.scenes.length > 1) {
			parts.push(
				`${input.videoInputLabel}split=${target.scenes.length}${sceneInputs.join("")}`,
			);
		}
		const imageBackgroundSceneIndexes = target.scenes.flatMap((scene, index) =>
			scene.layers.some(
				(layer) => layer.kind === "background" && layer.imageRef !== null,
			)
				? [index]
				: [],
		);
		if (
			imageBackgroundSceneIndexes.length > 0 &&
			input.backgroundImageInputIndex == null
		) {
			throw new Error("clip_composition_background_input_missing");
		}
		const imageBackgroundInputs = new Map<number, string>();
		if (imageBackgroundSceneIndexes.length === 1) {
			imageBackgroundInputs.set(
				imageBackgroundSceneIndexes[0]!,
				`[${input.backgroundImageInputIndex}:v]`,
			);
		} else if (imageBackgroundSceneIndexes.length > 1) {
			const labels = imageBackgroundSceneIndexes.map(
				(sceneIndex) => `[composition_scene_${sceneIndex}_background_src]`,
			);
			parts.push(
				`[${input.backgroundImageInputIndex}:v]split=${labels.length}${labels.join("")}`,
			);
			imageBackgroundSceneIndexes.forEach((sceneIndex, index) => {
				imageBackgroundInputs.set(sceneIndex, labels[index]!);
			});
		}
		let cursor = 0;
		let sourceCursor = 0;
		const sceneOutputs: string[] = [];
		target.scenes.forEach((scene, sceneIndex) => {
			if (
				!hasInsertedScenes &&
				(Math.abs(scene.startSec - cursor) > SCENE_CONTINUITY_EPSILON_SEC ||
					scene.endSec <= scene.startSec ||
					(sceneIndex === target.scenes.length - 1 &&
						Math.abs(scene.endSec - input.plan.editedDurationSec) >
							SCENE_CONTINUITY_EPSILON_SEC))
			) {
				throw new Error("invalid_clip_composition_scenes");
			}
			cursor = scene.endSec;
			const sourceRange = hasInsertedScenes ? scene.sourceRange : scene;
			if (
				!sourceRange ||
				!Number.isFinite(sourceRange.startSec) ||
				!Number.isFinite(sourceRange.endSec) ||
				sourceRange.startSec < 0 ||
				sourceRange.endSec <= sourceRange.startSec ||
				(hasInsertedScenes &&
					(Math.abs(sourceRange.startSec - sourceCursor) >
						SCENE_CONTINUITY_EPSILON_SEC ||
						Math.abs(
							sourceRange.endSec -
								sourceRange.startSec -
								(scene.endSec - scene.startSec),
						) > SCENE_CONTINUITY_EPSILON_SEC))
			) {
				throw new Error("invalid_clip_composition_source_scenes");
			}
			sourceCursor = sourceRange.endSec;
			const trimLabel = `[composition_scene_${sceneIndex}_trim]`;
			const sceneOutput = `[composition_scene_${sceneIndex}]`;
			sceneOutputs.push(sceneOutput);
			parts.push(
				`${sceneInputs[sceneIndex]}trim=start=${sourceRange.startSec.toFixed(3)}:` +
					`end=${sourceRange.endSec.toFixed(3)},setpts=PTS-STARTPTS${trimLabel}`,
			);
			const layers = [...scene.layers]
				.filter((layer) => layer.kind === "source-video")
				.sort((left, right) => left.zIndex - right.zIndex);
			const backgroundLayers = scene.layers.filter(
				(layer) => layer.kind === "background",
			);
			if (layers.length === 0 || layers.length > 4) {
				throw new Error("invalid_clip_composition_layers");
			}
			if (backgroundLayers.length > 1) {
				throw new Error("invalid_clip_composition_layers");
			}
			const backgroundLayer = backgroundLayers[0] ?? null;
			if (backgroundLayer) {
				assertRect(
					backgroundLayer.destination,
					target.canvas,
					"invalid_clip_composition_destination",
				);
				if (
					backgroundLayer.destination.x !== 0 ||
					backgroundLayer.destination.y !== 0 ||
					backgroundLayer.destination.width !== target.canvas.width ||
					backgroundLayer.destination.height !== target.canvas.height
				) {
					throw new Error("unsupported_clip_composition_destination");
				}
			}
			for (const layer of layers) {
				if (layer.sourceRef !== input.plan.source.ref) {
					throw new Error("invalid_clip_composition_source_ref");
				}
				assertRect(
					layer.sourceCrop,
					input.plan.source,
					"invalid_clip_composition_source_crop",
				);
				assertRect(
					layer.destination,
					target.canvas,
					"invalid_clip_composition_destination",
				);
				let previousTrackTime = -Infinity;
				if ((layer.sourceCropTrack?.length ?? 0) > 48) {
					throw new Error("invalid_clip_composition_source_crop_track");
				}
				for (const keyframe of layer.sourceCropTrack ?? []) {
					assertRect(keyframe, input.plan.source, "invalid_clip_composition_source_crop_track");
					if (
						!Number.isFinite(keyframe.timeSec) ||
						keyframe.timeSec <= previousTrackTime ||
						keyframe.timeSec < scene.startSec - 0.001 ||
						keyframe.timeSec > scene.endSec + 0.001 ||
						keyframe.width !== layer.sourceCrop.width ||
						keyframe.height !== layer.sourceCrop.height
					) throw new Error("invalid_clip_composition_source_crop_track");
					previousTrackTime = keyframe.timeSec;
				}
			}

			const isFullCanvasSingle =
				backgroundLayer === null &&
				layers.length === 1 &&
				layers[0]!.destination.x === 0 &&
				layers[0]!.destination.y === 0 &&
				layers[0]!.destination.width === target.canvas.width &&
				layers[0]!.destination.height === target.canvas.height &&
				!layers[0]!.mask &&
				Math.abs(layers[0]!.rotationDeg) < 0.01;
			if (isFullCanvasSingle) {
				const layer = layers[0]!;
				const crop = layer.sourceCrop;
				parts.push(
					`${trimLabel}${cropFilter(crop, layer.sourceCropTrack, scene.startSec)},` +
						`scale=${target.canvas.width}:${target.canvas.height},setsar=1,` +
						`format=yuv420p${sceneOutput}`,
				);
				return;
			}

			const isExactStack =
				backgroundLayer === null &&
				layers.length === 2 &&
				layers.every(
					(layer) =>
						layer.destination.x === 0 &&
						layer.destination.width === target.canvas.width &&
						!layer.mask &&
						Math.abs(layer.rotationDeg) < 0.01,
				) &&
				layers[0]!.destination.y === 0 &&
				layers[1]!.destination.y === layers[0]!.destination.height &&
				layers[0]!.destination.height + layers[1]!.destination.height ===
					target.canvas.height;
			if (isExactStack) {
				const sourceLabels = layers.map(
					(_, layerIndex) =>
						`[composition_scene_${sceneIndex}_layer_${layerIndex}_src]`,
				);
				const outputLabels = layers.map(
					(_, layerIndex) =>
						`[composition_scene_${sceneIndex}_layer_${layerIndex}]`,
				);
				parts.push(`${trimLabel}split=2${sourceLabels.join("")}`);
				layers.forEach((layer, layerIndex) => {
					const crop = layer.sourceCrop;
					const isFullSource =
						crop.x === 0 &&
						crop.y === 0 &&
						crop.width === input.plan.source.width &&
						crop.height === input.plan.source.height;
					const cropPrefix = isFullSource
						? ""
						: `${cropFilter(crop, layer.sourceCropTrack, scene.startSec)},`;
					const scale =
						layer.fit === "contain"
							? `scale=${layer.destination.width}:${layer.destination.height}:` +
								"force_original_aspect_ratio=decrease," +
								`pad=${layer.destination.width}:${layer.destination.height}:` +
								"(ow-iw)/2:(oh-ih)/2:color=black,setsar=1"
							: `scale=${layer.destination.width}:${layer.destination.height}`;
					parts.push(
						`${sourceLabels[layerIndex]}${cropPrefix}${scale}${outputLabels[layerIndex]}`,
					);
				});
				parts.push(
					`${outputLabels.join("")}vstack=inputs=2,setsar=1,format=yuv420p${sceneOutput}`,
				);
				return;
			}

			const baseSource = `[composition_scene_${sceneIndex}_base_src]`;
			const layerSources = layers.map(
				(_, layerIndex) =>
					`[composition_scene_${sceneIndex}_layer_${layerIndex}_src]`,
			);
			let composite = `[composition_scene_${sceneIndex}_base]`;
			if (backgroundLayer?.imageRef) {
				const backgroundInput = imageBackgroundInputs.get(sceneIndex);
				if (!backgroundInput) {
					throw new Error("clip_composition_background_input_missing");
				}
				if (layers.length === 1) {
					layerSources[0] = trimLabel;
				} else {
					parts.push(
						`${trimLabel}split=${layers.length}${layerSources.join("")}`,
					);
				}
				const fps = input.fps && input.fps > 0 ? input.fps : 30;
				const durationSec = scene.endSec - scene.startSec;
				parts.push(
					`${backgroundInput}loop=loop=-1:size=1:start=0,` +
						`trim=duration=${durationSec.toFixed(3)},` +
						`setpts=PTS-STARTPTS,scale=${target.canvas.width}:${target.canvas.height}:` +
						`force_original_aspect_ratio=increase,crop=${target.canvas.width}:` +
						`${target.canvas.height},fps=${fps}${composite}`,
				);
			} else {
				const backgroundColor = backgroundLayer?.color ?? "#000000";
				parts.push(
					`${trimLabel}split=${layers.length + 1}${baseSource}${layerSources.join("")}`,
					`${baseSource}scale=${target.canvas.width}:${target.canvas.height},` +
						`drawbox=x=0:y=0:w=iw:h=ih:color=${backgroundColor.replace("#", "0x")}:` +
						`t=fill${composite}`,
				);
			}
			layers.forEach((layer, layerIndex) => {
				const crop = layer.sourceCrop;
				const layerOutput = `[composition_scene_${sceneIndex}_layer_${layerIndex}]`;
				const rotated = Math.abs(layer.rotationDeg) >= 0.01;
				const mask = sourceLayerMaskSuffix(layer);
				const rotation = rotated
					? `,format=rgba,rotate=${layer.rotationDeg.toFixed(3)}*PI/180:` +
						"ow=rotw(iw):oh=roth(ih):c=black@0"
					: "";
				parts.push(
					`${layerSources[layerIndex]}${cropFilter(crop, layer.sourceCropTrack, scene.startSec)},` +
						`scale=${layer.destination.width}:${layer.destination.height}${mask}${rotation}${layerOutput}`,
				);
				const next =
					layerIndex === layers.length - 1
						? sceneOutput
						: `[composition_scene_${sceneIndex}_composite_${layerIndex}]`;
				const final =
					layerIndex === layers.length - 1 ? ",setsar=1,format=yuv420p" : "";
				const overlayX = rotated
					? `${layer.destination.x}+(${layer.destination.width}-overlay_w)/2`
					: String(layer.destination.x);
				const overlayY = rotated
					? `${layer.destination.y}+(${layer.destination.height}-overlay_h)/2`
					: String(layer.destination.y);
				parts.push(
					`${composite}${layerOutput}overlay=${overlayX}:${overlayY}:` +
						`shortest=1:format=auto${final}${next}`,
				);
				composite = next;
			});
		});

		if (hasInsertedScenes) {
			const sequence = compileInsertedSceneSequence({
				plan: input.plan,
				targetId: input.targetId,
				compiledSourceScenes: new Map(
					target.scenes.map((scene, index) => [scene.id, sceneOutputs[index]!]),
				),
				outputLabel: baseOutputLabel,
				trailingChain:
					brollInputs.length === 0 ? input.trailingChain : undefined,
				fps: input.fps,
				resolvedSceneAssets: input.resolvedSceneAssets,
				resolvedSceneFonts: input.resolvedSceneFonts,
				sceneInputStartIndex: input.sceneInputStartIndex,
			});
			parts.push(...sequence.filterParts);
		} else if (sceneOutputs.length === 1) {
			parts.push(
				`${sceneOutputs[0]}format=yuv420p${baseSuffix}${baseOutputLabel}`,
			);
		} else {
			parts.push(
				`${sceneOutputs.join("")}concat=n=${sceneOutputs.length}:v=1:a=0,` +
					`format=yuv420p${baseSuffix}${baseOutputLabel}`,
			);
		}
		return finalize({
			filterParts: parts,
			backgroundImageInputRequired: imageBackgroundSceneIndexes.length > 0,
		});
	}
	if (target.scenes.length !== 1) {
		throw new Error("unsupported_clip_composition_target");
	}
	const scene = target.scenes[0]!;
	const sourceLayer = scene.layers.find(
		(layer) => layer.kind === "source-video",
	);
	if (!sourceLayer) {
		throw new Error("invalid_clip_composition_layers");
	}
	if (sourceLayer.sourceRef !== input.plan.source.ref) {
		throw new Error("invalid_clip_composition_source_ref");
	}
	assertRect(
		sourceLayer.sourceCrop,
		input.plan.source,
		"invalid_clip_composition_source_crop",
	);
	assertRect(
		sourceLayer.destination,
		target.canvas,
		"invalid_clip_composition_destination",
	);
	const crop = sourceLayer.sourceCrop;
	if (target.effectiveMode === "fit") {
		const backgroundLayer = scene.layers.find(
			(layer) => layer.kind === "background",
		);
		if (!backgroundLayer || scene.layers.length !== 2) {
			throw new Error("invalid_clip_composition_layers");
		}
		assertRect(
			backgroundLayer.destination,
			target.canvas,
			"invalid_clip_composition_destination",
		);
		const sourceChain =
			`${input.videoInputLabel}crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},` +
			`scale=${sourceLayer.destination.width}:${sourceLayer.destination.height}`;
		if (backgroundLayer.imageRef) {
			if (input.backgroundImageInputIndex == null) {
				throw new Error("clip_composition_background_input_missing");
			}
			const fps = input.fps && input.fps > 0 ? input.fps : 30;
			return finalize({
				filterParts: [
					`[${input.backgroundImageInputIndex}:v]scale=${target.canvas.width}:${target.canvas.height}:` +
						`force_original_aspect_ratio=increase,crop=${target.canvas.width}:${target.canvas.height},` +
						`fps=${fps}[composition_bg]`,
					`${sourceChain}[composition_source]`,
					`[composition_bg][composition_source]overlay=${sourceLayer.destination.x}:` +
						`${sourceLayer.destination.y},format=yuv420p${baseSuffix}${baseOutputLabel}`,
				],
				backgroundImageInputRequired: true,
			});
		}
		return finalize({
			filterParts: [
				`${sourceChain},pad=${target.canvas.width}:${target.canvas.height}:` +
					`${sourceLayer.destination.x}:${sourceLayer.destination.y}:` +
					`color=${backgroundLayer.color.replace("#", "0x")},` +
					`format=yuv420p${baseSuffix}${baseOutputLabel}`,
			],
			backgroundImageInputRequired: false,
		});
	}
	if (target.effectiveMode !== "center" || scene.layers.length !== 1) {
		throw new Error("unsupported_clip_composition_target");
	}
	if (
		sourceLayer.destination.x !== 0 ||
		sourceLayer.destination.y !== 0 ||
		sourceLayer.destination.width !== target.canvas.width ||
		sourceLayer.destination.height !== target.canvas.height
	) {
		throw new Error("unsupported_clip_composition_destination");
	}
	if (
		crop.x !==
			Math.max(0, Math.round((input.plan.source.width - crop.width) / 2)) ||
		crop.y !==
			Math.max(0, Math.round((input.plan.source.height - crop.height) / 2))
	) {
		throw new Error("unsupported_clip_composition_center_crop");
	}
	return finalize({
		filterParts: [
			`${input.videoInputLabel}crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},` +
				`scale=${target.canvas.width}:${target.canvas.height},format=yuv420p${baseSuffix}${baseOutputLabel}`,
		],
		backgroundImageInputRequired: false,
	});
}

interface BackgroundPlan {
	mode: "color" | "image";
	color: string;
	imagePath: string | null;
}

interface LogoOverlay {
	filePath: string;
	ref: string;
	position: BrandTemplateSnapshot["logoPosition"];
	opacity: number;
	scalePct: number;
}

export interface ClipCompositionCommandInput {
	sourcePath: string;
	outputPath: string;
	startSec: number;
	endSec: number;
	source: WorkerMediaInspection;
	plan: ClipCompositionPlan;
	targetId: string;
	audio: BoundCompositionAudioRenderRequest;
	encoder: { preset: string; crf: string };
	cutPlan?: ClipCutPlan | null;
	assets: {
		subtitlePath: string | null;
		logo?: LogoOverlay | null;
		background?: BackgroundPlan | null;
		broll?: Readonly<Record<string, string>>;
		scenes?: Readonly<
			Record<
				string,
				{ path: string; kind: "image" | "video"; hasAudio: boolean }
			>
		>;
		fonts?: Readonly<Record<string, string>>;
	};
}

/** Compile one target from its authoritative plan and resolved render facts. */
export function compileClipCompositionCommand(
	input: ClipCompositionCommandInput,
): string[] {
	const target = input.plan.targets.find(
		(candidate) => candidate.id === input.targetId,
	);
	if (!target) throw new Error("clip_composition_target_missing");
	const params = {
		sourcePath: input.sourcePath,
		outputPath: input.outputPath,
		startSec: input.startSec,
		endSec: input.endSec,
		aspectRatio: target.aspectRatio,
		probe: input.source,
		composition: { plan: input.plan, targetId: input.targetId },
		audio: input.audio,
		encoder: input.encoder,
		cutPlan: input.cutPlan,
		subtitlePath: input.assets.subtitlePath,
		logo: input.assets.logo,
		background: input.assets.background,
		resolvedSceneAssets: input.assets.scenes,
		resolvedSceneFonts: input.assets.fonts,
	};
	if (!input.source.hasVideo)
		return buildAudiogramArgs({
			...params,
			clipDurationSec: input.plan.editedDurationSec,
		});
	if (input.assets.broll && Object.keys(input.assets.broll).length > 0)
		return buildBrollVideoArgs({
			...params,
			resolvedBrollAssets: input.assets.broll,
		});
	return buildSingleVideoArgs(params);
}

class CompositionCommandFailure extends WorkflowFailure {
	constructor(
		code: string,
		message: string,
		disposition: "retryable" | "permanent" = "retryable",
	) {
		super(code, disposition, message);
	}
}

type SourceProbe = WorkerMediaInspection;
const aspectRatioConfig = new Map(
	clipAspectRatioOptions.map((option) => [option.value, option]),
);
const HTTP_SOURCE_RECONNECT_HTTP_ERROR_CODES = "429,500,502,503,504";
function isHttpSource(input: string): boolean {
	return /^https?:\/\//i.test(input);
}

function httpSourceInputArgs(input: string): string[] {
	if (!isHttpSource(input)) return [];
	return [
		"-reconnect",
		"1",
		"-reconnect_streamed",
		"1",
		"-reconnect_on_network_error",
		"1",
		"-reconnect_on_http_error",
		HTTP_SOURCE_RECONNECT_HTTP_ERROR_CODES,
		"-reconnect_delay_max",
		"10",
		"-rw_timeout",
		String(HTTP_SOURCE_RW_TIMEOUT_US),
	];
}

function formatAssTimestamp(seconds: number): string {
	const totalCs = Math.max(0, Math.round(seconds * 100));
	const h = Math.floor(totalCs / 360_000);
	const m = Math.floor((totalCs % 360_000) / 6000);
	const s = Math.floor((totalCs % 6000) / 100);
	const cs = totalCs % 100;
	return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function hexToAssColor(hex: string, alphaHex = "00"): string {
	const r = hex.slice(1, 3);
	const g = hex.slice(3, 5);
	const b = hex.slice(5, 7);
	return `&H${alphaHex}${b}${g}${r}`;
}

/** ASS alpha is inverse of opacity: 0 alpha = fully opaque, FF = transparent. */
function assAlphaHex(opacity: number): string {
	const clamped = Math.max(0, Math.min(1, opacity));
	const alpha = Math.round((1 - clamped) * 255);
	return alpha.toString(16).toUpperCase().padStart(2, "0");
}

// Map preset font names to fonts actually bundled in the worker image. Impact
// is proprietary, so we substitute Anton (a metric-ish open display face).
const FONT_ALIASES: Record<string, string> = {
	Impact: "Anton",
};

function resolveFontName(name?: string | null): string {
	if (!name) return "Bebas Neue";
	const aliased = FONT_ALIASES[name] ?? name;
	// Strip characters that would break the ASS style / force_style filter
	// (commas, quotes, backslashes). Font names are letters/digits/space/hyphen.
	const safe = aliased.replace(/[^A-Za-z0-9 -]/g, "").trim();
	return safe.length > 0 ? safe : "Bebas Neue";
}

function serializeCaptionLayers(input: {
	layers: readonly CompositionCaptionVisualLayer[];
	canvas: { width: number; height: number };
}): string {
	const layer = input.layers[0];
	if (!layer) return "";
	const captionPreset = layer.preset;
	const fontName = resolveFontName(captionPreset.fontName);
	const fontSize =
		captionPreset.fontSize ?? Math.round(input.canvas.width * (72 / 1080));
	const primaryColor = hexToAssColor(captionPreset.primaryColor ?? "#FFFFFF");
	const highlightColor = hexToAssColor(
		captionPreset.highlightColor ?? "#00FF88",
	);
	const outlineColor = hexToAssColor(captionPreset.outlineColor ?? "#000000");
	const bold = captionPreset.bold !== false ? -1 : 0;
	const outlineWidth = captionPreset.outlineWidth ?? 2;
	const shadow = captionPreset.shadow ?? 1;
	const spacing = Math.round((captionPreset.letterSpacing ?? 0) * fontSize);
	let borderStyle = 1;
	let backColour = "&H00000000";
	if (captionPreset.backgroundColor) {
		borderStyle = 3;
		backColour = hexToAssColor(
			captionPreset.backgroundColor,
			assAlphaHex(captionPreset.backgroundOpacity ?? 0.6),
		);
	}
	let glowOverride = "";
	if (captionPreset.glowColor) {
		const intensity = captionPreset.glowIntensity ?? 8;
		glowOverride =
			`\\4c${hexToAssColor(captionPreset.glowColor)}&` +
			`\\shad${Math.max(1, Math.round(intensity / 4))}` +
			`\\blur${Math.max(1, Math.round(intensity / 2))}`;
	}
	const hasHighlightBox = Boolean(captionPreset.highlightBoxColor);
	const boxColor = hasHighlightBox
		? hexToAssColor(captionPreset.highlightBoxColor!)
		: "";
	const boxAlpha = assAlphaHex(captionPreset.highlightBoxOpacity ?? 1);
	const boxBord = Math.max(outlineWidth, Math.round(fontSize * 0.16));
	const animation = captionPreset.animation ?? "word-by-word";
	const header = [
		"[Script Info]",
		"ScriptType: v4.00+",
		`PlayResX: ${input.canvas.width}`,
		`PlayResY: ${input.canvas.height}`,
		"WrapStyle: 2",
		"ScaledBorderAndShadow: yes",
		"",
		"[V4+ Styles]",
		"Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
		`Style: Default,${fontName},${fontSize},${primaryColor},${primaryColor},${outlineColor},${backColour},${bold},0,0,0,100,100,${spacing},0,${borderStyle},${outlineWidth},${shadow},5,0,0,0,1`,
		"",
		"[Events]",
		"Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
	].join("\n");
	const renderWord = (word: string, active: boolean): string => {
		if (!active) return word;
		if (hasHighlightBox) {
			return (
				`{\\1c${highlightColor}&\\bord${boxBord}\\3c${boxColor}&\\3a&H${boxAlpha}&}` +
				`${word}` +
				`{\\1c${primaryColor}&\\bord${outlineWidth}\\3c${outlineColor}&\\3a&H00&}`
			);
		}
		return `{\\1c${highlightColor}&}${word}{\\1c${primaryColor}&}`;
	};
	const entrance = (): string => {
		let value = "\\fad(60,0)";
		if (
			animation === "grow" ||
			animation === "bounce" ||
			animation === "seamless-bounce" ||
			animation === "soft-landing"
		) {
			value += "\\fscx82\\fscy82\\t(0,160,\\fscx100\\fscy100)";
		} else if (animation === "blur-in" && !captionPreset.glowColor) {
			value += "\\blur6\\t(0,200,\\blur0)";
		}
		return value;
	};
	const events: string[] = [];
	for (const cue of input.layers) {
		const posXPx = Math.round((cue.anchor.xPct / 100) * input.canvas.width);
		const posYPx = Math.round((cue.anchor.yPct / 100) * input.canvas.height);
		cue.words.forEach((activeWord, activeIndex) => {
			const text = cue.words
				.map((word, index) => {
					const rendered = renderWord(word.text, index === activeIndex);
					return word.emoji ? `${rendered} ${word.emoji}` : rendered;
				})
				.join(" ");
			const override =
				`\\an5\\pos(${posXPx},${posYPx})${glowOverride}` +
				(activeIndex === 0 ? entrance() : "");
			events.push(
				`Dialogue: 0,${formatAssTimestamp(activeWord.startSec)},${formatAssTimestamp(activeWord.endSec)},Default,,0,0,0,,{${override}}${text}`,
			);
		});
	}
	return header + "\n" + events.join("\n") + "\n";
}

export function compileCompositionPlanCaptions(
	plan: ClipCompositionPlan,
	targetId: string,
): string {
	const target = plan.targets.find((candidate) => candidate.id === targetId);
	if (!target) throw new Error("clip_composition_target_missing");
	return serializeCaptionLayers({
		layers: target.visualLayers.filter(
			(layer): layer is CompositionCaptionVisualLayer =>
				layer.kind === "caption",
		),
		canvas: target.canvas,
	});
}
/** #RRGGBB -> 0xRRGGBB for the ffmpeg `color` / `showwaves` filters. */
function hexToFfmpegRgb(hex: string): string {
	return `0x${hex.replace("#", "").slice(0, 6)}`;
}

interface CutConcatResult {
	filterParts: string[];
	/** Label (with brackets, e.g. "[vcat]") every downstream video filter must
	 *  read from instead of the raw source input. */
	videoLabel: string | null;
	/** Label (with brackets) every downstream audio filter must read from
	 *  instead of the raw source input, or null when `includeAudio` was false. */
	audioLabel: string | null;
}

/**
 * Builds the cut/concat prefix of the filter graph for a clip's kept source
 * segments (vizard-parity.md Phase B step 7): each kept segment is trimmed
 * out of the SAME single source input (`-ss clipStartSec -t clipDurationSec
 * -i sourcePath`, unchanged from today) via `trim`/`atrim` + `setpts`/
 * `asetpts`, then concatenated into one continuous edited-timeline stream —
 * BEFORE crop/scale, captions, text layers, logo, transitions, music, gain,
 * or fades, so every one of those sees one continuous video/audio pair and
 * needs no cut-awareness of its own.
 *
 * Returns `null` when `cutPlan.isUncut` — callers MUST fall back to
 * referencing the raw input labels directly (`[0:v]` / `[0:a:0]`) in that
 * case, which is what keeps the single-segment path byte-identical to
 * pre-cut-concat renders (no filter-graph changes at all for the common
 * no-deletions case).
 *
 * `trim`/`atrim` operate on the SAME input-relative time base that every
 * other filter in this file already assumes for a `-ss X -i ...`-seeked
 * input (e.g. planned visual layers and B-roll `between(t,...)`
 * windows) — i.e. 0 at `clipStartSec`, not absolute source time — so segment
 * bounds are expressed as `segment.sourceStartSec/EndSec - clipStartSec`.
 */
function buildCutConcatFilter(params: {
	cutPlan: ClipCutPlan;
	clipStartSec: number;
	/** Default true — set false for the audio-only audiogram path, which has
	 *  no `[0:v]` stream to trim. */
	includeVideo?: boolean;
	includeAudio: boolean;
	videoInputRef?: string;
	audioInputRef?: string;
	videoOutLabel?: string;
	audioOutLabel?: string;
}): CutConcatResult | null {
	if (params.cutPlan.isUncut) return null;

	const includeVideo = params.includeVideo ?? true;
	const segments = params.cutPlan.segments;
	const videoInputRef = params.videoInputRef ?? "[0:v]";
	const audioInputRef = params.audioInputRef ?? "[0:a:0]";
	const videoOutLabel = params.videoOutLabel ?? "[vcat]";
	const audioOutLabel = params.audioOutLabel ?? "[acat]";

	const filterParts: string[] = [];
	const vLabels: string[] = [];
	const aLabels: string[] = [];

	segments.forEach((segment, index) => {
		const start = (segment.sourceStartSec - params.clipStartSec).toFixed(3);
		const end = (segment.sourceEndSec - params.clipStartSec).toFixed(3);

		if (includeVideo) {
			const vLabel = `vseg${index}`;
			filterParts.push(
				`${videoInputRef}trim=start=${start}:end=${end},setpts=PTS-STARTPTS[${vLabel}]`,
			);
			vLabels.push(`[${vLabel}]`);
		}

		if (params.includeAudio) {
			const aLabel = `aseg${index}`;
			filterParts.push(
				`${audioInputRef}atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[${aLabel}]`,
			);
			aLabels.push(`[${aLabel}]`);
		}
	});

	if (segments.length === 1) {
		// A single kept segment needs no `concat` — the trim/setpts stage above
		// already produced the final continuous stream (still a real cut when
		// the segment doesn't span the whole clip window, e.g. a deletion at the
		// very start/end — `concat` filter with n=1 would be a no-op anyway, but
		// skipping it keeps the graph simpler and matches ffmpeg's own guidance
		// against degenerate single-input concats).
		// `copy` (video) and `acopy` (audio) are distinct ffmpeg filters — using
		// the video-only `copy` on an audio pad label would fail at encode time.
		const rename = (label: string, out: string, filterName: "copy" | "acopy") =>
			filterParts.push(`${label}${filterName}${out}`);
		if (includeVideo) rename(vLabels[0]!, videoOutLabel, "copy");
		if (params.includeAudio) rename(aLabels[0]!, audioOutLabel, "acopy");
		return {
			filterParts,
			videoLabel: includeVideo ? videoOutLabel : null,
			audioLabel: params.includeAudio ? audioOutLabel : null,
		};
	}

	if (includeVideo && params.includeAudio) {
		const interleaved = segments
			.map((_, i) => `${vLabels[i]}${aLabels[i]}`)
			.join("");
		filterParts.push(
			`${interleaved}concat=n=${segments.length}:v=1:a=1${videoOutLabel}${audioOutLabel}`,
		);
		return {
			filterParts,
			videoLabel: videoOutLabel,
			audioLabel: audioOutLabel,
		};
	}

	if (includeVideo) {
		const interleaved = vLabels.join("");
		filterParts.push(
			`${interleaved}concat=n=${segments.length}:v=1:a=0${videoOutLabel}`,
		);
		return { filterParts, videoLabel: videoOutLabel, audioLabel: null };
	}

	// Audio-only (audiogram path): no video stream to concat at all.
	const interleaved = aLabels.join("");
	filterParts.push(
		`${interleaved}concat=n=${segments.length}:v=0:a=1${audioOutLabel}`,
	);
	return { filterParts, videoLabel: null, audioLabel: audioOutLabel };
}

function buildAudioFadeChain(
	fades: BoundCompositionAudioRenderRequest["outputFades"],
) {
	const fadeInDuration = fades.fadeIn.endSec - fades.fadeIn.startSec;
	const fadeOutDuration = fades.fadeOut.endSec - fades.fadeOut.startSec;
	const fadeInStart =
		fades.fadeIn.startSec === 0 ? "0" : fades.fadeIn.startSec.toFixed(3);
	return `afade=t=in:st=${fadeInStart}:d=${fadeInDuration.toFixed(3)},afade=t=out:st=${fades.fadeOut.startSec.toFixed(3)}:d=${fadeOutDuration.toFixed(3)}`;
}

/**
 * Builds a gain filter fragment for the source/dialogue track from
 * `studioEdits.sourceAudio`, or `null` when it's a no-op (unity gain, not
 * muted) — callers must skip appending it entirely in that case (the "unity
 * fast path") so untouched clips keep producing the exact same filter graph
 * they always have.
 */
function buildSourceGainFilter(
	audio: BoundCompositionAudioRenderRequest,
): string | null {
	const sourceAudio = audio.source;
	const censorWindows = audio.censors
		.map(
			(censor) =>
				`between(t,${censor.startSec.toFixed(6)},${censor.endSec.toFixed(6)})`,
		)
		.join("+");
	if (censorWindows) {
		const gain = sourceAudio.muted ? 0 : sourceAudio.gain;
		return `aeval=exprs='if(${censorWindows},0,val(ch)*${gain.toFixed(6)})':c=same`;
	}
	if (sourceAudio.muted) return "volume=0.000";
	if (sourceAudio.gain === 1) return null;
	return `volume=${sourceAudio.gain.toFixed(3)}`;
}

/**
 * The dialogue-only (no music) audio chain: optional source gain/mute, then
 * the fixed boundary click-guard fade. Used by every build*Args call site
 * that has source audio and no music track to mix in.
 */
function buildDialogueAudioFilter(
	audio: BoundCompositionAudioRenderRequest,
): string {
	const gainFilter = buildSourceGainFilter(audio);
	const fadeChain = buildAudioFadeChain(audio.outputFades);
	return gainFilter ? `${gainFilter},${fadeChain}` : fadeChain;
}

function buildCensorBeepAudioFilter(params: {
	censor: Extract<
		BoundCompositionAudioRenderRequest["censors"][number],
		{ treatment: "beep" }
	>;
	clipDurationSec: number;
	label: string;
}): string {
	const durationSec = params.censor.endSec - params.censor.startSec;
	const fadeOutStartSec = Math.max(0, durationSec - params.censor.fadeOutSec);
	const prefix = params.label.replace(/[[\]]/g, "");
	const toneLabel = `[${prefix}_tone]`;
	const delayedLabel = `[${prefix}_delayed]`;
	// FFmpeg's sine source emits at 1/8 peak amplitude. Compensate here so
	// levelDb means the same thing in export as it does in the Web Audio preview.
	const ffmpegSineSourcePeak = 1 / 8;
	const tone = [
		`sine=frequency=${params.censor.frequencyHz}:sample_rate=48000:duration=${durationSec.toFixed(6)}`,
		`volume=${(params.censor.gain / ffmpegSineSourcePeak).toFixed(6)}`,
		`afade=t=in:st=0:d=${params.censor.fadeInSec.toFixed(6)}`,
		`afade=t=out:st=${fadeOutStartSec.toFixed(6)}:d=${params.censor.fadeOutSec.toFixed(6)}`,
	].join(",");
	const delayed =
		params.censor.startSec > 0
			? `anullsrc=channel_layout=mono:sample_rate=48000:d=${params.censor.startSec.toFixed(6)}[${prefix}_silence];${tone}${toneLabel};[${prefix}_silence]${toneLabel}concat=n=2:v=0:a=1${delayedLabel}`
			: `${tone}${delayedLabel}`;
	return `${delayed};${delayedLabel}${[
		"apad",
		`atrim=duration=${Math.max(0.1, params.clipDurationSec).toFixed(3)}`,
		"asetpts=PTS-STARTPTS",
	].join(",")}${params.label}`;
}

/**
 * User-configured music fade in/out (`studioEdits.music.fadeInSec/fadeOutSec`,
 * 0-5s each), as an `afade` filter suffix applied to the music branch only —
 * additive to (not a replacement for) the fixed click-guard chain on the
 * final mixed track.
 *
 * Clamping/overlap resolution comes from the shared
 * `resolveMusicFadeWindows` policy (packages/validators/src/studio-edits.ts)
 * rather than clamping each fade independently here — this used to clamp
 * fadeIn and fadeOut to the clip duration separately, which let a long
 * fade-in + long fade-out on a short clip overlap (e.g. both landing at full
 * length, fading in and out over the SAME seconds) instead of scaling both
 * down proportionally so fade-in ends before fade-out begins. The studio
 * preview already uses the shared helper; this keeps the render in lockstep.
 */
function buildMusicUserFadeSuffix(
	music: NonNullable<BoundCompositionAudioRenderRequest["music"]>,
): string {
	const parts: string[] = [];
	const fadeInSec = music.fades.fadeIn.endSec - music.fades.fadeIn.startSec;
	const fadeOutSec = music.fades.fadeOut.endSec - music.fades.fadeOut.startSec;
	if (fadeInSec > 0) {
		const startSec =
			music.fades.fadeIn.startSec === 0
				? "0"
				: music.fades.fadeIn.startSec.toFixed(3);
		parts.push(`afade=t=in:st=${startSec}:d=${fadeInSec.toFixed(3)}`);
	}
	if (fadeOutSec > 0) {
		parts.push(
			`afade=t=out:st=${music.fades.fadeOut.startSec.toFixed(3)}:d=${fadeOutSec.toFixed(3)}`,
		);
	}
	return parts.length ? `,${parts.join(",")}` : "";
}

/**
 * One-shot SFX branch (vizard-parity.md "Music/SFX library" —
 * `studioSfxPlacementSchema`): `adelay` pads the branch with silence so
 * playback starts at `startSec` (EDITED-timeline seconds, same convention
 * the schema uses), then `atrim=duration=D` bounds it to the clip's own end
 * so a placement near the tail never rings past it. `all=1` delays every
 * channel by the same amount regardless of the source's channel count —
 * `adelay`'s default (`all=0`) requires one delay value per channel, so a
 * mono SFX file would only delay its first channel and leave the rest
 * unaffected. Never loops (one-shot, unlike music) — callers must not pass
 * `-stream_loop` on this input.
 *
 * `apad` runs BEFORE `atrim`, not after: `atrim=duration=D` is a MAX bound,
 * not a pad — a stream shorter than D (the common case: `adelay` + a
 * short one-shot SFX file, no infinite loop backing it the way music has)
 * simply ends early, and `atrim` does nothing to extend it. Without `apad`,
 * this branch's real output duration is `startSec` + the SFX file's own
 * length, which can be far shorter than the clip. Downstream, `amix
 * duration=first`/`-shortest` anchor on whichever branch is SHORTEST when
 * there's no dialogue branch to anchor on (e.g. a silent source, the SFX
 * branch alone) — an unpadded short SFX branch silently truncated the WHOLE
 * encode to its own length, dropping every later placement and however much
 * of the clip followed. `apad` pads the branch with silence indefinitely so
 * `atrim=duration=D` always has enough stream to cut down TO exactly D,
 * restoring the invariant `buildAudioMixFilter`'s own doc comment already
 * assumed every branch honored.
 */
function buildSfxAudioFilter(params: {
	sfxInputIndex: number;
	sfx: BoundCompositionAudioRenderRequest["soundEffects"][number];
	clipDurationSec: number;
	label: string;
}): string {
	const duration = Math.max(0.1, params.clipDurationSec);
	const delayMs = Math.max(
		0,
		Math.round(params.sfx.activeRange.startSec * 1000),
	);
	return `[${params.sfxInputIndex}:a]adelay=${delayMs}:all=1,volume=${params.sfx.gain.toFixed(3)},atrim=duration=${params.sfx.activeRange.endSec.toFixed(3)},apad,atrim=duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS${params.label}`;
}

/**
 * Ducking automation suffix for the music branch (vizard-parity.md
 * "Music/SFX library" — `studioMusicSchema.ducking`): a single-quoted
 * ffmpeg `volume=` expression, same quoting technique as
 * `enable='between(t,...)'` elsewhere in this file, so the commas inside
 * `buildDuckingVolumeExpression`'s `if(...)`/`between(...)` calls don't get
 * misread as filter-chain separators. Applied AFTER the music's base
 * `volume=` and user fade suffix, composing rather than replacing them.
 * `""` (no-op, byte-identical output) whenever `duckingWindows` is
 * absent/empty — the common case for every clip that isn't using ducking.
 */
function buildMusicDuckingSuffix(
	music: NonNullable<BoundCompositionAudioRenderRequest["music"]>,
): string {
	if (!music.ducking.enabled || music.ducking.windows.length === 0) return "";
	const expr = buildDuckingVolumeExpression([...music.ducking.windows], {
		duckedGainFraction: music.ducking.duckedGainFraction,
		attackSec: music.ducking.attackSec,
		releaseSec: music.ducking.releaseSec,
	});
	return expr ? `,volume='${expr}':eval=frame` : "";
}

/**
 * The single audio-mixing choke point for every render path that has music
 * and/or one-shot SFX active (see call sites in `buildSingleVideoArgs`,
 * `buildBrollVideoArgs`, `buildAudiogramArgs`) — generalizes what used to be
 * a fixed dialogue+music 2-input `amix` into dialogue (0 or 1 branch) +
 * music (0 or 1 branch) + SFX (0-20 branches), mixed in that order so
 * `duration=first` stays anchored on the dialogue branch whenever dialogue
 * is present. Every branch is built to be EXACTLY `clipDurationSec` long
 * before the mix, so `duration=first` is a formality (all branches already
 * share one duration) rather than a real anchor choice — dialogue and music
 * get there via a plain `atrim=duration=D` because they're backed by a
 * stream that's always at least D long (the source itself, or a
 * `-stream_loop -1`'d music file); one-shot SFX branches are NOT backed by
 * anything that long on their own (a short SFX file plus `adelay` can end
 * far short of D), so `buildSfxAudioFilter` pads with `apad` BEFORE its own
 * `atrim=duration=D` to actually guarantee this invariant instead of just
 * assuming it (see that function's doc comment for the truncation bug this
 * fixes).
 *
 * Byte-identical to the pre-SFX/pre-ducking dialogue+music filter whenever
 * `sfx` is empty and `music.duckingWindows` is unset — both new suffixes
 * collapse to `""` in that case, and a single dialogue+music branch pair
 * takes the same 2-input `amix` path as before.
 *
 * SFX placements whose `startSec` has drifted at/past `clipDurationSec`
 * (shouldn't happen — callers are expected to filter these out earlier so
 * the download/input never happens — kept here too as a defensive second
 * gate) are silently dropped rather than mixed in as an always-silent
 * branch.
 */
function buildAudioMixFilter(params: {
	audio: BoundCompositionAudioRenderRequest;
	resolvedSceneAssets?: Readonly<
		Record<string, { path: string; kind: "image" | "video"; hasAudio: boolean }>
	>;
	clipDurationSec: number;
	/** Label to read the dialogue/source audio from — defaults to `[0:a]`
	 *  (the raw source input). Cut-concat renders pass `[acat]` instead so the
	 *  dialogue mix reads the concatenated edited-timeline audio, same as
	 *  every other downstream audio consumer (vizard-parity Phase B step 7). */
	dialogueInputRef?: string;
	musicInputIndex: number | null;
	sfxInputIndexes: readonly number[];
}): string {
	const duration = Math.max(0.1, params.clipDurationSec);
	const fadeChain = buildAudioFadeChain(params.audio.outputFades);
	const dialogueInputRef = params.dialogueInputRef ?? "[0:a]";
	const sfxEntries = params.audio.soundEffects
		.map((plan, index) => ({
			plan,
			inputIndex: params.sfxInputIndexes[index]!,
		}))
		.filter((entry) => entry.plan.activeRange.startSec < duration);
	const beepEntries = params.audio.censors.filter(
		(censor): censor is Extract<typeof censor, { treatment: "beep" }> =>
			censor.treatment === "beep",
	);

	const branchFilters: string[] = [];
	const branchLabels: string[] = [];

	if (params.audio.source.available) {
		// normalize=0 below: amix's default normalization divides every input by
		// the input count (i.e. -6dB per input for a 2-input mix), quietly
		// ducking the dialogue whenever music/SFX is added. Each branch's own
		// level is already under explicit control (music `volume=`, SFX
		// `volume=`, dialogue gain), so every branch must mix at unity gain —
		// applied here on the dialogue branch (before amix) same as the
		// no-music path.
		const dialogueGainFilter = buildSourceGainFilter(params.audio);
		const label = "[maina]";
		branchFilters.push(
			dialogueGainFilter
				? `${dialogueInputRef}atrim=duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS,${dialogueGainFilter}${label}`
				: `${dialogueInputRef}atrim=duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS${label}`,
		);
		branchLabels.push(label);
	}

	beepEntries.forEach((censor, index) => {
		const label = `[censor${index}a]`;
		branchFilters.push(
			buildCensorBeepAudioFilter({
				censor,
				clipDurationSec: duration,
				label,
			}),
		);
		branchLabels.push(label);
	});

	if (params.audio.music && params.musicInputIndex != null) {
		const plan = params.audio.music;
		const label = "[musica]";
		const userFadeSuffix = buildMusicUserFadeSuffix(plan);
		const duckingSuffix = buildMusicDuckingSuffix(plan);
		// start=<offset> seeks into the (infinitely -stream_loop'd) music input
		// so the user's chosen point in the track plays first, instead of
		// always the first `duration` seconds of the file.
		branchFilters.push(
			`[${params.musicInputIndex}:a]atrim=start=${plan.startOffsetSec.toFixed(3)}:duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS,volume=${plan.gain.toFixed(3)}${userFadeSuffix}${duckingSuffix}${label}`,
		);
		branchLabels.push(label);
	}

	sfxEntries.forEach(({ inputIndex, plan }, index) => {
		const label = `[sfx${index}a]`;
		branchFilters.push(
			buildSfxAudioFilter({
				sfxInputIndex: inputIndex,
				sfx: plan,
				clipDurationSec: duration,
				label,
			}),
		);
		branchLabels.push(label);
	});

	if (branchLabels.length === 0) {
		// No dialogue, no music, no SFX. Callers only reach this function when
		// at least music or SFX is present (see the `hasMixedAudio` gate at
		// each call site), so this only fires when every SFX placement got
		// dropped by the defensive duration filter above AND there's no source
		// audio and no music — degrade to silence rather than emit an amix with
		// zero inputs.
		return `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${duration.toFixed(3)}[outa]`;
	}

	if (branchLabels.length === 1) {
		const limiter =
			beepEntries.length > 0 ? "alimiter=limit=0.950:level=disabled," : "";
		return `${branchFilters[0]};${branchLabels[0]}${limiter}${fadeChain}[outa]`;
	}

	const limiter =
		beepEntries.length > 0 ? ",alimiter=limit=0.950:level=disabled" : "";
	return [
		...branchFilters,
		`${branchLabels.join("")}amix=inputs=${branchLabels.length}:duration=first:dropout_transition=0:normalize=0${limiter},${fadeChain}[outa]`,
	].join(";");
}

function assertBoundAudioMatchesPlan(
	plan: ClipCompositionPlan,
	audio: BoundCompositionAudioRenderRequest | undefined,
): asserts audio is BoundCompositionAudioRenderRequest {
	const planned = compileCompositionPlanAudioSchedule(plan);
	if (!audio || audio.scheduleFingerprint !== planned.scheduleFingerprint) {
		throw new Error("clip_composition_audio_input_mismatch");
	}
}

function buildSingleVideoArgs(params: {
	encoder: { preset: string; crf: string };
	sourcePath: string;
	outputPath: string;
	startSec: number;
	endSec: number;
	aspectRatio: ClipAspectRatio;
	probe: SourceProbe;
	subtitlePath: string | null;
	logo?: LogoOverlay | null;
	/** The sole versioned composition policy for every video render. */
	composition: {
		plan: ClipCompositionPlan;
		targetId: string;
	};
	audio: BoundCompositionAudioRenderRequest;
	/** Resolved canvas background (vizard-parity Phase C item 2) — presence
	 *  implies "on" (mode is always "color" or "image"); omit/null preserves
	 *  today's crop-to-fill behavior. See `BackgroundPlan`. */
	background?: BackgroundPlan | null;
	/** Non-empty `deletedRanges` cut plan (vizard-parity Phase B step 7).
	 *  Omitted/uncut: byte-identical to the pre-cut-concat filter graph. */
	cutPlan?: ClipCutPlan | null;
	resolvedSceneAssets?: Readonly<
		Record<string, { path: string; kind: "image" | "video"; hasAudio: boolean }>
	>;
	resolvedSceneFonts?: Readonly<Record<string, string>>;
}) {
	assertBoundAudioMatchesPlan(params.composition.plan, params.audio);
	if (params.cutPlan?.isEmpty) {
		throw new CompositionCommandFailure(
			"clip_cut_plan_empty",
			"cutPlan has no renderable segments — caller must guard before building ffmpeg args",
			"permanent",
		);
	}
	const isCut = Boolean(params.cutPlan && !params.cutPlan.isUncut);
	const clipDurationSec = params.composition.plan.editedDurationSec;

	const cutConcat = isCut
		? buildCutConcatFilter({
				cutPlan: params.cutPlan!,
				clipStartSec: params.startSec,
				includeAudio: params.probe.hasAudio,
			})
		: null;
	const videoInputLabel = cutConcat ? cutConcat.videoLabel! : "[0:v]";
	const audioInputLabel = cutConcat
		? cutConcat.audioLabel
		: params.probe.hasAudio
			? "[0:a:0]"
			: null;

	// Input index bookkeeping: source is always 0; background image (fit mode
	// only, when a local downloaded path is available), logo, music, then each
	// SFX placement each consume the next slot IF present — same order the
	// args are pushed in below. Byte-identical to before this feature when
	// `background`/`sfx` are absent/off (bgImageInputIndex stays null,
	// logoInputIndex/musicInputIndex fall back to the same 1/2 values the old
	// hardcoded literals used, sfxInputIndexes stays an empty array).
	const usesBackgroundImage = Boolean(
		params.background?.mode === "image" && params.background.imagePath,
	);
	const plannedTarget = params.composition.plan.targets.find(
		(target) => target.id === params.composition.targetId,
	);
	if (!plannedTarget) throw new Error("clip_composition_target_missing");
	const plannedLogo = plannedTarget.visualLayers.find(
		(layer) => layer.kind === "logo",
	);
	if (Boolean(plannedLogo) !== Boolean(params.logo)) {
		throw new Error("clip_composition_logo_asset_mismatch");
	}
	let nextInputIndex = 1;
	const bgImageInputIndex = usesBackgroundImage ? nextInputIndex++ : null;
	const sceneAssetRefs = [
		...new Set(
			plannedTarget.scenes.flatMap((scene) =>
				scene.layers.flatMap((layer) =>
					layer.kind === "inserted-scene" && layer.sourceRef
						? [layer.sourceRef]
						: [],
				),
			),
		),
	];
	const hasInsertedScenes = plannedTarget.scenes.some((scene) =>
		scene.layers.some((layer) => layer.kind === "inserted-scene"),
	);
	const sceneInputStartIndex =
		sceneAssetRefs.length > 0 ? nextInputIndex : null;
	nextInputIndex += sceneAssetRefs.length;
	const logoInputIndex = plannedLogo ? nextInputIndex++ : null;
	const musicInputIndex = params.audio.music ? nextInputIndex++ : null;
	const sfxInputIndexes = params.audio.soundEffects.map(() => nextInputIndex++);

	const filterParts: string[] = cutConcat ? [...cutConcat.filterParts] : [];

	const compiled = compileCompositionPlanVideo({
		plan: params.composition.plan,
		targetId: params.composition.targetId,
		videoInputLabel,
		outputLabel: "[composition_base]",
		backgroundImageInputIndex: bgImageInputIndex,
		fps: params.probe.fps,
		resolvedSceneAssets: params.resolvedSceneAssets,
		resolvedSceneFonts: params.resolvedSceneFonts,
		sceneInputStartIndex: sceneInputStartIndex ?? undefined,
	});
	filterParts.push(...compiled.filterParts);
	const sceneAudio = compileCompositionPlanSceneAudio({
		plan: params.composition.plan,
		targetId: params.composition.targetId,
		sourceAudioLabel: audioInputLabel,
		sceneInputs: sceneAssetRefs.map((sourceRef, index) => ({
			sourceRef,
			inputIndex: sceneInputStartIndex! + index,
			hasAudio: params.resolvedSceneAssets?.[sourceRef]?.hasAudio ?? false,
		})),
	});
	filterParts.push(...sceneAudio.filterParts);
	const sceneDialogueLabel = hasInsertedScenes ? sceneAudio.outputLabel : null;
	const visual = compileCompositionPlanVisualLayers({
		plan: params.composition.plan,
		targetId: params.composition.targetId,
		inputLabel: "[composition_base]",
		outputLabel: "[outv]",
		subtitlePath: params.subtitlePath,
		logoInputIndex,
	});
	filterParts.push(...visual.filterParts);
	if (
		visual.logoInput &&
		(!params.logo || visual.logoInput.sourceRef !== params.logo.ref)
	) {
		throw new Error("clip_composition_logo_asset_mismatch");
	}
	const finalLabel = "[outv]";

	const args = [
		"-y",
		...httpSourceInputArgs(params.sourcePath),
		"-ss",
		String(params.startSec),
		"-t",
		String(params.endSec - params.startSec),
		"-i",
		params.sourcePath,
	];

	if (bgImageInputIndex != null) {
		args.push("-i", params.background!.imagePath!);
	}

	for (const sourceRef of sceneAssetRefs) {
		const asset = params.resolvedSceneAssets?.[sourceRef];
		if (!asset) throw new Error("clip_composition_scene_input_missing");
		if (asset.kind === "image") args.push("-loop", "1");
		else args.push("-stream_loop", "-1");
		args.push("-i", asset.path);
	}

	if (plannedLogo && params.logo) {
		args.push("-i", params.logo.filePath);
	}

	if (params.audio.music) {
		args.push("-stream_loop", "-1", "-i", params.audio.music.path);
	}

	for (const sfx of params.audio.soundEffects) {
		// No -stream_loop: SFX is one-shot, never looped, unlike music above.
		args.push("-i", sfx.path);
	}

	const audioForRender = sceneDialogueLabel
		? { ...params.audio, source: { ...params.audio.source, available: true } }
		: params.audio;
	const hasMixedAudio =
		Boolean(params.audio.music) ||
		sfxInputIndexes.length > 0 ||
		params.audio.censors.some((censor) => censor.treatment === "beep");
	if (hasMixedAudio) {
		filterParts.push(
			buildAudioMixFilter({
				audio: audioForRender,
				clipDurationSec,
				dialogueInputRef:
					sceneDialogueLabel ?? (cutConcat ? cutConcat.audioLabel! : undefined),
				musicInputIndex,
				sfxInputIndexes,
			}),
		);
	} else if (sceneDialogueLabel || audioInputLabel) {
		filterParts.push(
			`${sceneDialogueLabel ?? audioInputLabel}${buildDialogueAudioFilter(audioForRender)}[outa]`,
		);
	}

	args.push(
		"-filter_complex",
		filterParts.join(";"),
		"-map",
		finalLabel,
		"-c:v",
		"libx264",
		"-preset",
		params.encoder.preset,
		"-crf",
		params.encoder.crf,
	);

	if (hasMixedAudio) {
		args.push("-map", "[outa]", "-c:a", "aac", "-b:a", "128k", "-shortest");
	} else if (sceneDialogueLabel || params.probe.hasAudio) {
		args.push("-map", "[outa]", "-c:a", "aac", "-b:a", "128k");
	} else {
		args.push("-an");
	}

	// Explicit output-duration bound: whatever the filter graph does upstream
	// (an over-long B-roll/music input, a framesync quirk, etc.), the encoded
	// output can never exceed the clip's own planned duration.
	args.push(
		"-t",
		clipDurationSec.toFixed(3),
		"-movflags",
		"+faststart",
		"-max_muxing_queue_size",
		"1024",
		params.outputPath,
	);

	return args;
}

/**
 * Builds FFmpeg args from a composition plan containing B-roll layers. Asset
 * paths are keyed by the plan's sourceRef; the adapter validates and compiles
 * every planned interval so callers cannot supply a parallel timing model.
 */
function buildBrollVideoArgs(params: {
	encoder: { preset: string; crf: string };
	sourcePath: string;
	resolvedBrollAssets: Readonly<Record<string, string>>;
	outputPath: string;
	startSec: number;
	endSec: number;
	aspectRatio: ClipAspectRatio;
	probe: SourceProbe;
	subtitlePath: string | null;
	logo?: LogoOverlay | null;
	composition: {
		plan: ClipCompositionPlan;
		targetId: string;
	};
	audio: BoundCompositionAudioRenderRequest;
	/** Resolved canvas background (vizard-parity Phase C item 2) — see
	 *  `buildSingleVideoArgs`'s param doc; same contract here. */
	background?: BackgroundPlan | null;
	/** See `buildSingleVideoArgs` — same cut-concat contract. */
	cutPlan?: ClipCutPlan | null;
	resolvedSceneAssets?: Readonly<
		Record<string, { path: string; kind: "image" | "video"; hasAudio: boolean }>
	>;
	resolvedSceneFonts?: Readonly<Record<string, string>>;
}) {
	assertBoundAudioMatchesPlan(params.composition.plan, params.audio);
	if (Object.keys(params.resolvedBrollAssets).length === 0) {
		throw new CompositionCommandFailure(
			"broll_cutaways_empty",
			"buildBrollVideoArgs requires at least one cutaway",
			"permanent",
		);
	}
	if (params.cutPlan?.isEmpty) {
		throw new CompositionCommandFailure(
			"clip_cut_plan_empty",
			"cutPlan has no renderable segments — caller must guard before building ffmpeg args",
			"permanent",
		);
	}

	const config = aspectRatioConfig.get(params.aspectRatio);
	if (!config) {
		throw new CompositionCommandFailure(
			"unsupported_aspect_ratio",
			`Unsupported aspect ratio: ${params.aspectRatio}`,
			"permanent",
		);
	}
	// Input index bookkeeping: source(0), background image (fit mode only,
	// when a local downloaded path is available), then the cutaways, then
	// logo, then music — same order the args are pushed in below. `bgOffset`
	// is 0 when background is absent/off, so every index below is
	// byte-identical to before this feature in that case.
	const usesBackgroundImage = Boolean(
		params.background?.mode === "image" && params.background.imagePath,
	);
	const bgImageInputIndex = usesBackgroundImage ? 1 : null;
	const bgOffset = usesBackgroundImage ? 1 : 0;
	const plannedTargetForScenes = params.composition.plan.targets.find(
		(target) => target.id === params.composition.targetId,
	);
	if (!plannedTargetForScenes)
		throw new Error("clip_composition_target_missing");
	const sceneAssetRefs = [
		...new Set(
			plannedTargetForScenes.scenes.flatMap((scene) =>
				scene.layers.flatMap((layer) =>
					layer.kind === "inserted-scene" && layer.sourceRef
						? [layer.sourceRef]
						: [],
				),
			),
		),
	];
	const hasInsertedScenes = plannedTargetForScenes.scenes.some((scene) =>
		scene.layers.some((layer) => layer.kind === "inserted-scene"),
	);
	const isCut = Boolean(params.cutPlan && !params.cutPlan.isUncut);
	const clipDurationSec = params.composition.plan.editedDurationSec;

	const cutConcat = isCut
		? buildCutConcatFilter({
				cutPlan: params.cutPlan!,
				clipStartSec: params.startSec,
				includeAudio: params.probe.hasAudio,
			})
		: null;
	const videoInputLabel = cutConcat ? cutConcat.videoLabel! : "[0:v]";
	const audioInputLabel = cutConcat
		? cutConcat.audioLabel
		: params.probe.hasAudio
			? "[0:a:0]"
			: null;

	const parts: string[] = cutConcat ? [...cutConcat.filterParts] : [];
	const compiledComposition = compileCompositionPlanVideo({
		plan: params.composition.plan,
		targetId: params.composition.targetId,
		videoInputLabel,
		outputLabel: "[stage0]",
		backgroundImageInputIndex: bgImageInputIndex,
		fps: params.probe.fps,
		resolvedBrollAssets: params.resolvedBrollAssets,
		brollInputStartIndex: 1 + bgOffset,
		resolvedSceneAssets: params.resolvedSceneAssets,
		resolvedSceneFonts: params.resolvedSceneFonts,
		sceneInputStartIndex:
			sceneAssetRefs.length > 0
				? 1 + bgOffset + Object.keys(params.resolvedBrollAssets).length
				: undefined,
	});
	const cutawayCount = compiledComposition.brollInputs.length;
	const plannedTarget = params.composition.plan.targets.find(
		(target) => target.id === params.composition.targetId,
	);
	if (!plannedTarget) throw new Error("clip_composition_target_missing");
	const plannedLogo = plannedTarget.visualLayers.find(
		(layer) => layer.kind === "logo",
	);
	if (Boolean(plannedLogo) !== Boolean(params.logo)) {
		throw new Error("clip_composition_logo_asset_mismatch");
	}
	const logoInputIndex = plannedLogo
		? 1 + bgOffset + cutawayCount + sceneAssetRefs.length
		: null;
	parts.push(...compiledComposition.filterParts);
	const sceneAudio = compileCompositionPlanSceneAudio({
		plan: params.composition.plan,
		targetId: params.composition.targetId,
		sourceAudioLabel: audioInputLabel,
		sceneInputs: sceneAssetRefs.map((sourceRef, index) => ({
			sourceRef,
			inputIndex: 1 + bgOffset + cutawayCount + index,
			hasAudio: params.resolvedSceneAssets?.[sourceRef]?.hasAudio ?? false,
		})),
	});
	parts.push(...sceneAudio.filterParts);
	const sceneDialogueLabel = hasInsertedScenes ? sceneAudio.outputLabel : null;
	const visual = compileCompositionPlanVisualLayers({
		plan: params.composition.plan,
		targetId: params.composition.targetId,
		inputLabel: "[stage0]",
		outputLabel: "[outv]",
		subtitlePath: params.subtitlePath,
		logoInputIndex,
	});
	parts.push(...visual.filterParts);
	if (
		visual.logoInput &&
		(!params.logo || visual.logoInput.sourceRef !== params.logo.ref)
	) {
		throw new Error("clip_composition_logo_asset_mismatch");
	}
	const finalLabel = "[outv]";

	const args = [
		"-y",
		...httpSourceInputArgs(params.sourcePath),
		"-ss",
		String(params.startSec),
		"-t",
		String(params.endSec - params.startSec),
		"-i",
		params.sourcePath,
	];

	if (bgImageInputIndex != null) {
		args.push("-i", params.background!.imagePath!);
	}

	for (const cutaway of compiledComposition.brollInputs) {
		// Each B-roll input gets its own `-t`, scoped to just this input (ffmpeg
		// resets per-input options at each `-i`), sized to exactly its own
		// cutaway window. Without this, `overlay` runs until the *longer* of its
		// two inputs finishes (shortest defaults to 0), so any B-roll asset
		// longer than its window silently stretched the whole rendered output
		// past its own planned end (frozen final frame, silent audio) — trimming
		// here means each B-roll stream can never outlast its own window.
		const windowDurationSec = Math.max(0.1, cutaway.endSec - cutaway.startSec);
		if (cutaway.kind === "image") args.push("-loop", "1");
		args.push("-t", windowDurationSec.toFixed(3), "-i", cutaway.path);
	}

	for (const sourceRef of sceneAssetRefs) {
		const asset = params.resolvedSceneAssets?.[sourceRef];
		if (!asset) throw new Error("clip_composition_scene_input_missing");
		if (asset.kind === "image") args.push("-loop", "1");
		else args.push("-stream_loop", "-1");
		args.push("-i", asset.path);
	}

	if (plannedLogo && params.logo) args.push("-i", params.logo.filePath);

	// Music, then SFX, each consume the next input slot — same order as
	// buildSingleVideoArgs. musicInputIndex is computed unconditionally
	// (even when music is absent) so sfxInputIndexes can be derived from it
	// without duplicating the bgOffset/cutawayCount/logo arithmetic.
	const musicInputIndex =
		1 + bgOffset + cutawayCount + sceneAssetRefs.length + (plannedLogo ? 1 : 0);
	const sfxInputIndexes = params.audio.soundEffects.map(
		(_, i) => musicInputIndex + (params.audio.music ? 1 : 0) + i,
	);

	if (params.audio.music) {
		args.push("-stream_loop", "-1", "-i", params.audio.music.path);
	}
	for (const sfx of params.audio.soundEffects) {
		args.push("-i", sfx.path);
	}

	const audioForRender = sceneDialogueLabel
		? { ...params.audio, source: { ...params.audio.source, available: true } }
		: params.audio;
	const hasMixedAudio =
		Boolean(params.audio.music) ||
		sfxInputIndexes.length > 0 ||
		params.audio.censors.some((censor) => censor.treatment === "beep");
	if (hasMixedAudio) {
		parts.push(
			buildAudioMixFilter({
				audio: audioForRender,
				clipDurationSec,
				dialogueInputRef:
					sceneDialogueLabel ?? (cutConcat ? cutConcat.audioLabel! : undefined),
				musicInputIndex: params.audio.music ? musicInputIndex : null,
				sfxInputIndexes,
			}),
		);
	} else if (sceneDialogueLabel || audioInputLabel) {
		parts.push(
			`${sceneDialogueLabel ?? audioInputLabel}${buildDialogueAudioFilter(audioForRender)}[outa]`,
		);
	}

	args.push("-filter_complex", parts.join(";"), "-map", finalLabel);

	if (hasMixedAudio) {
		args.push("-map", "[outa]", "-c:a", "aac", "-b:a", "128k", "-shortest");
	} else if (sceneDialogueLabel || params.probe.hasAudio) {
		args.push("-map", "[outa]", "-c:a", "aac", "-b:a", "128k");
	} else {
		args.push("-an");
	}

	// Belt-and-suspenders output-duration bound (see buildSingleVideoArgs):
	// even with every B-roll input now trimmed, this guarantees the encoded
	// output can never exceed the clip's own planned duration.
	args.push(
		"-c:v",
		"libx264",
		"-preset",
		params.encoder.preset,
		"-crf",
		params.encoder.crf,
		"-t",
		clipDurationSec.toFixed(3),
		"-movflags",
		"+faststart",
		"-max_muxing_queue_size",
		"1024",
		params.outputPath,
	);

	return args;
}

function buildAudiogramArgs(params: {
	encoder: { preset: string; crf: string };
	sourcePath: string;
	outputPath: string;
	startSec: number;
	endSec: number;
	aspectRatio: ClipAspectRatio;
	composition: {
		plan: ClipCompositionPlan;
		targetId: string;
	};
	clipDurationSec: number;
	subtitlePath: string | null;
	logo?: LogoOverlay | null;
	audio: BoundCompositionAudioRenderRequest;
	resolvedSceneAssets?: Readonly<
		Record<string, { path: string; kind: "image" | "video"; hasAudio: boolean }>
	>;
	resolvedSceneFonts?: Readonly<Record<string, string>>;
	/** See `buildSingleVideoArgs` — same cut-concat contract, applied to the
	 *  audio stream only (audiogram sources have no video track). Callers must
	 *  pass `clipDurationSec` already set to the plan's edited duration when
	 *  cut — this builder does not derive it itself. */
	cutPlan?: ClipCutPlan | null;
}) {
	assertBoundAudioMatchesPlan(params.composition.plan, params.audio);
	const config = aspectRatioConfig.get(params.aspectRatio);

	if (!config) {
		throw new CompositionCommandFailure(
			"unsupported_aspect_ratio",
			`Unsupported aspect ratio: ${params.aspectRatio}`,
			"permanent",
		);
	}
	if (params.cutPlan?.isEmpty) {
		throw new CompositionCommandFailure(
			"clip_cut_plan_empty",
			"cutPlan has no renderable segments — caller must guard before building ffmpeg args",
			"permanent",
		);
	}

	const audiogram = compileCompositionPlanAudiogram(
		params.composition.plan,
		params.composition.targetId,
	);
	const { width: W, height: H } = audiogram.canvas;
	const plannedTarget = params.composition.plan.targets.find(
		(target) => target.id === params.composition.targetId,
	);
	if (!plannedTarget) throw new Error("clip_composition_target_missing");
	const insertedLayers = plannedTarget.scenes.flatMap((scene) =>
		scene.layers.filter((layer) => layer.kind === "inserted-scene"),
	);
	const hasInsertedScenes = insertedLayers.length > 0;
	const sceneAssetRefs = [
		...new Set(
			insertedLayers.flatMap((layer) =>
				layer.sourceRef ? [layer.sourceRef] : [],
			),
		),
	];
	const sourceVisualDurationSec = plannedTarget.scenes.reduce(
		(maximum, scene) => Math.max(maximum, scene.sourceRange?.endSec ?? 0),
		0,
	);
	const outputDurationSec = params.composition.plan.editedDurationSec;
	if (W !== config.width || H !== config.height) {
		throw new CompositionCommandFailure(
			"invalid_clip_composition_target",
			"Audiogram plan canvas does not match the requested aspect ratio",
			"permanent",
		);
	}
	const bgColor = audiogram.backgroundColor.replace("#", "0x");
	const waveColor = hexToFfmpegRgb(audiogram.waveformColor);
	const waveHeight = audiogram.waveformHeight;
	const isCut = Boolean(params.cutPlan && !params.cutPlan.isUncut);
	const cutConcat = isCut
		? buildCutConcatFilter({
				cutPlan: params.cutPlan!,
				clipStartSec: params.startSec,
				includeVideo: false,
				includeAudio: true,
				audioInputRef: "[0:a]",
			})
		: null;
	const audioInputLabel = cutConcat ? cutConcat.audioLabel! : "[0:a]";

	// Music and/or SFX (vizard-parity.md "Music/SFX library" — the audiogram
	// path follows whatever it already does for music, so SFX shares the same
	// gate) both mix into the OUTPUT track only, never the waveform — the
	// waveform always visualizes the raw dialogue signal.
	const hasMusicOrSfx =
		Boolean(params.audio.music) ||
		params.audio.soundEffects.length > 0 ||
		params.audio.censors.some((censor) => censor.treatment === "beep");

	const plannedLogo = plannedTarget.visualLayers.find(
		(layer) => layer.kind === "logo",
	);
	if (Boolean(plannedLogo) !== Boolean(params.logo)) {
		throw new Error("clip_composition_logo_asset_mismatch");
	}

	const sceneInputStartIndex = sceneAssetRefs.length > 0 ? 1 : null;
	const logoInputIndex = plannedLogo ? 1 + sceneAssetRefs.length : null;
	const musicInputIndex = 1 + sceneAssetRefs.length + (plannedLogo ? 1 : 0);
	const sfxInputIndexes = params.audio.soundEffects.map(
		(_, index) => musicInputIndex + (params.audio.music ? 1 : 0) + index,
	);
	const chain: string[] = cutConcat ? [...cutConcat.filterParts] : [];
	let dialogueAudioLabel: string;
	if (hasInsertedScenes) {
		if (sourceVisualDurationSec <= 0)
			throw new Error("invalid_clip_composition_source_scenes");
		chain.push(
			`${audioInputLabel}asplit=2[wavesrc][sceneaudiosrc]`,
			`color=c=${bgColor}:s=${W}x${H}:d=${sourceVisualDurationSec.toFixed(3)}[bg]`,
			`[wavesrc]showwaves=s=${W}x${waveHeight}:mode=cline:colors=${waveColor}:rate=25[wave]`,
			`[bg][wave]overlay=0:(H-h)/2[audiogram_source]`,
		);
		const sequence = compileCompositionPlanInsertedSceneSequence({
			plan: params.composition.plan,
			targetId: params.composition.targetId,
			baseVideoLabel: "[audiogram_source]",
			outputLabel: "[comp]",
			fps: 25,
			resolvedSceneAssets: params.resolvedSceneAssets,
			resolvedSceneFonts: params.resolvedSceneFonts,
			sceneInputStartIndex: sceneInputStartIndex ?? undefined,
		});
		chain.push(...sequence.filterParts);
		const sceneAudio = compileCompositionPlanSceneAudio({
			plan: params.composition.plan,
			targetId: params.composition.targetId,
			sourceAudioLabel: "[sceneaudiosrc]",
			sceneInputs: sceneAssetRefs.map((sourceRef, index) => ({
				sourceRef,
				inputIndex: sceneInputStartIndex! + index,
				hasAudio: params.resolvedSceneAssets?.[sourceRef]?.hasAudio ?? false,
			})),
		});
		chain.push(...sceneAudio.filterParts);
		if (!sceneAudio.outputLabel)
			throw new Error("clip_composition_scene_audio_missing");
		dialogueAudioLabel = sceneAudio.outputLabel;
		if (!hasMusicOrSfx) {
			chain.push(
				`${dialogueAudioLabel}${buildDialogueAudioFilter(params.audio)}[outa]`,
			);
		}
	} else {
		dialogueAudioLabel = cutConcat ? "[dlgsrc]" : audioInputLabel;
		if (hasMusicOrSfx && cutConcat) {
			chain.push(`${audioInputLabel}asplit=2[wavesrc][dlgsrc]`);
		}
		const waveSourceLabel =
			hasMusicOrSfx && cutConcat ? "[wavesrc]" : audioInputLabel;
		chain.push(
			...(hasMusicOrSfx
				? [
						`color=c=${bgColor}:s=${W}x${H}:d=${outputDurationSec.toFixed(3)}[bg]`,
						`${waveSourceLabel}showwaves=s=${W}x${waveHeight}:mode=cline:colors=${waveColor}:rate=25[wave]`,
						`[bg][wave]overlay=0:(H-h)/2[comp]`,
					]
				: [
						`color=c=${bgColor}:s=${W}x${H}:d=${outputDurationSec.toFixed(3)}[bg]`,
						`${audioInputLabel}asplit=2[wavesrc][fadesrc]`,
						`[wavesrc]showwaves=s=${W}x${waveHeight}:mode=cline:colors=${waveColor}:rate=25[wave]`,
						`[fadesrc]${buildDialogueAudioFilter(params.audio)}[outa]`,
						`[bg][wave]overlay=0:(H-h)/2[comp]`,
					]),
		);
	}

	const visual = compileCompositionPlanVisualLayers({
		plan: params.composition.plan,
		targetId: params.composition.targetId,
		inputLabel: "[comp]",
		outputLabel: "[composition_visual]",
		subtitlePath: params.subtitlePath,
		logoInputIndex,
	});
	chain.push(...visual.filterParts);
	if (
		visual.logoInput &&
		(!params.logo || visual.logoInput.sourceRef !== params.logo.ref)
	) {
		throw new Error("clip_composition_logo_asset_mismatch");
	}
	chain.push("[composition_visual]format=yuv420p[outv]");
	const videoOutputLabel = "[outv]";

	const args = [
		"-y",
		...httpSourceInputArgs(params.sourcePath),
		"-ss",
		String(params.startSec),
		"-t",
		String(params.endSec - params.startSec),
		"-i",
		params.sourcePath,
	];

	for (const sourceRef of sceneAssetRefs) {
		const asset = params.resolvedSceneAssets?.[sourceRef];
		if (!asset) throw new Error("clip_composition_scene_input_missing");
		if (asset.kind === "image") args.push("-loop", "1");
		else args.push("-stream_loop", "-1");
		args.push("-i", asset.path);
	}
	if (plannedLogo && params.logo) {
		args.push("-i", params.logo.filePath);
	}
	if (params.audio.music) {
		args.push("-stream_loop", "-1", "-i", params.audio.music.path);
	}
	for (const sfx of params.audio.soundEffects) {
		args.push("-i", sfx.path);
	}

	if (hasMusicOrSfx) {
		chain.push(
			buildAudioMixFilter({
				audio: params.audio,
				clipDurationSec: outputDurationSec,
				dialogueInputRef: dialogueAudioLabel,
				musicInputIndex: params.audio.music ? musicInputIndex : null,
				sfxInputIndexes,
			}),
		);
	}

	args.push("-filter_complex", chain.join(";"), "-map", videoOutputLabel);

	args.push("-map", "[outa]");

	// -shortest (existing) already bounds this to the shorter of video/audio;
	// -t is a belt-and-suspenders explicit bound (see buildSingleVideoArgs).
	args.push(
		"-shortest",
		"-t",
		outputDurationSec.toFixed(3),
		"-c:v",
		"libx264",
		"-preset",
		params.encoder.preset,
		"-crf",
		params.encoder.crf,
		"-c:a",
		"aac",
		"-b:a",
		"128k",
		"-movflags",
		"+faststart",
		"-max_muxing_queue_size",
		"1024",
		params.outputPath,
	);

	return args;
}

/**
 * The 2/3 downscale fragment for a "720p" export (1080p-class output ->
 * 720p-class), keyed off the row's `resolution` (vizard-parity Phase C
 * export options) rather than a hardcoded free-tier assumption. "1080p"
 * renders at the base resolution for the aspect ratio — no scale filter.
 */
