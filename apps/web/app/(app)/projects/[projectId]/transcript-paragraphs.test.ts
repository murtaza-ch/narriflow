import { describe, expect, test } from "bun:test";
import type { TranscriptUtterance } from "@narriflow/validators";
import { groupTranscriptParagraphs } from "./transcript-paragraphs";

function utterance(
	index: number,
	startSec: number,
	endSec: number,
	text: string,
	speakerLabel = "Speaker 1",
): TranscriptUtterance {
	return {
		index,
		speaker: speakerLabel === "Speaker 1" ? 0 : 1,
		speakerLabel,
		startSec,
		endSec,
		text,
		confidence: null,
		words: [],
	};
}

describe("groupTranscriptParagraphs", () => {
	test("returns nothing for an empty transcript", () => {
		expect(groupTranscriptParagraphs([])).toEqual([]);
	});

	test("joins back-to-back sentences from one speaker into a paragraph", () => {
		const paragraphs = groupTranscriptParagraphs([
			utterance(0, 0, 3, "Hello there."),
			utterance(1, 3.2, 6, "Welcome back."),
		]);
		expect(paragraphs).toEqual([
			{
				key: 0,
				speakerLabel: "Speaker 1",
				startSec: 0,
				text: "Hello there. Welcome back.",
				newSpeaker: true,
			},
		]);
	});

	test("starts a paragraph on a pause of at least 1.2 seconds", () => {
		const paragraphs = groupTranscriptParagraphs([
			utterance(0, 0, 3, "One."),
			utterance(1, 4.19, 6, "Two."),
			utterance(2, 7.2, 9, "Three."),
		]);
		expect(paragraphs.map((paragraph) => paragraph.text)).toEqual(["One. Two.", "Three."]);
		expect(paragraphs.map((paragraph) => paragraph.newSpeaker)).toEqual([true, false]);
	});

	test("starts a paragraph once it spans 30 seconds", () => {
		const paragraphs = groupTranscriptParagraphs([
			utterance(0, 0, 10, "A."),
			utterance(1, 10, 20, "B."),
			utterance(2, 20, 29, "C."),
			utterance(3, 30, 35, "D."),
		]);
		expect(paragraphs.map((paragraph) => paragraph.text)).toEqual(["A. B. C.", "D."]);
		expect(paragraphs[1]?.startSec).toBe(30);
	});

	test("starts a paragraph when the speaker changes and flags it", () => {
		const paragraphs = groupTranscriptParagraphs([
			utterance(0, 0, 2, "Question?", "Speaker 1"),
			utterance(1, 2, 4, "Answer.", "Speaker 2"),
			utterance(2, 4, 6, "Thanks.", "Speaker 1"),
		]);
		expect(paragraphs.map((paragraph) => [paragraph.speakerLabel, paragraph.newSpeaker])).toEqual([
			["Speaker 1", true],
			["Speaker 2", true],
			["Speaker 1", true],
		]);
	});
});
