import { describe, expect, test } from "bun:test";
import { studioEditsSchema, studioTextLayerSchema } from "@narriflow/validators";
import { clipTitleOverlayModel } from "./clip-title-overlay-model";

const title = studioTextLayerSchema.parse({ id: "title", role: "title", text: "Why creators stay", startSec: 0, endSec: 5 });
const body = studioTextLayerSchema.parse({ id: "b", role: "body", text: "Body", startSec: 1, endSec: 4 });

function clip(layers: unknown[], extra: { deletedRanges?: { startSec: number; endSec: number }[]; startSec?: number; endSec?: number } = {}) {
	return {
		startSec: extra.startSec ?? 100,
		endSec: extra.endSec ?? 130,
		studioEdits: studioEditsSchema.parse({ textLayers: layers }),
		deletedRanges: extra.deletedRanges,
	};
}

describe("clip card title overlay model", () => {
	test("takes the first title layer, not a body layer", () => {
		const second = { ...title, id: "title-2", text: "Second" };
		expect(clipTitleOverlayModel(clip([body, title, second]), 90)?.layer.id).toBe("title");
		expect(clipTitleOverlayModel(clip([body]), 90)).toBeNull();
		expect(clipTitleOverlayModel({ startSec: 0, endSec: 10 }, 0)).toBeNull();
	});

	test("maps the proxy player's time to edited time through the offset and the cuts", () => {
		// Proxy t=0 is source 90 s; the clip is source 100–130 with 105–110 cut.
		const model = clipTitleOverlayModel(clip([title], { deletedRanges: [{ startSec: 105, endSec: 110 }] }), 90)!;
		expect(model.editedSecAt(10)).toBe(0); // source 100: the clip's first frame
		expect(model.editedSecAt(14)).toBe(4); // source 104
		expect(model.editedSecAt(17)).toBe(5); // source 107, inside the cut: the next kept frame
		expect(model.editedSecAt(22)).toBe(7); // source 112
		// Before the in-point (the player at 0 before metadata) is the first frame, so the title shows behind the play button.
		expect(model.editedSecAt(0)).toBe(0);
		// Past the out-point is the end of the clip.
		expect(model.editedSecAt(45)).toBe(25);
	});

	test("clamps the layer's window to the clip's edited duration, as the plan does", () => {
		const cut = { deletedRanges: [{ startSec: 100, endSec: 120 }] }; // 10 s left
		expect(clipTitleOverlayModel(clip([title]), 90)!.window).toEqual({ fromMs: 0, toMs: 5000 });
		expect(clipTitleOverlayModel(clip([{ ...title, endSec: 20 }], cut), 90)!.window).toEqual({ fromMs: 0, toMs: 10000 });
		expect(clipTitleOverlayModel(clip([{ ...title, endSec: null }], cut), 90)!.window).toEqual({ fromMs: 0, toMs: 10000 });
		expect(clipTitleOverlayModel(clip([{ ...title, startSec: 12, endSec: 20 }], cut), 90)).toBeNull();
	});
});
