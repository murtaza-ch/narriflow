import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NARRIFLOW_WATERMARK_ART } from "@narriflow/composition-plan";
import { WorkflowFailure } from "@narriflow/services/workflow-attempt-contract";

/** Resolved on first use, not at import: a broken badge install must fail the
 *  renders that draw the badge, never every render that loads this module. */
function committedWatermarkArtPath(): string {
	try {
		return fileURLToPath(
			import.meta.resolve("@narriflow/composition-plan/watermark-badge.png"),
		);
	} catch {
		throw watermarkArtInvalid("The watermark art file cannot be located");
	}
}

const verified = new Set<string>();

/** The absolute path of the committed watermark badge, after checking its
 *  bytes against `NARRIFLOW_WATERMARK_ART` (once per path). A missing or
 *  altered file is a permanent composition failure, raised while the command
 *  is compiled, before FFmpeg starts. */
export function verifiedWatermarkArtPath(
	path: string = committedWatermarkArtPath(),
): string {
	if (verified.has(path)) return path;
	let digest: string;
	try {
		digest = createHash("sha256").update(readFileSync(path)).digest("hex");
	} catch {
		throw watermarkArtInvalid("The watermark art file is missing");
	}
	if (digest !== NARRIFLOW_WATERMARK_ART.sha256) {
		throw watermarkArtInvalid("The watermark art file does not match its checksum");
	}
	verified.add(path);
	return path;
}

function watermarkArtInvalid(message: string): WorkflowFailure {
	return new WorkflowFailure("watermark_art_invalid", "permanent", message);
}
