import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MAX_INLINE_FILTERGRAPH_BYTES,
	transportRenderCommand,
} from "./render-command-transport";
import { productionWorkerProcessModule } from "./worker-process";

describe("render command graph transport", () => {
	test("ordinary argv remains exact and writes nothing", async () => {
		const args = [
			"-i",
			"source.mp4",
			"-filter_complex",
			"[0:v]null[v]",
			"-map",
			"[v]",
			"out.mp4",
		];
		expect(
			await transportRenderCommand({
				args,
				directory: "/unused",
				writeGraph: async () => {
					throw new Error("Unexpected write");
				},
			}),
		).toEqual(args);
	});

	test("the byte boundary includes UTF-8 and the terminating NUL", async () => {
		const writes = new Map<string, string>();
		const writeGraph = async (path: string, graph: string) => {
			writes.set(path, graph);
		};
		const small = "a".repeat(MAX_INLINE_FILTERGRAPH_BYTES);
		const large = `${small}é`;
		expect(
			await transportRenderCommand({
				args: ["-filter_complex", small],
				directory: "/attempt",
				writeGraph,
			}),
		).toEqual(["-filter_complex", small]);
		const args = await transportRenderCommand({
			args: ["-filter_complex", large],
			directory: "/attempt",
			writeGraph,
		});
		expect(args[0]).toBe("-filter_complex_script");
		expect(writes.get(args[1]!)).toBe(large);
		expect(args[1]!.startsWith("/attempt/")).toBe(true);
	});

	test("write failure propagates before spawning and preserves its cause", async () => {
		const failure = new Error("ENOSPC");
		await expect(
			transportRenderCommand({
				args: ["-filter_complex", " ".repeat(140_000)],
				directory: "/attempt",
				writeGraph: async () => {
					throw failure;
				},
			}),
		).rejects.toBe(failure);
	});

	test("an oversized graph executes with exact expanded bytes and decoded frames/PCM", async () => {
		const directory = await mkdtemp(join(tmpdir(), "render-graph-14-"));
		const signal = new AbortController().signal;
		const execute = (args: string[]) =>
			productionWorkerProcessModule.execute({
				command: "ffmpeg",
				args,
				signal,
				deadlineMs: 30_000,
				captureStdout: true,
			});
		try {
			const graph = `[0:v]null[v];${" ".repeat(140_000)}[1:a]anull[a]`;
			const args = [
				"-v",
				"error",
				"-f",
				"lavfi",
				"-i",
				"testsrc2=s=32x32:r=5:d=0.4",
				"-f",
				"lavfi",
				"-i",
				"sine=frequency=440:duration=0.4",
				"-filter_complex",
				graph,
				"-map",
				"[v]",
				"-map",
				"[a]",
				"-c:v",
				"rawvideo",
				"-c:a",
				"pcm_s16le",
				"-f",
				"framehash",
				"-",
			];
			const transported = await transportRenderCommand({ args, directory });
			const script =
				transported[transported.indexOf("-filter_complex_script") + 1]!;
			expect(await readFile(script, "utf8")).toBe(graph);
			const expanded = [...transported];
			expanded[expanded.indexOf("-filter_complex_script") + 1] = await readFile(
				script,
				"utf8",
			);
			expanded[expanded.indexOf("-filter_complex_script")] = "-filter_complex";
			expect(expanded).toEqual(args);
			const actual = await execute(transported);
			// Whitespace has no graph semantics. This reference also works on Linux,
			// where executing the expanded oversized argv itself would fail E2BIG.
			const reference = [...args];
			reference[reference.indexOf("-filter_complex") + 1] =
				"[0:v]null[v];[1:a]anull[a]";
			expect(actual.stdout.toString()).toBe(
				(await execute(reference)).stdout.toString(),
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

// This test is deliberately runnable in the pinned Linux image too:
// bun test apps/worker/src/render-command-transport.test.ts
// It compiles a schema-valid document rather than manufacturing a large argv.
test("a schema-valid 64-scene composition executes a production graph above Linux MAX_ARG_STRLEN", async () => {
	const { editorDocumentSchema } = await import("@narriflow/validators");
	const { planClipComposition } = await import("@narriflow/composition-plan");
	const {
		compileClipCompositionCommand,
		bindCompositionPlanAudioInputs,
		compileCompositionPlanAudioSchedule,
	} = await import("./composition-ffmpeg-adapter");
	const { compositionSourceFor } = await import("./tasks/clip-render-attempt");
	const directory = await mkdtemp(join(tmpdir(), "render-valid-graph-14-"));
	const signal = new AbortController().signal;
	const execute = (args: string[]) =>
		productionWorkerProcessModule.execute({
			command: "ffmpeg",
			args,
			signal,
			deadlineMs: 120_000,
			captureStdout: true,
		});
	try {
		const sourcePath = join(directory, "source.mp4");
		await execute([
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"testsrc2=s=32x32:r=1:d=1",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=1",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
			sourcePath,
		]);
		const source = await productionWorkerProcessModule.inspectMedia({
			sourcePath,
			signal,
			deadlineMs: 30_000,
		});
		const document = editorDocumentSchema.parse({
			version: 1,
			clipStartSec: 0,
			clipEndSec: 1,
			transcriptSlice: [],
			captionPreset: { visible: false },
			studioEdits: { framing: { mode: "center" } },
			sceneBlocks: Array.from({ length: 64 }, (_, i) => ({
				schemaVersion: 1,
				id: `20000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
				anchorSec: i,
				durationSec: 1,
				content: {
					kind: "text",
					text: "a:'\\%".repeat(100),
					fontFamily: "Arial",
					color: "#FFFFFF",
					backgroundColor: "#000000",
				},
				motion: { entrance: "none", exit: "none", durationSec: 0.5 },
				templateSnapshot: null,
			})),
		});
		const result = planClipComposition({
			document,
			source: compositionSourceFor(source, "large-graph-source"),
			assets: { backgroundImage: { state: "missing" } },
			evidence: { automaticLayout: { state: "missing" } },
			capabilities: { automaticSpeakerLayout: false },
			targets: [{ id: "large", aspectRatio: "1:1", width: 64, height: 64 }],
		});
		if (result.status === "invalid") throw new Error(result.error.code);
		const outputPath = join(directory, "large.mp4");
		const args = compileClipCompositionCommand({
			sourcePath,
			outputPath,
			source,
			plan: result.plan,
			targetId: "large",
			startSec: 0,
			endSec: 1,
			audio: bindCompositionPlanAudioInputs(
				compileCompositionPlanAudioSchedule(result.plan),
				{},
			),
			assets: {},
			encoder: { preset: "veryfast", crf: "21" },
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;
		expect(Buffer.byteLength(graph)).toBeGreaterThan(128 * 1024);
		expect(
			args.reduce((sum, arg) => sum + Buffer.byteLength(arg) + 1, 0),
		).toBeLessThan(512 * 1024);
		const transported = await transportRenderCommand({ args, directory });
		console.info(
			JSON.stringify({
				message: "large_composition_graph_transport",
				platform: process.platform,
				graphBytes: Buffer.byteLength(graph),
				commandBytes: args.reduce(
					(sum, arg) => sum + Buffer.byteLength(arg) + 1,
					0,
				),
				maxTransportArgBytes: Math.max(
					...transported.map((arg) => Buffer.byteLength(arg)),
				),
			}),
		);
		expect(
			await readFile(
				transported[transported.indexOf("-filter_complex_script") + 1]!,
				"utf8",
			),
		).toBe(graph);
		expect(
			Math.max(...transported.map((arg) => Buffer.byteLength(arg))),
		).toBeLessThan(128 * 1024);
		await execute(transported);
		const decoded = await execute([
			"-v",
			"error",
			"-xerror",
			"-i",
			outputPath,
			"-c:v",
			"rawvideo",
			"-c:a",
			"pcm_s16le",
			"-f",
			"framehash",
			"-",
		]);
		expect(decoded.stdout.toString()).toContain("#media_type 0: video");
		expect(decoded.stdout.toString()).toContain("#media_type 1: audio");
		if (process.platform !== "linux") {
			// macOS can execute the original argv, allowing a direct decoded parity
			// check. Linux instead proves exec success and exact expanded graph bytes.
			const inline = [...args];
			inline[inline.length - 1] = join(directory, "inline.mp4");
			await execute(inline);
			const reference = await execute([
				"-v",
				"error",
				"-xerror",
				"-i",
				inline[inline.length - 1]!,
				"-c:v",
				"rawvideo",
				"-c:a",
				"pcm_s16le",
				"-f",
				"framehash",
				"-",
			]);
			expect(decoded.stdout.toString()).toBe(reference.stdout.toString());
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 120_000);
