import { describe, expect, test } from "bun:test";

import {
	buildGeneratedMediaPromptSources,
	nextBrollInspectorModeForKey,
	revisionFenceGeneratedMediaStudioSubmit,
	shouldPollGeneratedMedia,
} from "./generated-media-studio-model";

const clipId = "00000000-0000-4000-8000-000000000001";

describe("generated media Studio model", () => {
	test("builds exact word and cue provenance instead of trusting client context", () => {
		const sources = buildGeneratedMediaPromptSources({
			clipId,
			transcriptSelectionRange: { startSec: 10, endSec: 11.2 },
			utterances: [{
				index: 4,
				speaker: null,
				speakerLabel: "Speaker",
				startSec: 10,
				endSec: 12,
				text: "Quiet morning ritual",
				confidence: 0.9,
				words: [
					{ word: "Quiet", startSec: 10, endSec: 10.4, confidence: 0.9 },
					{ word: "morning", startSec: 10.5, endSec: 11, confidence: 0.9 },
					{ word: "ritual", startSec: 11.3, endSec: 12, confidence: 0.9 },
				],
			}],
			brollCues: [{ atSec: 2, query: "sunlit kitchen", reason: "Morning routine" }],
		});

		expect(sources[0]).toMatchObject({
			id: "manual",
			origin: { kind: "manual", sourceIds: [] },
			derivedContext: null,
		});
		expect(sources[1]).toMatchObject({
			label: "Selected transcript",
			origin: {
				kind: "transcript_selection",
				sourceIds: [
					`clip:${clipId}:transcript:4:0`,
					`clip:${clipId}:transcript:4:1`,
				],
			},
			prompt: "Quiet morning",
			derivedContext: "Quiet morning",
		});
		expect(sources[1]?.id).toMatch(/^transcript-selection-[a-f0-9]{8}$/);
		expect(sources[2]).toMatchObject({
			origin: { kind: "broll_cue", sourceIds: [`clip:${clipId}:broll:0`] },
			prompt: "sunlit kitchen",
			derivedContext: "Morning routine",
		});
	});

	test("fails closed on a transcript range without exact words", () => {
		const sources = buildGeneratedMediaPromptSources({
			clipId,
			transcriptSelectionRange: { startSec: 50, endSec: 51 },
			utterances: [],
			brollCues: [],
		});
		expect(sources.map((source) => source.id)).toEqual(["manual"]);
	});

	test("keeps long selections explicit by offering a reviewed 64-word bound", () => {
		const words = Array.from({ length: 65 }, (_, index) => ({
			word: `word-${index + 1}`,
			startSec: index * 0.1,
			endSec: index * 0.1 + 0.08,
			confidence: 0.9,
		}));
		const sources = buildGeneratedMediaPromptSources({
			clipId,
			transcriptSelectionRange: { startSec: 0, endSec: 7 },
			utterances: [{
				index: 7,
				speaker: null,
				speakerLabel: "Speaker",
				startSec: 0,
				endSec: 7,
				text: words.map((word) => word.word).join(" "),
				confidence: 0.9,
				words,
			}],
			brollCues: [],
		});

		expect(sources[1]).toMatchObject({
			label: "Selected transcript · first 64 words",
			notice: "Using the first 64 words. Narrow the transcript selection to include a later passage.",
			origin: { kind: "transcript_selection" },
		});
		expect(sources[1]?.origin.sourceIds).toHaveLength(64);
		expect(sources[1]?.prompt).not.toContain("word-65");
	});

	test("polls only provider-progress states and keeps reconciliation manual", () => {
		expect(shouldPollGeneratedMedia([{ status: "queued" }])).toBe(true);
		expect(shouldPollGeneratedMedia([{ status: "waiting" }])).toBe(true);
		expect(shouldPollGeneratedMedia([{ status: "reconciliation_required" }])).toBe(false);
		expect(shouldPollGeneratedMedia([{ status: "completed" }])).toBe(false);
	});

	test("supports keyboard navigation between Browse and Generate", () => {
		expect(nextBrollInspectorModeForKey("browse", "ArrowRight")).toBe("generate");
		expect(nextBrollInspectorModeForKey("generate", "ArrowLeft")).toBe("browse");
		expect(nextBrollInspectorModeForKey("generate", "Enter")).toBeNull();
	});

	test("checkpoints derived prompt sources at the current cloud revision", async () => {
		let checkpoints = 0;
		const request = await revisionFenceGeneratedMediaStudioSubmit(
			{
				idempotencyKey: "00000000-0000-4000-8000-000000000010",
				projectId: "00000000-0000-4000-8000-000000000011",
				clipId: "00000000-0000-4000-8000-000000000012",
				kind: "image",
				prompt: "A quiet studio at first light",
				includeDerivedContext: true,
				promptOrigin: {
					kind: "transcript_selection",
					sourceIds: [
						"clip:00000000-0000-4000-8000-000000000012:transcript:4:1",
					],
				},
				aspectRatio: "9:16",
				style: "editorial",
				durationSec: null,
				title: null,
			},
			async () => {
				checkpoints += 1;
				return 9;
			},
		);

		expect(request.sourceRevision).toBe(9);
		expect(checkpoints).toBe(1);
	});
});
