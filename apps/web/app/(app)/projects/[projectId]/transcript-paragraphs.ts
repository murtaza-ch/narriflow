import type { TranscriptUtterance } from "@narriflow/validators";

/** Same reading rhythm as the Trim/Extend dialog (edit-clip-length-dialog.tsx). */
export const PARAGRAPH_PAUSE_SEC = 1.2;
export const PARAGRAPH_MAX_SEC = 30;

export interface TranscriptParagraph {
	/** Position in the list: unique, and stable for a given transcript. */
	key: number;
	speakerLabel: string;
	startSec: number;
	text: string;
	/** True when the speaker differs from the previous paragraph (or none came before). */
	newSpeaker: boolean;
}

/**
 * Folds the transcript's sentence-sized utterances into reading paragraphs.
 * A paragraph ends when the speaker changes, after a pause of
 * `PARAGRAPH_PAUSE_SEC`, or once it spans `PARAGRAPH_MAX_SEC`.
 */
export function groupTranscriptParagraphs(
	utterances: readonly TranscriptUtterance[],
): TranscriptParagraph[] {
	const paragraphs: TranscriptParagraph[] = [];
	let previous: TranscriptUtterance | undefined;
	for (const utterance of utterances) {
		const current = paragraphs.at(-1);
		const startsNew =
			!current ||
			!previous ||
			utterance.speakerLabel !== current.speakerLabel ||
			utterance.startSec - previous.endSec >= PARAGRAPH_PAUSE_SEC ||
			utterance.startSec - current.startSec >= PARAGRAPH_MAX_SEC;
		if (startsNew) {
			paragraphs.push({
				key: paragraphs.length,
				speakerLabel: utterance.speakerLabel,
				startSec: utterance.startSec,
				text: utterance.text,
				newSpeaker: !current || utterance.speakerLabel !== current.speakerLabel,
			});
		} else {
			current.text += ` ${utterance.text}`;
		}
		previous = utterance;
	}
	return paragraphs;
}
