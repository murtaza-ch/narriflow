import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captionFontFilePath } from "@narriflow/caption-fonts";
import { resolveRenderBrandFonts } from "./brand-font-resolution";
import { RenderFactCache, contentSha256, sourceProbeIdentity, validateMediaOnce } from "./render-fact-cache";
import type { WorkerMediaInspection } from "./worker-process";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function directory() {
	const path = await mkdtemp(join(tmpdir(), "nf-fact-cache-"));
	directories.push(path);
	return path;
}
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const control = (error: unknown) => {
	if (error instanceof DOMException) throw error;
};

describe("font bytes", () => {
	test("are remembered only under the fingerprint they hash to", () => {
		const cache = new RenderFactCache();
		const bytes = Buffer.from("font-bytes");
		cache.rememberFont("0".repeat(64), bytes);
		expect(cache.font("0".repeat(64))).toBeUndefined();
		cache.rememberFont(sha(bytes), bytes);
		expect(cache.font(sha(bytes))).toEqual(bytes);
		expect(cache.stats().font).toEqual({ hits: 1, misses: 1 });
	});

	test("evict the least recently used past the byte budget", () => {
		const cache = new RenderFactCache();
		const big = (seed: number) => Buffer.alloc(12 * 1024 * 1024, seed);
		const [a, b, c] = [big(1), big(2), big(3)];
		cache.rememberFont(sha(a), a);
		cache.rememberFont(sha(b), b);
		expect(cache.font(sha(a))).toBeDefined();
		cache.rememberFont(sha(c), c);
		expect(cache.font(sha(b))).toBeUndefined();
		expect(cache.font(sha(a))).toBeDefined();
		expect(cache.font(sha(c))).toBeDefined();
	});

	test("a brand font is downloaded once for every clip of a project, and a changed font misses", async () => {
		const dir = await directory();
		const fontBytes = await readFile(captionFontFilePath("Anton-Regular.ttf"));
		const fingerprint = sha(fontBytes);
		const font = { id: "10000000-0000-4000-8000-000000000003", fingerprint, storageKey: "fonts/brand.ttf", format: "TTF" };
		const reference = { kind: "brand_font" as const, id: font.id, fingerprint };
		const cache = new RenderFactCache();
		let downloads = 0;
		const download = async (_key: string, path: string) => { downloads += 1; await writeFile(path, fontBytes); };
		for (let clip = 0; clip < 3; clip++) {
			const fonts = await resolveRenderBrandFonts({ references: [reference], fonts: [font], directory: dir, download, cache });
			expect(fonts.size).toBe(1);
			expect(await readFile([...fonts.values()][0]!.path)).toEqual(fontBytes);
		}
		expect(downloads).toBe(1);

		const changed = { ...reference, fingerprint: sha(Buffer.from("different")) };
		const none = await resolveRenderBrandFonts({ references: [changed], fonts: [{ ...font, fingerprint: changed.fingerprint }], directory: dir, download, cache });
		expect(none.size).toBe(0);
		expect(downloads).toBe(2);
	});
});

describe("media validation", () => {
	test("decodes identical bytes once per kind and never remembers a failure", async () => {
		const dir = await directory();
		const first = join(dir, "music-a.bin");
		const copy = join(dir, "music-b.bin");
		await writeFile(first, "same audio");
		await writeFile(copy, "same audio");
		const cache = new RenderFactCache();
		let decodes = 0;
		const validate = (filePath: string, kind: string, result = true) =>
			validateMediaOnce({ cache, filePath, kind, rethrowControl: control, decode: async () => { decodes += 1; return result; } });
		expect(await validate(first, "audio")).toBe(true);
		expect(await validate(copy, "audio")).toBe(true);
		expect(decodes).toBe(1);
		expect(await validate(copy, "image")).toBe(true);
		expect(decodes).toBe(2);

		await writeFile(copy, "changed audio");
		expect(await validate(copy, "audio", false)).toBe(false);
		expect(await validate(copy, "audio", false)).toBe(false);
		expect(decodes).toBe(4);
	});

	test("an unreadable file is decoded, and cancellation while hashing is not swallowed", async () => {
		const cache = new RenderFactCache();
		let decodes = 0;
		const decode = async () => { decodes += 1; return true; };
		expect(await validateMediaOnce({ cache, filePath: "/nonexistent/narriflow.bin", kind: "audio", rethrowControl: control, decode })).toBe(true);
		expect(await validateMediaOnce({ cache, filePath: "/nonexistent/narriflow.bin", kind: "audio", rethrowControl: control, decode })).toBe(true);
		expect(decodes).toBe(2);

		const dir = await directory();
		const file = join(dir, "x.bin");
		await writeFile(file, "x");
		const aborted = new AbortController();
		aborted.abort(new DOMException("cancelled", "AbortError"));
		await expect(validateMediaOnce({ cache, filePath: file, kind: "audio", signal: aborted.signal, rethrowControl: () => aborted.signal.throwIfAborted(), decode })).rejects.toBeInstanceOf(DOMException);
	});

	test("hashes file content", async () => {
		const dir = await directory();
		const file = join(dir, "x.bin");
		await writeFile(file, "abc");
		expect(await contentSha256(file)).toBe(sha(Buffer.from("abc")));
	});
});

describe("source probes", () => {
	const probe = { durationSec: 12, width: 1920, height: 1080, hasVideo: true, hasVisualStream: true, hasAudio: true, fps: 30 } as WorkerMediaInspection;

	test("are keyed by object key and size, and only when the size is known", () => {
		expect(sourceProbeIdentity("projects/a/source.mp4", 100)).not.toBe(sourceProbeIdentity("projects/a/source.mp4", 101));
		expect(sourceProbeIdentity("projects/a/source.mp4", null)).toBeNull();
		expect(sourceProbeIdentity("projects/a/source.mp4", 0)).toBeNull();
		const cache = new RenderFactCache();
		cache.rememberSourceProbe(null, probe);
		expect(cache.sourceProbe(null)).toBeUndefined();
		const identity = sourceProbeIdentity("projects/a/source.mp4", 100);
		cache.rememberSourceProbe(identity, probe);
		expect(cache.sourceProbe(identity)).toEqual(probe);
		expect(cache.sourceProbe(sourceProbeIdentity("projects/a/source.mp4", 101))).toBeUndefined();
	});

	test("hand out copies, so one render cannot change what the next sees", () => {
		const cache = new RenderFactCache();
		const identity = sourceProbeIdentity("projects/a/source.mp4", 100);
		cache.rememberSourceProbe(identity, probe);
		const mine = cache.sourceProbe(identity)!;
		mine.width = 1;
		expect(cache.sourceProbe(identity)!.width).toBe(1920);
		expect(probe.width).toBe(1920);
	});

	test("hold the newest sixteen objects", () => {
		const cache = new RenderFactCache();
		for (let index = 0; index < 17; index++) cache.rememberSourceProbe(sourceProbeIdentity(`source-${index}.mp4`, 100), probe);
		expect(cache.sourceProbe(sourceProbeIdentity("source-0.mp4", 100))).toBeUndefined();
		expect(cache.sourceProbe(sourceProbeIdentity("source-16.mp4", 100))).toBeDefined();
	});
});
