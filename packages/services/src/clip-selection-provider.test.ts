import { expect, test } from "bun:test";
import { createClipSelectionProvider } from "./clip-selection-provider";

const now = new Date("2026-10-31T00:00:00Z"), deadline = new Date("2026-10-31T00:10:00Z");
const config = { apiKey: "test-secret", model: "gpt-5.4-mini", reasoningEffort: "medium", maxOutputTokens: 32_000, now: () => now };

test("selection retains the Responses structured-output contract in one bounded request", async () => {
  let requests = 0;
  const provider = createClipSelectionProvider({ ...config, fetch: async (url, init) => {
    requests++;
    expect(String(url)).toBe("https://api.openai.com/v1/responses");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-secret");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: "gpt-5.4-mini", input: [{ role: "system", content: "system" }, { role: "user", content: "user" }],
      reasoning: { effort: "medium" }, text: { format: { type: "json_schema", name: "clip_detection", strict: true,
        schema: { type: "object", additionalProperties: false, required: ["clips"] } } }, max_output_tokens: 32_000 });
    expect(body.text.format.schema.properties.clips.items.required).toContain("broll_cues");
    return Response.json({ status: "completed", output: [{ content: [{ type: "output_text", text: '{"clips":[]}' }] }], usage: { total_tokens: 135 } },
      { headers: { "x-request-id": "request-1", "x-ratelimit-remaining-requests": "4" } });
  } });
  expect(await provider.generate({ systemPrompt: "system", userPrompt: "user", operationDeadlineAt: deadline })).toMatchObject({ kind: "completed", content: '{"clips":[]}', tokensUsed: 135,
    providerRequestId: "request-1", rateLimitHeaders: { "x-ratelimit-remaining-requests": "4" } });
  expect(requests).toBe(1);
});

test("429 returns explicit Retry-After without a second HTTP request and cannot park beyond the window deadline", async () => {
  for (const [retryAfter, expected] of [["91", "2026-10-31T00:01:31Z"], ["Sat, 31 Oct 2026 00:04:00 GMT", "2026-10-31T00:04:00Z"], ["9999", "2026-10-31T00:10:00Z"]]) {
    let requests = 0;
    const provider = createClipSelectionProvider({ ...config, fetch: async () => { requests++; return Response.json({ error: { code: "rate_limit_exceeded" } }, { status: 429, headers: { "retry-after": retryAfter! } }); } });
    expect(await provider.generate({ systemPrompt: "s", userPrompt: "u", operationDeadlineAt: deadline })).toMatchObject({ kind: "retry", dueAt: new Date(expected!), code: "openai_request_failed" });
    expect(requests).toBe(1);
  }
});

test("quota exhaustion stays permanent and truncated output retains its distinct failure", async () => {
  const quota = createClipSelectionProvider({ ...config, fetch: async () => Response.json({ error: { code: "credit_balance_exhausted" } }, { status: 429 }) });
  await expect(quota.generate({ systemPrompt: "s", userPrompt: "u", operationDeadlineAt: deadline })).rejects.toMatchObject({ code: "openai_quota_exhausted", disposition: "permanent" });
  const truncated = createClipSelectionProvider({ ...config, fetch: async () => Response.json({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }) });
  await expect(truncated.generate({ systemPrompt: "s", userPrompt: "u", operationDeadlineAt: deadline })).rejects.toMatchObject({ code: "clip_detection_truncated" });
});

test("an expired window sends no request, and transport ambiguity is left to the bounded domain retry", async () => {
  let requests = 0;
  const provider = createClipSelectionProvider({ ...config, fetch: async () => { requests++; throw new TypeError("socket closed"); } });
  await expect(provider.generate({ systemPrompt: "s", userPrompt: "u", operationDeadlineAt: now })).rejects.toMatchObject({ code: "operation_deadline_exceeded" });
  expect(requests).toBe(0);
  expect(await provider.generate({ systemPrompt: "s", userPrompt: "u", operationDeadlineAt: deadline })).toMatchObject({ kind: "retry", dueAt: new Date("2026-10-31T00:00:30Z") });
  expect(requests).toBe(1);
});
