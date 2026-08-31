import { describe, expect, test } from "bun:test";
import { editorDocumentSchema } from "@narriflow/validators";
import { projectClipCampaignMotionFields } from "./clip.service";

describe("Clip Snapshot campaign-motion projection", () => {
	test("projects placements and the exact post-delete edited duration", () => {
		const placement = {
			id: "2adf79cc-35b2-4de5-85dc-c9ed197763e4",
			asset: {
				kind: "visual_asset" as const,
				id: "8ab9d330-688f-4574-932c-27ac661245c1",
				fingerprint: "a".repeat(64),
			},
			provenance: "generated" as const,
			mediaKind: "image" as const,
			startSec: 2,
			endSec: 5,
			sourceStartSec: null,
			sourceEndSec: null,
		};
		const document = editorDocumentSchema.parse({
			version: 2,
			clipStartSec: 0,
			clipEndSec: 20,
			captionPreset: {},
			transcriptSlice: [],
			studioEdits: {},
			brollUrl: null,
			brollPlacements: [placement],
			deletedRanges: [
				{ startSec: 4, endSec: 7 },
				{ startSec: 12, endSec: 16 },
			],
		});

		expect(projectClipCampaignMotionFields(document)).toEqual({
			brollPlacements: [placement],
			editedDurationSec: 13,
		});
	});
});
