import { readResponseBodyBounded } from "./url-guard";
import type { GeneratedMediaAspectRatio } from "@narriflow/validators";
import type {
	GeneratedMediaProvider,
	GeneratedMediaProviderOutcome,
	GeneratedMediaProviderSource,
} from "./generated-media";

export interface GeneratedMediaProviderResultStore {
	referenceFor(requestId: string): string;
	put(input: {
		requestId: string;
		bytes: Uint8Array;
		contentType: string;
		signal?: AbortSignal;
	}): Promise<string>;
	get(
		reference: string,
		signal?: AbortSignal,
	): Promise<{ bytes: Uint8Array; contentType: string }>;
}

type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

const OPENAI_IMAGE_SIZES: Readonly<
	Partial<Record<GeneratedMediaAspectRatio, string>>
> = {
	"9:16": "1024x1536",
	"1:1": "1024x1024",
	"16:9": "1536x1024",
};

type OpenAiErrorBody = {
	error?: {
		code?: unknown;
		moderation_details?: {
			stage?: unknown;
			categories?: Record<string, unknown>;
		};
	};
};

async function readJson(response: Response, maxBytes: number): Promise<unknown> {
	const bytes = await readResponseBodyBounded(response, maxBytes);
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return null;
	}
}

function moderationRejection(body: OpenAiErrorBody) {
	if (body.error?.code !== "moderation_blocked") return null;
	const details = body.error.moderation_details;
	const stage: "input" | "output" | "unknown" =
		details?.stage === "input" || details?.stage === "output"
			? details.stage
			: "unknown";
	const categories = Object.entries(details?.categories ?? {})
		.filter(([, blocked]) => blocked === true)
		.map(([category]) => category)
		.sort();
	return {
		state: "rejected" as const,
		providerReference: null,
		errorCode: "generated_media_rejected" as const,
		moderation: {
			outcome: "rejected" as const,
			stage,
			...(categories.length > 0 ? { categories } : {}),
		},
	};
}

function failed(
	errorCode: string,
	retry: "safe" | "terminal" | "unknown",
): GeneratedMediaProviderOutcome {
	return { state: "failed", providerReference: null, errorCode, retry };
}

function successfulOutcomeUncertain(input: {
	errorCode: string;
	providerReference: string | null;
	resultReference: string;
}): GeneratedMediaProviderOutcome {
	return {
		state: "failed",
		providerReference: input.providerReference,
		resultReference: input.resultReference,
		moderation: { outcome: "passed" },
		usage: { units: 1 },
		errorCode: input.errorCode,
		retry: "unknown",
	};
}

function decodeBase64(value: unknown): Uint8Array | null {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length % 4 !== 0 ||
		!/^[A-Za-z0-9+/]*={0,2}$/.test(value)
	) {
		return null;
	}
	const bytes = Buffer.from(value, "base64");
	return bytes.byteLength > 0 ? bytes : null;
}

export function createOpenAiImageProvider(input: {
	apiKey: string;
	model: string;
	resultStore: GeneratedMediaProviderResultStore;
	fetchImpl?: FetchLike;
	baseUrl?: string;
	timeoutMs?: number;
	maxResponseBytes?: number;
}): GeneratedMediaProvider {
	const apiKey = input.apiKey.trim();
	const configuredModel = input.model.trim();
	if (!apiKey) throw new Error("OPENAI_API_KEY is required");
	if (!configuredModel) throw new Error("OPENAI_IMAGE_MODEL is required");
	const fetchImpl = input.fetchImpl ?? fetch;
	const timeoutMs = input.timeoutMs ?? 120_000;
	const maxResponseBytes = input.maxResponseBytes ?? 32 * 1024 * 1024;

	return {
		alias: "openai-image",
		async submit(request) {
			if (request.kind !== "image" || request.model !== configuredModel) {
				return failed("generated_media_provider_configuration_mismatch", "terminal");
			}
			const size = OPENAI_IMAGE_SIZES[request.aspectRatio];
			if (!size) {
				return failed("generated_media_aspect_ratio_unsupported", "terminal");
			}
			const requestSignal = AbortSignal.timeout(timeoutMs);
			const signal = request.signal
				? AbortSignal.any([request.signal, requestSignal])
				: requestSignal;
			let response: Response;
			try {
				response = await fetchImpl(
					new URL("/v1/images/generations", input.baseUrl ?? "https://api.openai.com"),
					{
						method: "POST",
						headers: {
							authorization: `Bearer ${apiKey}`,
							"content-type": "application/json",
							"x-client-request-id": request.requestId,
						},
						body: JSON.stringify({
							model: configuredModel,
							prompt: `Style direction: ${request.style}.\n\n${request.prompt}`,
							size,
							output_format: "png",
							n: 1,
						}),
						signal,
					},
				);
			} catch {
				// A transport failure after dispatch cannot prove whether generation ran.
				return failed("generated_media_provider_timeout", "unknown");
			}

			const providerReference = response.headers.get("x-request-id");
			const body = (await readJson(response, maxResponseBytes)) as
				| (OpenAiErrorBody & { data?: Array<{ b64_json?: unknown }> })
				| null;
			if (!response.ok) {
				const rejection = moderationRejection(body ?? {});
				if (rejection) return rejection;
				if (response.status === 429) {
					return failed("generated_media_rate_limited", "safe");
				}
				if (response.status === 408 || response.status === 409) {
					return failed("generated_media_provider_retryable", "safe");
				}
				if (response.status >= 500) {
					return failed("generated_media_provider_unavailable", "unknown");
				}
				return failed("generated_media_provider_validation_failed", "terminal");
			}

			const resultReference = input.resultStore.referenceFor(request.requestId);
			const bytes = decodeBase64(body?.data?.[0]?.b64_json);
			if (!bytes) {
				return successfulOutcomeUncertain({
					errorCode: "generated_media_malformed_output",
					providerReference,
					resultReference,
				});
			}
			try {
				const storedReference = await input.resultStore.put({
					requestId: request.requestId,
					bytes,
					contentType: "image/png",
					signal: request.signal,
				});
				if (storedReference !== resultReference) {
					return successfulOutcomeUncertain({
						errorCode: "generated_media_result_reference_invalid",
						providerReference,
						resultReference,
					});
				}
			} catch {
				return {
					state: "failed",
					providerReference,
					resultReference,
					moderation: { outcome: "passed" },
					usage: { units: 1 },
					errorCode: "generated_media_result_staging_unknown",
					retry: "unknown",
				};
			}
			return {
				state: "completed",
				providerReference,
				resultReference,
				moderation: { outcome: "passed" },
				usage: { units: 1 },
			};
		},
		async poll() {
			return failed("generated_media_poll_unsupported", "terminal");
		},
		async cancel() {
			return { state: "unsupported" };
		},
		async retrieve(request) {
			if (request.kind !== "image" || request.model !== configuredModel) {
				throw new Error("OpenAI image result configuration mismatch");
			}
			const result = await input.resultStore.get(
				request.resultReference,
				request.signal,
			);
			if (
				result.contentType !== "image/png" &&
				result.contentType !== "image/jpeg" &&
				result.contentType !== "image/webp"
			) {
				throw new Error("OpenAI image result has an unsupported content type");
			}
			return {
				kind: "inline",
				contentType: result.contentType,
				bytes: result.bytes,
			} satisfies GeneratedMediaProviderSource;
		},
	};
}
