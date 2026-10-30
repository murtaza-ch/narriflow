import { describe, expect, test } from "bun:test";
import { createClipsClient } from "@narriflow/api-client/clips";
import { createIntent } from "@narriflow/api-client";
import {
	deriveRenderStatus,
	renderFailureHeadline,
	renderFailureMessage,
	renderFailureNeedsNewSource,
	retryFailedRenders,
} from "./render-status";

const json = (body: unknown, status: number) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A fetch double that records each request and answers from a queue. */
function fakeFetch(...answers: Array<() => Response>) {
	const calls: Array<{ url: string; init: RequestInit; headers: Headers }> = [];
	const fetchDouble = async (input: unknown, init: RequestInit = {}) => {
		calls.push({ url: String(input), init, headers: new Headers(init.headers) });
		const answer = answers[calls.length - 1] ?? answers.at(-1);
		if (!answer) throw new Error("no answer queued");
		return answer();
	};
	return { fetch: fetchDouble as unknown as typeof fetch, calls };
}

describe("render failure copy", () => {
	test("a mapped code uses its own copy and an unmapped render code still says what failed", () => {
		expect(renderFailureMessage("ffmpeg_render_failed")).toBe("A clip failed to render. Try rendering it again.");
		expect(renderFailureMessage("scratch_unlink_failed")).toBe("A clip failed to render. Try rendering it again.");
		expect(renderFailureMessage("source_unavailable")).not.toContain("Something went wrong");
		expect(renderFailureMessage("hdr_dolby_vision_unsupported")).toBe(
			"This video uses a Dolby Vision format we can't convert yet. Export it from your camera or editor as standard HDR or SDR and upload again.",
		);
		expect(renderFailureNeedsNewSource("hdr_dolby_vision_unsupported")).toBe(true);
		expect(renderFailureNeedsNewSource("ffmpeg_render_failed")).toBe(false);
		expect(renderFailureNeedsNewSource(null)).toBe(false);
		expect(renderFailureHeadline(1)).toBe("1 render failed");
		expect(renderFailureHeadline(3)).toBe("3 renders failed");
	});
});

describe("Retry failed renders", () => {
	const PROJECT = "40000000-0000-4000-8000-000000000001";
	const [A, B, C] = [1, 2, 3].map((n) => `40000000-0000-4000-8000-00000000010${n}`) as [string, string, string];
	const variant = (aspectRatio: "9:16" | "1:1", status: string) => ({
		aspectRatio,
		resolution: "720p" as const,
		status,
		errorCode: status === "failed" ? "ffmpeg_render_failed" : null,
	});

	test("re-queues exactly the failed variants, one request per format, each with its own key", async () => {
		const status = deriveRenderStatus([
			{ id: A, renderVariants: [variant("9:16", "failed"), variant("1:1", "completed")] },
			{ id: B, renderVariants: [variant("9:16", "failed")] },
			{ id: C, renderVariants: [variant("1:1", "failed")] },
		]);
		const recorded = fakeFetch(
			() => json({ workflowRunId: "w1", acceptedAt: "2026-10-30T00:00:00.000Z", initialSeq: 0 }, 202),
			() => json({ workflowRunId: "w2", acceptedAt: "2026-10-30T00:00:00.000Z", initialSeq: 1 }, 202),
		);
		const clips = createClipsClient({
			baseUrl: "https://api.example.test",
			fetch: (input, init) => recorded.fetch(input as string, init),
		});
		let n = 0;
		const intents = new Map();
		await retryFailedRenders({
			clips,
			projectId: PROJECT,
			groups: status.groups,
			intents,
			createIntent: () => createIntent({ randomUUID: () => `key-${++n}` }),
		});
		expect(recorded.calls.map((call) => call.url)).toEqual([
			`https://api.example.test/api/projects/${PROJECT}/clips/render`,
			`https://api.example.test/api/projects/${PROJECT}/clips/render`,
		]);
		expect(recorded.calls.map((call) => JSON.parse(String(call.init.body)))).toEqual([
			{ clipIds: [A, B], aspectRatios: ["9:16"], resolution: "720p" },
			{ clipIds: [C], aspectRatios: ["1:1"], resolution: "720p" },
		]);
		expect(recorded.calls.map((call) => call.headers.get("idempotency-key"))).toEqual(["key-1", "key-2"]);
		expect(intents.size).toBe(0);
	});

	test("a refused group keeps its intent, so pressing Retry again replays the same key", async () => {
		const status = deriveRenderStatus([{ id: A, renderVariants: [variant("9:16", "failed")] }]);
		const recorded = fakeFetch(
			() => {
				throw new Error("lost response"); // the transport raises ApiError on a refusal or lost response
			},
			() => json({ workflowRunId: "w1", acceptedAt: "2026-10-30T00:00:00.000Z", initialSeq: 0 }, 202),
		);
		const clips = createClipsClient({
			baseUrl: "https://api.example.test",
			fetch: (input, init) => recorded.fetch(input as string, init),
		});
		const intents = new Map();
		let n = 0;
		const args = { clips, projectId: PROJECT, groups: status.groups, intents, createIntent: () => createIntent({ randomUUID: () => `key-${++n}` }) };
		await retryFailedRenders(args).catch(() => undefined);
		await retryFailedRenders(args);
		expect(recorded.calls.map((call) => call.headers.get("idempotency-key"))).toEqual(["key-1", "key-1"]);
	});
});
