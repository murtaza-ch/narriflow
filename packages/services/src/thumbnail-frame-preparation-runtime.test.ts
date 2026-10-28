import { describe, expect, test } from "bun:test";
import { createConcurrencyGate, thumbnailExtractionConcurrency } from "./thumbnail-frame-preparation-runtime";

describe("thumbnail extraction concurrency", () => {
	test("defaults to two and stays within one to four", () => {
		expect(thumbnailExtractionConcurrency({})).toBe(2);
		expect(thumbnailExtractionConcurrency({ THUMBNAIL_EXTRACTION_CONCURRENCY: "3" })).toBe(3);
		expect(thumbnailExtractionConcurrency({ THUMBNAIL_EXTRACTION_CONCURRENCY: "50" })).toBe(4);
		expect(thumbnailExtractionConcurrency({ THUMBNAIL_EXTRACTION_CONCURRENCY: "0" })).toBe(2);
		expect(thumbnailExtractionConcurrency({ THUMBNAIL_EXTRACTION_CONCURRENCY: "abc" })).toBe(2);
	});

	test("never runs more tasks than the limit and starts the rest in arrival order", async () => {
		const gate = createConcurrencyGate(2);
		let running = 0;
		let peak = 0;
		const started: number[] = [];
		const releases: Array<() => void> = [];
		const tasks = [0, 1, 2, 3].map((index) =>
			gate.run(async () => {
				started.push(index);
				running += 1;
				peak = Math.max(peak, running);
				await new Promise<void>((resolve) => releases.push(resolve));
				running -= 1;
				return index;
			}),
		);
		await Bun.sleep(5);
		expect(started).toEqual([0, 1]);
		releases[0]!();
		await Bun.sleep(5);
		expect(started).toEqual([0, 1, 2]);
		releases[1]!();
		await Bun.sleep(5);
		releases[2]!();
		await Bun.sleep(5);
		releases[3]!();
		expect(await Promise.all(tasks)).toEqual([0, 1, 2, 3]);
		expect(peak).toBe(2);
	});

	test("a failing task releases its slot", async () => {
		const gate = createConcurrencyGate(1);
		await expect(gate.run(async () => Promise.reject(new Error("ffmpeg failed")))).rejects.toThrow("ffmpeg failed");
		expect(await gate.run(async () => "next")).toBe("next");
	});
});
