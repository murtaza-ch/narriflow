import { describe, expect, test } from "bun:test";
import type { ClipExportSnapshot, ClipSnapshot } from "@narriflow/validators";
import { clipReviewLabel, clipRenderState, renderSummary, type ClipRenderState } from "./publishing-render-state";

const clip = { id: "clip-a", editorRevision: 3 } as ClipSnapshot;

function exported(
	status: ClipExportSnapshot["status"],
	overrides: Partial<ClipExportSnapshot> & { ratio?: string; hasAsset?: boolean } = {},
): ClipExportSnapshot {
	const { ratio = "9:16", hasAsset = status === "ready" || status === "partial_ready", ...rest } = overrides;
	return {
		id: `export-${status}`,
		clipId: clip.id,
		editorRevision: clip.editorRevision,
		isOlderVersion: false,
		status,
		createdAt: "2026-11-06T10:00:00.000Z",
		variants: [{ id: `variant-${status}`, aspectRatio: ratio, hasAsset, status: hasAsset ? "completed" : status === "failed" ? "failed" : "pending" }],
		...rest,
	} as ClipExportSnapshot;
}

describe("clip render state", () => {
	test("maps each export status for a chosen platform", () => {
		expect(clipRenderState(clip, [], ["tiktok"])).toEqual({ kind: "none" });
		expect(clipRenderState(clip, [exported("queued")], ["tiktok"])).toEqual({ kind: "queued" });
		expect(clipRenderState(clip, [exported("rendering")], ["tiktok"])).toEqual({ kind: "rendering" });
		expect(clipRenderState(clip, [exported("ready")], ["tiktok"])).toEqual({ kind: "ready" });
		expect(clipRenderState(clip, [exported("failed")], ["tiktok"])).toEqual({ kind: "failed", exportId: "export-failed" });
	});

	test("a finished video reads as ready even with no account chosen", () => {
		expect(clipRenderState(clip, [exported("ready")], [])).toEqual({ kind: "ready" });
		expect(clipRenderState(clip, [exported("rendering")], [])).toEqual({ kind: "rendering" });
	});

	test("reads another clip's exports as no video", () => {
		expect(clipRenderState(clip, [exported("rendering", { clipId: "clip-b" })], ["tiktok"])).toEqual({ kind: "none" });
	});

	test("ignores an export of another revision", () => {
		expect(clipRenderState(clip, [exported("failed", { editorRevision: 2 })], ["tiktok"])).toEqual({ kind: "none" });
		expect(clipRenderState(clip, [exported("ready", { isOlderVersion: true })], ["tiktok"])).toEqual({ kind: "none" });
	});

	test("a usable video outranks a failed or running one", () => {
		const newerFailure = exported("failed", { createdAt: "2026-11-06T11:00:00.000Z" });
		expect(clipRenderState(clip, [newerFailure, exported("ready")], ["tiktok"])).toEqual({ kind: "ready" });
		expect(clipRenderState(clip, [exported("ready"), exported("rendering")], ["tiktok"])).toEqual({ kind: "ready" });
	});

	test("a running render outranks an older failure of the same clip", () => {
		expect(clipRenderState(clip, [exported("failed"), exported("queued")], ["tiktok"])).toEqual({ kind: "queued" });
	});

	test("retries the newest failed export, whatever order they arrive in", () => {
		const older = exported("failed", { id: "older", createdAt: "2026-11-06T09:00:00.000Z" });
		const newer = exported("failed", { id: "newer", createdAt: "2026-11-06T10:00:00.000Z" });
		expect(clipRenderState(clip, [older, newer], ["tiktok"])).toEqual({ kind: "failed", exportId: "newer" });
	});

	test("a format no chosen platform takes never counts", () => {
		const wide = { ratio: "16:9" };
		expect(clipRenderState(clip, [exported("rendering", wide)], ["tiktok"])).toEqual({ kind: "none" });
		expect(clipRenderState(clip, [exported("failed", wide)], ["tiktok"])).toEqual({ kind: "none" });
		expect(clipRenderState(clip, [exported("ready", wide)], ["tiktok"])).toEqual({ kind: "none" });
	});

	test("one platform still waiting keeps the clip rendering", () => {
		const both = [exported("ready", { ratio: "16:9" }), exported("rendering")];
		expect(clipRenderState(clip, both, ["linkedin", "tiktok"])).toEqual({ kind: "rendering" });
	});

	test("a partly failed export with no usable format can be retried", () => {
		const partial = exported("partial_ready", {
			variants: [
				{ id: "wide", aspectRatio: "16:9", hasAsset: true, status: "completed" },
				{ id: "tall", aspectRatio: "9:16", hasAsset: false, status: "failed" },
			] as ClipExportSnapshot["variants"],
		});
		expect(clipRenderState(clip, [partial], ["tiktok"])).toEqual({ kind: "failed", exportId: partial.id });
	});

	test("an unanswered request reads as queued but never hides a video", () => {
		expect(clipRenderState(clip, [], ["tiktok"], { requested: true })).toEqual({ kind: "queued" });
		expect(clipRenderState(clip, [exported("failed")], ["tiktok"], { requested: true })).toEqual({ kind: "queued" });
		expect(clipRenderState(clip, [exported("ready")], ["tiktok"], { requested: true })).toEqual({ kind: "ready" });
	});
});

describe("render summary", () => {
	const of = (...kinds: ClipRenderState["kind"][]) => kinds.map((kind) => ({ kind }) as ClipRenderState);

	test("counts queued and rendering clips together", () => {
		expect(renderSummary(of("queued", "rendering", "rendering", "ready", "none"))).toBe("3 of 5 videos rendering");
	});

	test("adds failures to the lead", () => {
		expect(renderSummary(of("rendering", "failed", "none"))).toBe("1 of 3 videos rendering · 1 failed");
		expect(renderSummary(of("ready", "failed"))).toBe("1 of 2 videos ready · 1 failed");
		expect(renderSummary(of("failed", "none"))).toBe("1 of 2 videos failed");
	});

	test("has nothing to say for one clip or an untouched selection", () => {
		expect(renderSummary(of("rendering"))).toBeNull();
		expect(renderSummary(of("none", "none"))).toBeNull();
	});
});

describe("clip review label", () => {
	test("stays separate from the video", () => {
		expect(clipReviewLabel({ kind: "none" }, 0, 1)).toBeNull();
		expect(clipReviewLabel({ kind: "rendering" }, 1, 1)).toBe("Needs review");
		expect(clipReviewLabel({ kind: "ready" }, 0, 1)).toBe("Ready");
		expect(clipReviewLabel({ kind: "ready" }, 2, 1)).toBe("Needs review");
	});

	test("says nothing without an account to post to", () => {
		expect(clipReviewLabel({ kind: "ready" }, 0, 0)).toBeNull();
	});
});
