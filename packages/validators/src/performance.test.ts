import { describe, expect, test } from "bun:test";
import { clipExportDurationSec } from "./editor-document";
import { finishingPicksSchema } from "./finishing";
import { performanceGuidanceSchema } from "./performance";
import { performanceGuidanceSettingActionSchema } from "./workspace-administration";

describe("Performance Guidance shapes", () => {
	const group = { dimension: "category", key: "story", posts: 12, lift: 1.4 };
	const platform = { platform: "youtube_shorts", posts: 40, medianViews: 200 };

	test("stored guidance accepts the two groupings and refuses anything else, labels included", () => {
		const stored = { totalPosts: 40, platforms: [platform], groups: [group] };
		expect(performanceGuidanceSchema.safeParse(stored).success).toBe(true);
		expect(performanceGuidanceSchema.safeParse({ totalPosts: 0, platforms: [], groups: [] }).success).toBe(true);
		expect(performanceGuidanceSchema.safeParse({ ...stored, groups: [{ ...group, dimension: "platform" }] }).success).toBe(false);
		// Hook strength is not a grouping.
		expect(performanceGuidanceSchema.safeParse({ ...stored, groups: [{ ...group, dimension: "hook", key: "80-plus" }] }).success).toBe(false);
		// A stored label is not part of the shape; it is rebuilt from the key.
		expect(performanceGuidanceSchema.safeParse({ ...stored, groups: [{ ...group, label: "Story" }] }).success).toBe(false);
		expect(performanceGuidanceSchema.safeParse({ ...stored, platforms: [{ ...platform, platform: "myspace" }] }).success).toBe(false);
	});

	test("a finishing pick carries its ranking only when guidance was applied", () => {
		const clipId = "00000000-0000-4000-8000-000000000002";
		const ranking = { score: 70, factor: 1.25, groups: [{ dimension: "category", label: "Category Story", lift: 1.4 }], guidanceComputedAt: "2026-10-24T03:00:00.000Z" };
		expect(finishingPicksSchema.parse([{ clipId, editorRevision: 0 }])[0]?.ranking).toBeUndefined();
		expect(finishingPicksSchema.parse([{ clipId, editorRevision: 0, ranking }])[0]?.ranking).toEqual(ranking);
		expect(finishingPicksSchema.safeParse([{ clipId, editorRevision: 0, ranking: { ...ranking, factor: "high" } }]).success).toBe(false);
		expect(finishingPicksSchema.safeParse([{ clipId, editorRevision: 0, ranking: { ...ranking, groups: [{ dimension: "hook", label: "Hook strength 80 and above", lift: 1.3 }] } }]).success).toBe(false);
	});

	test("the setting is a plain yes or no", () => {
		expect(performanceGuidanceSettingActionSchema.parse({ enabled: false })).toEqual({ enabled: false });
		expect(performanceGuidanceSettingActionSchema.safeParse({ enabled: "yes" }).success).toBe(false);
		expect(performanceGuidanceSettingActionSchema.safeParse({}).success).toBe(false);
	});
});

describe("a clip's exported length", () => {
	const scene = { schemaVersion: 1, id: "8ab9d330-688f-4574-932c-27ac661245c1", anchorSec: 0, durationSec: 2, content: { kind: "color", color: "#111827" }, motion: { entrance: "none", exit: "none" }, templateSnapshot: null };

	test("is the source window for a clip nobody has edited", () => {
		expect(clipExportDurationSec({ startSec: 10, endSec: 40, deletedRanges: null, sceneBlocks: [] })).toBe(30);
		expect(clipExportDurationSec({ startSec: 10, endSec: 40, deletedRanges: [], sceneBlocks: null })).toBe(30);
	});

	test("takes out the cut ranges and adds the scene blocks, as the export does", () => {
		expect(clipExportDurationSec({ startSec: 0, endSec: 30, deletedRanges: [{ startSec: 5, endSec: 20 }], sceneBlocks: [] })).toBe(15);
		expect(clipExportDurationSec({ startSec: 0, endSec: 30, deletedRanges: [{ startSec: 5, endSec: 20 }], sceneBlocks: [scene] })).toBe(17);
	});

	test("treats stored data it cannot read as no edits", () => {
		expect(clipExportDurationSec({ startSec: 0, endSec: 30, deletedRanges: "nope", sceneBlocks: [{ durationSec: "long" }] })).toBe(30);
	});
});
