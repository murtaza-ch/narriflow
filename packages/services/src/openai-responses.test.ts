import { describe, expect, test } from "bun:test";
import { openAiResponseText, OpenAiResponsesError, requestOpenAiText } from "./openai-responses";

const call = (transport: typeof fetch) =>
	requestOpenAiText({ apiKey: "key", body: { model: "m" }, maxOutputTokens: 123, timeoutMs: 5_000, fetch: transport });
const failure = (promise: Promise<unknown>) => promise.catch((error) => error as OpenAiResponsesError);

describe("OpenAI Responses helper", () => {
	test("reads the flattened and the structured text forms", () => {
		expect(openAiResponseText({ output_text: "flat" })).toBe("flat");
		expect(openAiResponseText({ output: [{ content: [{ text: "a" }, { refusal: "x" }] }, { content: [{ text: "b" }] }] })).toBe("ab");
		expect(openAiResponseText({ output: [] })).toBeNull();
		expect(openAiResponseText(null)).toBeNull();
	});

	test("bounds the request in time and output", async () => {
		let init: RequestInit | undefined;
		const text = await call((async (_url, options) => {
			init = options;
			return Response.json({ output_text: "ok" });
		}) as typeof fetch);
		expect(text).toBe("ok");
		expect(JSON.parse(String(init?.body))).toMatchObject({ model: "m", max_output_tokens: 123 });
		expect(init?.signal).toBeInstanceOf(AbortSignal);
	});

	test.each([
		[429, "openai_rate_limited"],
		[500, "openai_unavailable"],
		[503, "openai_unavailable"],
		[400, "openai_rejected"],
		[401, "openai_rejected"],
	])("maps HTTP %d to %s", async (status, code) => {
		const error = await failure(call((async () => new Response("{}", { status })) as typeof fetch));
		expect(error).toBeInstanceOf(OpenAiResponsesError);
		expect(error).toMatchObject({ code, status });
	});

	test("maps a network failure, an incomplete answer and an empty answer", async () => {
		expect(await failure(call((async () => { throw new Error("socket closed"); }) as typeof fetch))).toMatchObject({ code: "openai_unavailable" });
		expect(await failure(call((async () => Response.json({ status: "incomplete", output_text: "{\"par" })) as typeof fetch))).toMatchObject({ code: "openai_incomplete" });
		expect(await failure(call((async () => Response.json({ output: [] })) as typeof fetch))).toMatchObject({ code: "openai_empty" });
		expect(await failure(call((async () => new Response("<html>", { status: 200 })) as typeof fetch))).toMatchObject({ code: "openai_unavailable" });
	});
});
