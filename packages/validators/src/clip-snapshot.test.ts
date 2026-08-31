import { describe, expect, test } from "bun:test";
import { clipSnapshotSchema } from "./clip";

const campaignMotionFieldsSchema = clipSnapshotSchema.pick({
	brollPlacements: true,
	editedDurationSec: true,
});

describe("Clip Snapshot campaign-motion fields", () => {
	test("carries exact placement identities and post-delete duration", () => {
		const placement = {
			id: "2adf79cc-35b2-4de5-85dc-c9ed197763e4",
			asset: {
				kind: "visual_asset",
				id: "8ab9d330-688f-4574-932c-27ac661245c1",
				fingerprint: "a".repeat(64),
			},
			provenance: "generated",
			mediaKind: "image",
			startSec: 2,
			endSec: 5,
			sourceStartSec: null,
			sourceEndSec: null,
		};

		expect(campaignMotionFieldsSchema.parse({
			brollPlacements: [placement],
			editedDurationSec: 13.25,
		})).toEqual({
			brollPlacements: [placement],
			editedDurationSec: 13.25,
		});
	});
});
