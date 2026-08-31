import type { BrollPlacement } from "@narriflow/validators";

export type BrollTimelineCutaway = {
	startSec: number;
	endSec: number;
	query: string;
	manual: boolean;
	placementId: string | null;
};

export function buildBrollTimelineCutaways(input: {
	placements: readonly BrollPlacement[];
	manualWindow: { startSec: number; endSec: number } | null;
	automatic: readonly { startSec: number; endSec: number; query: string }[];
}): BrollTimelineCutaway[] {
	if (input.placements.length > 0) {
		return input.placements.map((placement) => ({
			startSec: placement.startSec,
			endSec: placement.endSec,
			query: `${placement.mediaKind === "image" ? "Still" : "Video"} asset`,
			manual: true,
			placementId: placement.id,
		}));
	}
	if (input.manualWindow) {
		return [{
			...input.manualWindow,
			query: "Selected stock clip",
			manual: true,
			placementId: null,
		}];
	}
	return input.automatic.map((cutaway) => ({
		...cutaway,
		manual: false,
		placementId: null,
	}));
}
