/** One way to call and read the OpenAI Responses API for single-shot text
 * generation. Every call is bounded in time and output, and failures carry a
 * stable code so callers can tell a busy provider from a broken one. */

const RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";

/** The text of a Responses payload: the flattened `output_text`, else the
 * `output[].content[].text` parts joined. */
export function openAiResponseText(payload: unknown): string | null {
	const response = payload as {
		output_text?: unknown;
		output?: Array<{ content?: Array<{ text?: unknown }> }>;
	} | null;
	if (typeof response?.output_text === "string") return response.output_text;
	const parts =
		response?.output
			?.flatMap((item) => item.content ?? [])
			.map((content) => content.text)
			.filter((text): text is string => typeof text === "string") ?? [];
	return parts.length > 0 ? parts.join("") : null;
}

export type OpenAiResponsesFailureCode =
	| "openai_rate_limited"
	| "openai_unavailable"
	| "openai_rejected"
	| "openai_incomplete"
	| "openai_empty";

export class OpenAiResponsesError extends Error {
	constructor(
		readonly code: OpenAiResponsesFailureCode,
		readonly status?: number,
	) {
		super(code);
		this.name = "OpenAiResponsesError";
	}
}

/** Posts one Responses request and returns its text. `body` is the request
 * minus `max_output_tokens`, which is required here so no call is unbounded. */
export async function requestOpenAiText(options: {
	apiKey: string;
	body: Record<string, unknown>;
	maxOutputTokens: number;
	timeoutMs: number;
	fetch?: typeof fetch;
}): Promise<string> {
	let response: Response;
	try {
		response = await (options.fetch ?? fetch)(RESPONSES_ENDPOINT, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${options.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				...options.body,
				max_output_tokens: options.maxOutputTokens,
			}),
			signal: AbortSignal.timeout(options.timeoutMs),
		});
	} catch {
		throw new OpenAiResponsesError("openai_unavailable");
	}
	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		throw new OpenAiResponsesError(
			response.status === 429
				? "openai_rate_limited"
				: response.status >= 500 || response.status === 408
					? "openai_unavailable"
					: "openai_rejected",
			response.status,
		);
	}
	let payload: { status?: unknown } | null;
	try {
		payload = (await response.json()) as { status?: unknown } | null;
	} catch {
		// A cut-off body or a timeout while reading it.
		throw new OpenAiResponsesError("openai_unavailable");
	}
	if (payload?.status === "incomplete")
		throw new OpenAiResponsesError("openai_incomplete");
	const text = openAiResponseText(payload);
	if (!text) throw new OpenAiResponsesError("openai_empty");
	return text;
}
