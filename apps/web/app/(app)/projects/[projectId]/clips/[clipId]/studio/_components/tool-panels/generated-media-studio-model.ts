import type {
	BrollCue,
	GeneratedMediaJobStatus,
	GeneratedMediaPromptOrigin,
	GeneratedMediaStudioSubmitInput,
	SourceRange,
	TranscriptUtterance,
} from "@narriflow/validators";

export interface GeneratedMediaPromptSource {
	id: string;
	label: string;
	origin: GeneratedMediaPromptOrigin;
	prompt: string;
	derivedContext: string | null;
	notice?: string;
}

export type BrollInspectorMode = "browse" | "generate";
export type GeneratedMediaStudioSubmitDraft = Omit<
	GeneratedMediaStudioSubmitInput,
	"sourceRevision"
>;

export async function revisionFenceGeneratedMediaStudioSubmit(
	input: GeneratedMediaStudioSubmitDraft,
	checkpointCloud: () => Promise<number>,
): Promise<GeneratedMediaStudioSubmitInput> {
	return {
		...input,
		sourceRevision:
			input.promptOrigin.kind === "manual" ? null : await checkpointCloud(),
	};
}

function sourceRevision(value: string) {
	let hash = 2_166_136_261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

export function nextBrollInspectorModeForKey(
	current: BrollInspectorMode,
	key: string,
): BrollInspectorMode | null {
	if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
	return current === "browse" ? "generate" : "browse";
}

export function shouldPollGeneratedMedia(
	jobs: readonly { status: GeneratedMediaJobStatus }[],
): boolean {
	return jobs.some((job) =>
		job.status === "queued" ||
		job.status === "running" ||
		job.status === "waiting"
	);
}

export function buildGeneratedMediaPromptSources(input: {
	clipId: string;
	transcriptSelectionRange: SourceRange | null;
	utterances: readonly TranscriptUtterance[];
	brollCues: readonly BrollCue[];
}): readonly GeneratedMediaPromptSource[] {
	const sources: GeneratedMediaPromptSource[] = [{
		id: "manual",
		label: "Manual prompt",
		origin: { kind: "manual", sourceIds: [] },
		prompt: "",
		derivedContext: null,
	}];

	if (input.transcriptSelectionRange) {
		const words = input.utterances.flatMap((utterance) =>
			utterance.words.flatMap((word, wordIndex) =>
				word.startSec + 0.001 >= input.transcriptSelectionRange!.startSec &&
				word.endSec <= input.transcriptSelectionRange!.endSec + 0.001
					? [{
						text: word.word.trim(),
						id: `clip:${input.clipId}:transcript:${utterance.index}:${wordIndex}`,
					}]
					: [],
			),
		);
		const usableWords = words.filter((word) => Boolean(word.text));
		const boundedWords = usableWords.slice(0, 64);
		const context = boundedWords.map((word) => word.text).join(" ").trim();
		if (context) {
			const sourceIds = boundedWords.map((word) => word.id);
			const truncated = usableWords.length > boundedWords.length;
			sources.push({
				id: `transcript-selection-${sourceRevision(`${sourceIds.join(",")}:${context}`)}`,
				label: truncated
					? "Selected transcript · first 64 words"
					: "Selected transcript",
				origin: {
					kind: "transcript_selection",
					sourceIds,
				},
				prompt: context.slice(0, 4_000),
				derivedContext: context.slice(0, 4_000),
				...(truncated
					? {
							notice:
								"Using the first 64 words. Narrow the transcript selection to include a later passage.",
						}
					: {}),
			});
		}
	}

	for (const [index, cue] of input.brollCues.entries()) {
		sources.push({
			id: `broll-cue-${index}-${sourceRevision(`${cue.query}:${cue.reason ?? ""}`)}`,
			label: `Visual cue · ${cue.query}`,
			origin: {
				kind: "broll_cue",
				sourceIds: [`clip:${input.clipId}:broll:${index}`],
			},
			prompt: cue.query,
			derivedContext: cue.reason?.trim() || cue.query,
		});
	}

	return sources;
}
