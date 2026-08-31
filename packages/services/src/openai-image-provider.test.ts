import { describe, expect, test } from "bun:test";

import {
	createOpenAiImageProvider,
	type GeneratedMediaProviderResultStore,
} from "./openai-image-provider";

function createResultStore(): GeneratedMediaProviderResultStore & {
	writes: Array<{ requestId: string; bytes: Uint8Array; contentType: string }>;
} {
	const values = new Map<string, { bytes: Uint8Array; contentType: string }>();
	return {
		writes: [],
		referenceFor(requestId) {
			return `provider-results/${requestId}.png`;
		},
		async put(input) {
			this.writes.push(input);
			const reference = `provider-results/${input.requestId}.png`;
			values.set(reference, {
				bytes: input.bytes,
				contentType: input.contentType,
			});
			return reference;
		},
		async get(reference) {
			const value = values.get(reference);
			if (!value) throw new Error("missing result");
			return value;
		},
	};
}

const submitInput = {
	requestId: "00000000-0000-4000-8000-000000000001",
	model: "deployment-selected-model",
	kind: "image" as const,
	prompt: "A restrained editorial photograph of a recording studio",
	aspectRatio: "9:16" as const,
	style: "editorial" as const,
	durationSec: null,
	seed: null,
};

describe("OpenAI image provider", () => {
	test("uses the configured model and durably stages base64 output", async () => {
		const resultStore = createResultStore();
		let requestBody: Record<string, unknown> | null = null;
		let requestHeaders = new Headers();
		const provider = createOpenAiImageProvider({
			apiKey: "configured-key",
			model: "deployment-selected-model",
			resultStore,
			fetchImpl: async (_input, init) => {
				requestBody = JSON.parse(String(init?.body));
				requestHeaders = new Headers(init?.headers);
				return new Response(
					JSON.stringify({
						data: [{ b64_json: Buffer.from([137, 80, 78, 71]).toString("base64") }],
					}),
					{ status: 200, headers: { "x-request-id": "openai-request-1" } },
				);
			},
		});

		const outcome = await provider.submit(submitInput);

		expect(requestBody).toMatchObject({
			model: "deployment-selected-model",
			size: "1024x1536",
			output_format: "png",
			n: 1,
		});
		expect(requestHeaders.get("x-client-request-id")).toBe(
			submitInput.requestId,
		);
		expect(outcome).toMatchObject({
			state: "completed",
			providerReference: "openai-request-1",
			resultReference: `provider-results/${submitInput.requestId}.png`,
			usage: { units: 1 },
		});
		expect(resultStore.writes).toHaveLength(1);
		if (outcome.state !== "completed") throw new Error("expected completion");
		expect(await provider.retrieve({
			resultReference: outcome.resultReference,
			model: submitInput.model,
			kind: "image",
		})).toEqual({
			kind: "inline",
			contentType: "image/png",
			bytes: new Uint8Array([137, 80, 78, 71]),
		});
	});

	test("normalizes provider safety blocks without leaking the provider message", async () => {
		const provider = createOpenAiImageProvider({
			apiKey: "configured-key",
			model: "deployment-selected-model",
			resultStore: createResultStore(),
			fetchImpl: async () =>
				new Response(
					JSON.stringify({
						error: {
							code: "moderation_blocked",
							message: "raw provider policy text",
							moderation_details: {
								stage: "input",
								categories: { violence: true, sexual: false },
							},
						},
					}),
					{ status: 400 },
				),
		});

		expect(await provider.submit(submitInput)).toEqual({
			state: "rejected",
			providerReference: null,
			errorCode: "generated_media_rejected",
			moderation: {
				outcome: "rejected",
				stage: "input",
				categories: ["violence"],
			},
		});
	});

	test("distinguishes safe rate-limit retry from an indeterminate server outcome", async () => {
		const resultStore = createResultStore();
		const rateLimited = createOpenAiImageProvider({
			apiKey: "configured-key",
			model: "deployment-selected-model",
			resultStore,
			fetchImpl: async () => new Response("{}", { status: 429 }),
		});
		const serverFailure = createOpenAiImageProvider({
			apiKey: "configured-key",
			model: "deployment-selected-model",
			resultStore,
			fetchImpl: async () => new Response("{}", { status: 503 }),
		});

		expect(await rateLimited.submit(submitInput)).toMatchObject({
			state: "failed",
			errorCode: "generated_media_rate_limited",
			retry: "safe",
		});
		expect(await serverFailure.submit(submitInput)).toMatchObject({
			state: "failed",
			errorCode: "generated_media_provider_unavailable",
			retry: "unknown",
		});
	});

	test("treats a transport timeout or lost response as indeterminate", async () => {
		const provider = createOpenAiImageProvider({
			apiKey: "configured-key",
			model: "deployment-selected-model",
			resultStore: createResultStore(),
			fetchImpl: async () => {
				throw new DOMException("request timed out", "TimeoutError");
			},
		});

		expect(await provider.submit(submitInput)).toMatchObject({
			state: "failed",
			errorCode: "generated_media_provider_timeout",
			retry: "unknown",
		});
	});

	test("normalizes request validation errors without exposing their body", async () => {
		const provider = createOpenAiImageProvider({
			apiKey: "configured-key",
			model: "deployment-selected-model",
			resultStore: createResultStore(),
			fetchImpl: async () =>
				new Response(
					JSON.stringify({ error: { message: "raw provider validation details" } }),
					{ status: 400 },
				),
		});

		expect(await provider.submit(submitInput)).toEqual({
			state: "failed",
			providerReference: null,
			errorCode: "generated_media_provider_validation_failed",
			retry: "terminal",
		});
	});

	test.each([
		["malformed", { data: [{ b64_json: "%%%" }] }],
		["missing", { data: [{}] }],
	])(
		"holds usage for a %s successful response that cannot be decoded",
		async (_label, body) => {
			const provider = createOpenAiImageProvider({
				apiKey: "configured-key",
				model: "deployment-selected-model",
				resultStore: createResultStore(),
				fetchImpl: async () =>
					new Response(JSON.stringify(body), {
						status: 200,
						headers: { "x-request-id": "openai-request-malformed" },
					}),
			});

			expect(await provider.submit(submitInput)).toEqual({
				state: "failed",
				providerReference: "openai-request-malformed",
				resultReference: `provider-results/${submitInput.requestId}.png`,
				moderation: { outcome: "passed" },
				usage: { units: 1 },
				errorCode: "generated_media_malformed_output",
				retry: "unknown",
			});
		},
	);

	test("holds usage when the result store returns a noncanonical reference", async () => {
		const resultStore = createResultStore();
		resultStore.put = async () => "provider-results/unexpected.png";
		const provider = createOpenAiImageProvider({
			apiKey: "configured-key",
			model: "deployment-selected-model",
			resultStore,
			fetchImpl: async () =>
				new Response(
					JSON.stringify({
						data: [
							{ b64_json: Buffer.from([137, 80, 78, 71]).toString("base64") },
						],
					}),
					{
						status: 200,
						headers: { "x-request-id": "openai-request-mismatch" },
					},
				),
		});

		expect(await provider.submit(submitInput)).toEqual({
			state: "failed",
			providerReference: "openai-request-mismatch",
			resultReference: `provider-results/${submitInput.requestId}.png`,
			moderation: { outcome: "passed" },
			usage: { units: 1 },
			errorCode: "generated_media_result_reference_invalid",
			retry: "unknown",
		});
	});

	test("holds usage when provider output succeeded but deterministic staging cannot be proven", async () => {
		const resultStore = createResultStore();
		resultStore.put = async () => {
			throw new Error("storage write and verification both unavailable");
		};
		const provider = createOpenAiImageProvider({
			apiKey: "configured-key",
			model: "deployment-selected-model",
			resultStore,
			fetchImpl: async () =>
				new Response(
					JSON.stringify({
						data: [
							{ b64_json: Buffer.from([137, 80, 78, 71]).toString("base64") },
						],
					}),
					{ status: 200, headers: { "x-request-id": "openai-request-staged" } },
				),
		});

		expect(await provider.submit(submitInput)).toEqual({
			state: "failed",
			providerReference: "openai-request-staged",
			resultReference: `provider-results/${submitInput.requestId}.png`,
			moderation: { outcome: "passed" },
			usage: { units: 1 },
			errorCode: "generated_media_result_staging_unknown",
			retry: "unknown",
		});
	});
});
