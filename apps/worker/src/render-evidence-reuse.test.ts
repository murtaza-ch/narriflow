import { describe, expect, test } from "bun:test";
import { compositionAssetRef } from "@narriflow/composition-plan";
import type { WorkflowAttemptContext } from "@narriflow/services";
import { createRenderOutputFixture } from "./render-output-validation.test-fixture";
import { parseRenderConfig } from "./render-config";
import { RenderFactCache } from "./render-fact-cache";
import { LayoutEvidence } from "./layout-evidence";
import type { ClipRenderAttemptAdapters, ClipRenderingWorkflowAttempt } from "./tasks/clip-render-attempt";
import { selectDurableLayoutEvidence } from "./tasks/clip-render-attempt";
import { createClipRenderAttempt } from "./tasks/clip-render-attempt-runtime";

/**
 * Reused layout evidence must be indistinguishable from a fresh analysis, and
 * must never be taken from inputs that have since changed. These tests render
 * one Clip through the real attempt, planner and compiler twice: once analyzing,
 * once reading the evidence the first render stored.
 */

const PROJECT_ID = "40000000-0000-4000-8000-000000000001";
const PREVIEW_KEY = "projects/test/previews/current.mp4";
const SOURCE_IDENTITY = compositionAssetRef("source", PROJECT_ID);

type PendingRender = NonNullable<
	Awaited<ReturnType<ClipRenderAttemptAdapters["state"]["getFrozenRenderingStateForWorkSet"]>>
>["pendingRenders"][number];
type LateEvidence = Awaited<ReturnType<ClipRenderAttemptAdapters["layoutEvidence"]["readCompatibleDurable"]>>;

const face = (cx: number) => ({ cx, cy: 0.3, w: 0.1, h: 0.2, score: 0.9 });
/** Two speakers whose faces drift, so a changed analysis would change the crop. */
const SAMPLES = Array.from({ length: 12 }, (_, index) => ({
	t: index * 0.8,
	faces: [face(0.28 + index * 0.004), face(0.7 - index * 0.003)],
}));

function createRender(input: {
	late?: LateEvidence | (() => Promise<LateEvidence>);
	frozenAnalysis?: unknown;
	clip?: Record<string, unknown>;
	facts?: RenderFactCache;
	sourceSizeBytes?: number | null;
	sourceMode?: "download" | "ranged";
	detectors?: "run" | "forbidden";
}) {
	const attempt: ClipRenderingWorkflowAttempt = {
		workflowRunId: "40000000-0000-4000-8000-000000000002",
		projectId: PROJECT_ID,
		stage: "clip_rendering",
		attemptId: "40000000-0000-4000-8000-000000000003",
		attemptCount: 1,
	};
	const renderId = "variant-reuse";
	const pendingRender = {
		id: renderId,
		clipId: "clip-reuse",
		aspectRatio: "ratio_9_16",
		resolution: "1080p",
		exportVariantId: null,
		exportVariant: null,
		clipSnapshot: null,
		clip: {
			id: "clip-reuse", index: 0, startSec: 2, endSec: 12, llmModel: "test",
			transcriptSlice: [], deletedRanges: null, captionPreset: null, studioEdits: null,
			wholeSource: false, editorDocumentVersion: 1, sceneBlocks: [], censorSegments: [],
			mediaMotions: [], brollCues: null, brollUrl: null, category: "other",
			editorRevision: 3, previewStorageKey: PREVIEW_KEY,
			autoLayoutAnalysis: input.frozenAnalysis ?? null, layoutAnalysis: null, splitLayoutAnalysis: null,
			...input.clip,
		},
	} as unknown as PendingRender;
	const commands: string[][] = [];
	const detections = { extraction: 0, multiFace: 0, scene: 0 };
	const persisted: unknown[] = [];
	const reads: Array<{ clipId: string; frozen: { editorRevision: number; previewStorageKey: string } }> = [];
	const probes: string[] = [];
	const diagnostics: Array<{ message: string; context?: Record<string, unknown> }> = [];
	const renderOutput = createRenderOutputFixture();
	const forbidden = input.detectors === "forbidden";
	const clipRenderAttempt = createClipRenderAttempt({
		run: { id: attempt.workflowRunId, projectId: PROJECT_ID, project: {
			title: "Evidence reuse", sourceStorageKey: "projects/test/source/input.mp4", sourceDurationSeconds: 20,
			workspaceId: "workspace",
		} },
		config: parseRenderConfig({ WORKER_RENDER_SOURCE_MODE: input.sourceMode ?? "download" }),
		lifecycle: {
			beginRenderWorkSet: async () => ({ variantIds: [renderId] }),
			settleRenderWorkSet: async () => ({ status: "completed", requested: 1, succeeded: 1, failed: 0, superseded: 0, followUpWorkflowRunId: null }),
		},
		adapters: {
			composition: { compileCommand: renderOutput.compileCommand },
			facts: input.facts ?? new RenderFactCache(),
			layoutEvidence: { readCompatibleDurable: async (clipId, frozen) => {
				reads.push({ clipId, frozen });
				return typeof input.late === "function" ? input.late() : (input.late ?? null);
			} },
			state: {
				getProjectRenderStorageReferences: async () => new Set<string>(),
				getFrozenRenderingStateForWorkSet: async () => ({
					sourceStorageKey: "projects/test/source/input.mp4",
					sourceSizeBytes: input.sourceSizeBytes === undefined ? null : input.sourceSizeBytes,
					sourceDurationSeconds: 20, workspaceId: "workspace", workspaceOwnerUserId: "owner",
					pricingTier: "creator", brandSnapshot: { status: "available", value: null }, pendingRenders: [pendingRender],
				}),
			},
			analysis: {
				extractFaceDetectionSegment: async ({ clipStartSec }) => {
					detections.extraction += 1;
					if (forbidden) throw new Error("extraction must not run");
					return { path: "/tmp/narriflow-evidence-reuse/segment.mp4", startSec: clipStartSec - clipStartSec };
				},
				detectMultiFacePath: async () => {
					detections.multiFace += 1;
					if (forbidden) throw new Error("detector must not run");
					return { samples: SAMPLES };
				},
				detectSceneCuts: async () => {
					detections.scene += 1;
					if (forbidden) throw new Error("scene detector must not run");
					return [];
				},
			},
			storage: {
				downloadObjectToFile: async () => {},
				presignDownloadUrl: async ({ key }) => `https://objects.example.test/${key}?signature=fresh`,
				putFileFromPath: async ({ key }) => ({ key }),
				deleteObject: async (key) => ({ key }),
			},
			workerProcess: {
				inspectMedia: async ({ sourcePath }) => {
					const output = renderOutput.inspect(sourcePath);
					if (output) return output;
					probes.push(sourcePath);
					return { durationSec: 20, width: 1920, height: 1080, hasVideo: true, hasVisualStream: true, hasAudio: true, fps: 30 };
				},
				execute: async ({ args }) => {
					const decoded = renderOutput.decode(args);
					if (decoded) return decoded;
					if (args.includes("-filter_complex") || args.includes("-map")) commands.push([...args]);
					return { exitCode: 0, stdout: Buffer.alloc(0) };
				},
				withScratchDirectory: async (_prefix, work) => work("/tmp/narriflow-evidence-reuse"),
			},
			clip: {
				markClipRenderVariantRendering: async () => true,
				completeClipRenderVariant: async () => ({ persisted: true }),
				failClipRenderVariant: async () => {},
				completeClipAutoLayoutAnalysis: async (_attempt, _clipId, analysis) => { persisted.push(analysis); return true; },
			},
			project: { reportProgress: async () => {} },
			workspace: { stat: async () => ({ size: 4096, isFile: () => true }) as never, writeFile: async () => {} },
			resource: { measure: () => ({ rssBytes: 1_024, scope: "worker_only" }) },
			diagnose: (event) => diagnostics.push(event),
		},
	});
	const context: WorkflowAttemptContext = { signal: new AbortController().signal, reportProgress: async () => {} };
	const resources = () => diagnostics.find((event) => event.message === "clip_composition_resources")!.context!;
	return { run: () => clipRenderAttempt.execute(attempt, context), commands, detections, persisted, reads, probes, diagnostics, resources };
}

/** What the database returns: stored JSON, never the in-memory object. */
const stored = <T>(value: T): T => JSON.parse(JSON.stringify(value));

async function analyzedRender() {
	const fresh = createRender({});
	expect((await fresh.run()).status).toBe("completed");
	expect(fresh.persisted).toHaveLength(1);
	return { fresh, evidence: stored(fresh.persisted[0]) as Record<string, unknown> };
}

describe("reusing durable layout evidence at group planning", () => {
	test("a render reading evidence a sibling group stored plans, compiles and encodes exactly like a fresh analysis", async () => {
		const { fresh, evidence } = await analyzedRender();
		expect(fresh.detections).toEqual({ extraction: 1, multiFace: 1, scene: 1 });
		expect(evidence.analysisPath).toBe("source");
		expect(fresh.resources()).toMatchObject({ detectorExecutionCount: 2, evidenceReused: [] });

		const reused = createRender({ late: { automatic: evidence, screen: null, split: null }, detectors: "forbidden" });
		expect((await reused.run()).status).toBe("completed");

		expect(reused.detections).toEqual({ extraction: 0, multiFace: 0, scene: 0 });
		expect(reused.persisted).toEqual([]);
		expect(reused.resources()).toMatchObject({ analysisExecutionCount: 0, detectorExecutionCount: 0, evidenceReused: ["automatic"] });
		expect(reused.commands).toHaveLength(1);
		expect(reused.commands).toEqual(fresh.commands);
		expect(reused.resources().planFingerprint).toBe(fresh.resources().planFingerprint);
		expect(reused.resources().commandBytes).toBe(fresh.resources().commandBytes);
		expect(reused.reads).toEqual([{ clipId: "clip-reuse", frozen: { editorRevision: 3, previewStorageKey: PREVIEW_KEY } }]);
	});

	test("evidence in the attempt-start snapshot is used as before and needs no refresh when nothing is missing", async () => {
		const { fresh, evidence } = await analyzedRender();
		const snapshot = createRender({ frozenAnalysis: evidence, detectors: "forbidden" });
		expect((await snapshot.run()).status).toBe("completed");
		expect(snapshot.commands).toEqual(fresh.commands);
		expect(snapshot.resources()).toMatchObject({ detectorExecutionCount: 0, evidenceReused: [] });
		// Screen and Split evidence are still absent, so one cheap read happens.
		expect(snapshot.reads).toHaveLength(1);

		const complete = selectDurableLayoutEvidence({ automatic: evidence, screen: { a: 1 }, split: { b: 2 } }, { automatic: null, screen: null, split: null });
		expect(complete).toEqual({ automatic: evidence, screen: { a: 1 }, split: { b: 2 } });
	});

	test("a render with no stored preview never reads or reuses evidence", async () => {
		const render = createRender({ clip: { previewStorageKey: null }, late: async () => { throw new Error("must not read"); } });
		expect((await render.run()).status).toBe("completed");
		expect(render.reads).toEqual([]);
		expect(render.detections.multiFace).toBe(1);
	});

	test("preview-proxy evidence and evidence without provenance are never adopted late; the render analyzes its own source", async () => {
		const { fresh, evidence } = await analyzedRender();
		for (const provenance of [{ analysisPath: "proxy" }, { analysisPath: undefined }]) {
			const render = createRender({ late: { automatic: stored({ ...evidence, ...provenance }), screen: null, split: null } });
			expect((await render.run()).status).toBe("completed");
			expect(render.detections).toEqual({ extraction: 1, multiFace: 1, scene: 1 });
			expect(render.resources().evidenceReused).toEqual([]);
			expect(render.commands).toEqual(fresh.commands);
		}
	});

	test("evidence for a changed window, source or deleted range cannot change the plan", async () => {
		const { fresh, evidence } = await analyzedRender();
		const staleVariants: Array<Record<string, unknown>> = [
			{ clipStartSec: 3, clipEndSec: 13 },
			{ clipEndSec: 11 },
			{ sourceIdentity: compositionAssetRef("source", "40000000-0000-4000-8000-0000000000ff") },
			{ deletedRanges: [{ startSec: 5, endSec: 6 }] },
			{ sourceWidth: 1280, sourceHeight: 720 },
		];
		for (const change of staleVariants) {
			const render = createRender({ late: { automatic: stored({ ...evidence, ...change }), screen: null, split: null } });
			expect((await render.run()).status).toBe("completed");
			expect(render.detections.multiFace).toBe(1);
			expect(render.commands).toEqual(fresh.commands);
		}
	});

	test("an unavailable refresh costs only the analysis it would have saved", async () => {
		const { fresh } = await analyzedRender();
		const render = createRender({ late: async () => { throw new Error("database unavailable"); } });
		expect((await render.run()).status).toBe("completed");
		expect(render.detections.multiFace).toBe(1);
		expect(render.commands).toEqual(fresh.commands);
		expect(render.diagnostics.some((event) => event.message === "layout_evidence_refresh_failed")).toBe(true);
	});

	test("evidence for another editor revision is withheld by the read itself", async () => {
		const render = createRender({ late: null, clip: { editorRevision: 9 } });
		expect((await render.run()).status).toBe("completed");
		expect(render.reads[0]!.frozen).toEqual({ editorRevision: 9, previewStorageKey: PREVIEW_KEY });
		expect(render.detections.multiFace).toBe(1);
	});

	test("late failure envelopes from infrastructure are not evidence", () => {
		const failure = { version: 1, engine: "screen-layout-v1", state: "failed", sourceIdentity: SOURCE_IDENTITY, reason: "analysis_unavailable", inputFingerprint: "0".repeat(16), analyzedAtISO: "2026-10-29T00:00:00.000Z" };
		const durable = selectDurableLayoutEvidence({ automatic: null, screen: null, split: null }, { automatic: null, screen: failure, split: null });
		const owner = new LayoutEvidence({
			source: { identity: SOURCE_IDENTITY, hasVideo: true, width: 1920, height: 1080 },
			clip: { id: "clip-reuse", startSec: 2, endSec: 12, deletedRanges: [], utterances: [], editorRevision: 3, previewStorageKey: PREVIEW_KEY },
			durable, enabled: { automatic: true, screen: true, split: true }, hasBroll: false, pipMotionThreshold: 0.02,
			signal: new AbortController().signal, getSegment: async () => null, sceneSource: { path: "/tmp/source.mp4", startSec: 2 },
		}, { detectors: {} as never, persist: async () => true, now: () => 0, rethrowControl: () => {}, diagnose: () => {} });
		expect(owner.availability.screenLayout.state).toBe("missing");
	});
});

describe("selecting durable evidence", () => {
	const source = { analysisPath: "source", id: "late" };
	const frozen = { automatic: null, screen: null, split: null };

	test("a snapshot value always wins over a later one", () => {
		const selected = selectDurableLayoutEvidence({ automatic: { id: "frozen" }, screen: { id: "frozen" }, split: { id: "frozen" } }, { automatic: source, screen: { id: "late" }, split: { id: "late" } });
		expect(selected).toEqual({ automatic: { id: "frozen" }, screen: { id: "frozen" }, split: { id: "frozen" } });
	});

	test("late Screen and Split evidence fills what the snapshot lacks; late Automatic needs render provenance", () => {
		expect(selectDurableLayoutEvidence(frozen, { automatic: source, screen: { id: "s" }, split: { id: "p" } })).toEqual({ automatic: source, screen: { id: "s" }, split: { id: "p" } });
		expect(selectDurableLayoutEvidence(frozen, { automatic: { analysisPath: "proxy" }, screen: null, split: null }).automatic).toBeNull();
		expect(selectDurableLayoutEvidence(frozen, { automatic: {}, screen: null, split: null }).automatic).toBeNull();
		expect(selectDurableLayoutEvidence(frozen, null)).toBe(frozen);
	});
});

describe("reusing the source probe", () => {
	test("a source object probed in ranged mode is probed once per immutable key and size, with a fresh signed URL each time", async () => {
		const facts = new RenderFactCache();
		const first = createRender({ facts, sourceMode: "ranged", sourceSizeBytes: 123_456 });
		expect((await first.run()).status).toBe("completed");
		expect(first.probes.filter((path) => path.startsWith("https://"))).toHaveLength(1);

		const second = createRender({ facts, sourceMode: "ranged", sourceSizeBytes: 123_456 });
		expect((await second.run()).status).toBe("completed");
		expect(second.probes.filter((path) => path.startsWith("https://"))).toEqual([]);
		expect(second.commands).toEqual(first.commands);
		expect(facts.stats().sourceProbe).toEqual({ hits: 1, misses: 1 });
	});

	test("a different size, or an unknown size, probes the source again", async () => {
		const facts = new RenderFactCache();
		await createRender({ facts, sourceMode: "ranged", sourceSizeBytes: 123_456 }).run();
		for (const size of [123_457, null]) {
			const render = createRender({ facts, sourceMode: "ranged", sourceSizeBytes: size });
			await render.run();
			expect(render.probes.filter((path) => path.startsWith("https://"))).toHaveLength(1);
		}
	});
});
