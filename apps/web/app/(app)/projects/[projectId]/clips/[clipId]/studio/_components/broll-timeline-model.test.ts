import { describe, expect, test } from "bun:test";

import { buildBrollTimelineCutaways } from "./broll-timeline-model";

describe("asset-backed B-roll timeline model", () => {
	test("keeps every durable placement bounded and selectable by its exact id", () => {
		const cutaways = buildBrollTimelineCutaways({
			placements: [{
				id: "00000000-0000-4000-8000-000000000001",
				asset: {
					kind: "visual_asset",
					id: "00000000-0000-4000-8000-000000000002",
					fingerprint: "a".repeat(64),
				},
				provenance: "generated",
				mediaKind: "image",
				startSec: 3,
				endSec: 6,
				sourceStartSec: null,
				sourceEndSec: null,
			}],
			manualWindow: { startSec: 0, endSec: 10 },
			automatic: [{ startSec: 1, endSec: 2, query: "ignored" }],
		});
		expect(cutaways).toEqual([{
			startSec: 3,
			endSec: 6,
			query: "Still asset",
			manual: true,
			placementId: "00000000-0000-4000-8000-000000000001",
		}]);
	});
});
